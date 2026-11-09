import OBSWebSocket, { EventSubscription } from "obs-websocket-js";
import type { ObsSettings, ObsStatus } from "@kmc/shared-types";

export interface ObsLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

type ObsEvent = "obs.state.changed" | "obs.scene.switched";

export interface ObsDeps {
  log: ObsLogger;
  getSettings: () => { obs: ObsSettings };
  emit: (type: ObsEvent, data?: Record<string, unknown>) => void;
}

const RECONNECT_MS = 5000;

/**
 * Controle remoto do OBS Studio via obs-websocket (OBS 28+). Mantém um cache do
 * estado (cenas, cena atual, câmera virtual), reconecta com atraso quando a
 * conexão cai, e NUNCA derruba o servidor: toda falha vira `lastError`.
 *
 * Não conecta no construtor — só em `start()` — para que testes que criam o
 * contexto não tentem abrir uma conexão de rede.
 */
export class ObsService {
  private obs: OBSWebSocket | null = null;
  private connected = false;
  private currentScene: string | null = null;
  private scenes: string[] = [];
  private virtualCam: boolean | null = null;
  private lastError: string | null = null;
  private updatedAt = new Date().toISOString();
  private configKey = "";
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private started = false;
  private disposed = false;

  constructor(private readonly deps: ObsDeps) {}

  private get cfg(): ObsSettings {
    return this.deps.getSettings().obs;
  }

  /** Começa a aplicar as configurações (conecta se a integração estiver ligada). */
  start(): void {
    this.started = true;
    this.applySettings();
  }

  getStatus(): ObsStatus {
    return {
      enabled: this.cfg.enabled,
      connected: this.connected,
      currentScene: this.connected ? this.currentScene : null,
      scenes: this.connected ? this.scenes : [],
      virtualCam: this.connected ? this.virtualCam : null,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  private touch(emit: ObsEvent = "obs.state.changed", data?: Record<string, unknown>): void {
    this.updatedAt = new Date().toISOString();
    this.deps.emit(emit, data);
  }

  /** Reage a mudança de configuração: (re)conecta, desconecta ou troca de alvo. */
  applySettings(): void {
    if (!this.started || this.disposed) return;
    const obs = this.cfg;
    const key = JSON.stringify([obs.enabled, obs.url, obs.password]);
    if (key === this.configKey) return;
    this.configKey = key;
    void this.disconnect();
    if (obs.enabled) this.scheduleConnect(0);
  }

  /** Força nova tentativa de conexão agora (botão "Reconectar"). */
  reconnect(): void {
    this.lastError = null;
    void this.disconnect();
    if (this.cfg.enabled) this.scheduleConnect(0);
  }

  private scheduleConnect(delay = RECONNECT_MS): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.connecting || this.connected) return;
    const obs = this.cfg;
    if (!obs.enabled) return;
    this.connecting = true;
    const client = new OBSWebSocket();
    try {
      await client.connect(obs.url, obs.password || undefined, {
        eventSubscriptions:
          EventSubscription.General | EventSubscription.Scenes | EventSubscription.Outputs,
        rpcVersion: 1,
      });
      this.obs = client;
      this.connected = true;
      this.lastError = null;
      this.wire(client);
      await this.refresh();
      this.deps.log.info({ url: obs.url }, "OBS conectado");
      this.touch();
    } catch (err) {
      this.lastError = humanError(err);
      this.deps.log.warn({ err: this.lastError }, "OBS: falha ao conectar");
      try {
        await client.disconnect();
      } catch {
        /* ignore */
      }
      this.touch();
      if (this.cfg.enabled) this.scheduleConnect();
    } finally {
      this.connecting = false;
    }
  }

  private wire(client: OBSWebSocket): void {
    client.on("CurrentProgramSceneChanged", (d: { sceneName: string }) => {
      this.currentScene = d.sceneName;
      this.touch();
    });
    client.on("SceneListChanged", () => {
      void this.refreshScenes();
    });
    client.on("VirtualcamStateChanged", (d: { outputActive: boolean }) => {
      this.virtualCam = d.outputActive;
      this.touch();
    });
    client.on("ConnectionClosed", () => {
      if (this.obs !== client) return;
      this.connected = false;
      this.obs = null;
      this.touch();
      if (this.cfg.enabled) this.scheduleConnect();
    });
    client.on("ConnectionError", (err: unknown) => {
      this.lastError = humanError(err);
    });
  }

  private async refresh(): Promise<void> {
    if (!this.obs) return;
    await this.refreshScenes();
    try {
      const vc = await this.obs.call("GetVirtualCamStatus");
      this.virtualCam = Boolean((vc as { outputActive?: boolean }).outputActive);
    } catch {
      this.virtualCam = null;
    }
  }

  private async refreshScenes(): Promise<void> {
    if (!this.obs) return;
    try {
      const list = await this.obs.call("GetSceneList");
      // O OBS entrega a lista de baixo para cima; invertido fica igual à UI do OBS.
      this.scenes = (list.scenes ?? [])
        .map((s) => String((s as { sceneName?: unknown }).sceneName ?? ""))
        .filter(Boolean)
        .reverse();
      if (list.currentProgramSceneName) this.currentScene = list.currentProgramSceneName;
      this.touch();
    } catch (err) {
      this.deps.log.warn({ err: humanError(err) }, "OBS: falha ao listar cenas");
    }
  }

  /** Troca a cena de programa do OBS. Lança se não estiver conectado. */
  async setScene(name: string): Promise<void> {
    if (!this.obs || !this.connected) throw new Error("OBS não está conectado");
    await this.obs.call("SetCurrentProgramScene", { sceneName: name });
    this.currentScene = name;
    this.touch("obs.scene.switched", { scene: name });
  }

  private async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.obs;
    this.obs = null;
    this.connected = false;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    await this.disconnect();
  }
}

function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 200);
}
