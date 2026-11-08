import type { Db } from "./db.js";
import { MAPASJW_AUTH_KEY, MAPASJW_KV_KEY, normalizeBaseUrl, resolveMapasJwConfig } from "./mapasjwConfig.js";

/**
 * Pareamento OPCIONAL com o Mapas JW: o KMC SOLICITA, um gestor APROVA lá
 * conferindo o código, e o KMC busca o token e o guarda.
 *
 * - O token é entregue UMA ÚNICA VEZ: ao recebê-lo, é gravado antes de qualquer
 *   outra coisa. Se for perdido, o pareamento tem de ser refeito.
 * - A congregação é resolvida pelo slug (na solicitação) e pelo token (depois).
 *   O KMC nunca manda id de congregação.
 * - Sem solicitação pendente este módulo não faz nenhuma requisição de rede.
 */

export const PAIRING_KV_KEY = "mapasjw.pairing";
export const REQUEST_PATH = "/api/kmc/instancias/solicitar";
export const POLL_MS = 5_000;
export const POLL_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export type PairingEstado = "nenhum" | "pendente" | "expirada" | "recusada" | "perdida" | "erro";

/** Registro persistido (kv `mapasjw.pairing`). O segredo só existe enquanto pendente. */
interface PairingRecord {
  baseUrl: string;
  solicitacaoId: number;
  codigo: string;
  segredo: string;
  expiraEm: string;
  nome: string;
  slug: string;
  estado: Exclude<PairingEstado, "nenhum">;
  mensagem?: string;
}

export interface PairingStatus {
  estado: PairingEstado;
  solicitacaoId?: number;
  /** Só enquanto pendente. */
  codigo?: string | null;
  expiraEm?: string;
  nome?: string;
  slug?: string;
  mensagem?: string | null;
  ultimaConsultaEm?: string | null;
  erroTransitorio?: string | null;
}

/** Erro com código estável para as rotas mapearem em HTTP. */
export class PairingError extends Error {
  constructor(
    readonly code: "invalid_input" | "pending_exists" | "congregation_unavailable" | "rate_limited" | "upstream",
    message: string,
  ) {
    super(message);
  }
}

export interface PairingLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface PairingDeps {
  db: Db;
  logger: PairingLogger;
  appVersion: string;
  /** Chamado depois que o token foi gravado (ex.: reenviar a assistência de hoje). */
  onPaired?: () => void;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pollMs?: number;
  timeoutMs?: number;
}

export class MapasJwPairing {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inFlight = false;
  private failures = 0;
  private lastCheckAt: string | null = null;
  private lastTransientError: string | null = null;

  constructor(private readonly d: PairingDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  private load(): PairingRecord | null {
    try {
      const raw = this.d.db.getKv(PAIRING_KV_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw) as Partial<PairingRecord>;
      if (typeof o.baseUrl !== "string" || typeof o.solicitacaoId !== "number" || typeof o.expiraEm !== "string") return null;
      return {
        baseUrl: o.baseUrl, solicitacaoId: o.solicitacaoId, codigo: String(o.codigo ?? ""),
        segredo: String(o.segredo ?? ""), expiraEm: o.expiraEm, nome: String(o.nome ?? ""), slug: String(o.slug ?? ""),
        estado: o.estado ?? "pendente", ...(o.mensagem ? { mensagem: o.mensagem } : {}),
      };
    } catch { return null; }
  }

  private save(r: PairingRecord): void { this.d.db.setKv(PAIRING_KV_KEY, JSON.stringify(r)); }

  private isExpired(r: PairingRecord): boolean {
    const t = Date.parse(r.expiraEm);
    return !Number.isFinite(t) || t <= this.now().getTime();
  }

  /** Fecha a solicitação num estado final, descartando o segredo. */
  private finish(r: PairingRecord, estado: Exclude<PairingEstado, "nenhum" | "pendente">, mensagem: string): void {
    this.save({ ...r, segredo: "", estado, mensagem });
    this.d.logger.info({}, `Pareamento com o Mapas JW encerrado: ${estado}`);
  }

  /** Ciclo de vida: retoma a consulta se havia solicitação pendente antes de reiniciar. */
  start(): void {
    this.stopped = false;
    const r = this.load();
    if (r?.estado === "pendente") this.schedule(this.d.pollMs ?? POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), Math.max(0, delayMs));
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    this.timer = null;
    try { await this.consultar(); }
    catch (err) { this.d.logger.warn({}, `Falha inesperada na consulta do pareamento: ${String(err)}`); this.failures++; }
    const r = this.load();
    if (r?.estado !== "pendente") return; // aprovada, encerrada ou cancelada: para de consultar
    const base = this.d.pollMs ?? POLL_MS;
    this.schedule(Math.min(base * 2 ** Math.min(this.failures, 6), Math.max(base, POLL_MAX_MS)));
  }

  /** Solicita o pareamento. O código devolvido deve ser conferido pelo gestor no Mapas JW. */
  async solicitar(baseUrlRaw: unknown, nomeRaw: unknown, slugRaw: unknown):
    Promise<{ solicitacaoId: number; codigo: string; expiraEm: string }> {
    const baseUrl = normalizeBaseUrl(baseUrlRaw);
    if (!baseUrl) throw new PairingError("invalid_input", "Informe o endereço do Mapas JW (https).");
    const nome = typeof nomeRaw === "string" ? nomeRaw.trim().replace(/\s+/g, " ") : "";
    if (!nome || nome.length > 80) throw new PairingError("invalid_input", "Informe um nome para esta instalação (até 80 caracteres).");
    const slug = typeof slugRaw === "string" ? slugRaw.trim().toLowerCase() : "";
    if (!SLUG_RE.test(slug)) throw new PairingError("invalid_input", "Informe o identificador (slug) da congregação: letras minúsculas, números e hífen.");

    const current = this.load();
    if (current?.estado === "pendente" && !this.isExpired(current)) {
      throw new PairingError("pending_exists", "Já existe uma solicitação pendente. Cancele-a antes de pedir outra.");
    }

    const doFetch = this.d.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${REQUEST_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ nome, congregacao: slug, versao_kmc: this.d.appVersion }),
        redirect: "manual",
        signal: AbortSignal.timeout(this.d.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      throw new PairingError("upstream", name === "TimeoutError" || name === "AbortError"
        ? "O Mapas JW não respondeu a tempo. Confira o endereço e tente de novo."
        : "Não foi possível falar com o Mapas JW. Confira o endereço e a conexão.");
    }
    let body: Record<string, unknown> | null = null;
    try { body = (await res.json()) as Record<string, unknown>; } catch { /* corpo não-JSON */ }

    if (res.status === 422) {
      throw new PairingError("congregation_unavailable", "Congregação não encontrada ou indisponível no Mapas JW. Confira o identificador (slug).");
    }
    if (res.status === 429) {
      throw new PairingError("rate_limited", "Muitas solicitações ao Mapas JW. Aguarde alguns minutos antes de tentar de novo.");
    }
    const id = body?.solicitacao_id, codigo = body?.codigo, segredo = body?.segredo, expiraEm = body?.expira_em;
    if (res.status !== 200 || typeof id !== "number" || typeof codigo !== "string" || !codigo
      || typeof segredo !== "string" || !segredo || typeof expiraEm !== "string" || !Number.isFinite(Date.parse(expiraEm))) {
      throw new PairingError("upstream", `Resposta inesperada do Mapas JW (HTTP ${res.status}). Tente de novo mais tarde.`);
    }
    this.save({ baseUrl, solicitacaoId: id, codigo, segredo, expiraEm, nome, slug, estado: "pendente" });
    this.failures = 0;
    this.lastTransientError = null;
    this.lastCheckAt = null;
    this.d.logger.info({}, "Pareamento com o Mapas JW solicitado; aguardando a aprovação no Mapas JW");
    this.schedule(this.d.pollMs ?? POLL_MS);
    return { solicitacaoId: id, codigo, expiraEm };
  }

  /** Uma consulta à solicitação pendente. Sem pendente (ou expirada) não faz requisição. */
  async consultar(): Promise<PairingStatus> {
    const r = this.load();
    if (!r || r.estado !== "pendente") return this.status();
    if (this.inFlight) return this.status();
    // Vencida: UMA consulta final (o gestor pode ter aprovado em cima da hora) e só então "expirada".
    const vencida = this.isExpired(r);
    this.inFlight = true;
    try {
      await this.consultarUma(r);
    } finally { this.inFlight = false; }
    if (vencida) {
      const depois = this.load();
      if (depois?.estado === "pendente" && depois.solicitacaoId === r.solicitacaoId) {
        this.finish(depois, "expirada", "A solicitação expirou antes de ser aprovada.");
      }
    }
    return this.status();
  }

  private async consultarUma(r: PairingRecord): Promise<void> {
    const doFetch = this.d.fetch ?? fetch;
    this.lastCheckAt = this.now().toISOString();
    let res: Response;
    try {
      res = await doFetch(`${r.baseUrl}${REQUEST_PATH}/${r.solicitacaoId}`, {
        method: "GET",
        headers: { "X-Solicitacao-Secret": r.segredo, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(this.d.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return this.transient(err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "tempo esgotado" : "falha de rede");
    }
    let body: Record<string, unknown> | null = null;
    try { body = (await res.json()) as Record<string, unknown>; } catch { /* corpo não-JSON */ }

    if (res.status === 404 || res.status === 410) {
      return this.finish(r, "expirada", "O Mapas JW não reconhece mais esta solicitação (expirada ou removida).");
    }
    if (res.status === 429 || res.status >= 500) return this.transient(`HTTP ${res.status}`);
    if (res.status !== 200) {
      return this.finish(r, "erro", `O Mapas JW recusou a consulta (HTTP ${res.status}). Cancele e solicite de novo.`);
    }
    switch (body?.status) {
      case "pendente":
        this.failures = 0; this.lastTransientError = null;
        return;
      case "aprovada": {
        const token = body.token;
        if (typeof token === "string" && token.trim()) return this.accept(r, token.trim());
        // Aprovada sem token: ele já foi entregue (e perdido). Nada é sobrescrito.
        return this.finish(r, "perdida", "O Mapas JW aprovou, mas o token só é entregue uma vez e não chegou a este KMC. Revogue a aprovação no Mapas JW e solicite de novo.");
      }
      case "revogada":
        return this.finish(r, "recusada", "A solicitação foi recusada ou revogada no Mapas JW.");
      default:
        return this.transient("resposta inesperada");
    }
  }

  /** Grava o token ANTES de qualquer outra coisa; só então limpa a solicitação e a falha de autenticação. */
  private accept(r: PairingRecord, token: string): void {
    const { db } = this.d;
    const anterior = resolveMapasJwConfig(db, this.d.env ?? process.env);
    db.setKv(MAPASJW_KV_KEY, JSON.stringify({ baseUrl: r.baseUrl, token, instancia: r.nome.slice(0, 80) }));
    // Destino novo (ou desconhecido): o que estava na fila foi montado para outro e não pode ser entregue a este.
    let descartados = 0;
    if (!anterior || anterior.baseUrl !== r.baseUrl || anterior.token !== token) descartados = db.outboxDiscardPending();
    if (descartados > 0) this.d.logger.warn({}, `${descartados} envio(s) pendente(s) de outro destino foram descartados ao parear`);
    db.deleteKv(PAIRING_KV_KEY);
    db.deleteKv(MAPASJW_AUTH_KEY);
    this.failures = 0; this.lastTransientError = null;
    this.d.logger.info({}, `Pareamento com o Mapas JW concluído (instância "${r.nome}")`);
    try { this.d.onPaired?.(); } catch (err) { this.d.logger.warn({}, `Pós-pareamento falhou: ${String(err)}`); }
  }

  private transient(message: string): void {
    this.failures++;
    this.lastTransientError = message;
  }

  /** Cancela a solicitação em andamento (ou limpa o resultado final mostrado no painel). */
  cancelar(): void {
    this.d.db.deleteKv(PAIRING_KV_KEY);
    this.failures = 0; this.lastTransientError = null; this.lastCheckAt = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Desconecta de vez: apaga a configuração do store (o ambiente, se houver, continua valendo) e descarta os envios pendentes. Devolve quantos. */
  desconectar(): number {
    this.cancelar();
    this.d.db.deleteKv(MAPASJW_KV_KEY);
    this.d.db.deleteKv(MAPASJW_AUTH_KEY);
    // O que está na fila foi montado para esta conexão: não pode sobrar para a próxima.
    const descartados = this.d.db.outboxDiscardPending();
    this.d.logger.info({}, `Mapas JW desconectado (configuração local removida; ${descartados} envio(s) pendente(s) descartado(s))`);
    return descartados;
  }

  /** Estado para o painel. NUNCA inclui o segredo, o token nem a URL. */
  status(): PairingStatus {
    const r = this.load();
    if (!r) return { estado: "nenhum" };
    const expirada = r.estado === "pendente" && this.isExpired(r);
    const estado: PairingEstado = expirada ? "expirada" : r.estado;
    return {
      estado,
      solicitacaoId: r.solicitacaoId,
      codigo: estado === "pendente" ? r.codigo : null,
      expiraEm: r.expiraEm,
      nome: r.nome,
      slug: r.slug,
      mensagem: expirada ? "A solicitação expirou antes de ser aprovada." : (r.mensagem ?? null),
      ultimaConsultaEm: this.lastCheckAt,
      erroTransitorio: estado === "pendente" ? this.lastTransientError : null,
    };
  }
}
