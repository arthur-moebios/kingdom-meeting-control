import { createHash } from "node:crypto";

/**
 * Configuração da integração OPCIONAL e privada com o Mapas JW.
 *
 * Resolvida a CADA chamada (nunca em const de módulo), para que um pareamento
 * feito com o servidor rodando passe a valer sem reiniciar.
 * Precedência: 1) store local (kv `mapasjw.config`); 2) ambiente
 * (KMC_MAPASJW_URL / KMC_MAPASJW_TOKEN / KMC_MAPASJW_INSTANCE).
 * Sem nenhum dos dois => null => push INATIVO (nenhum fetch). Um clone limpo do
 * repositório público nunca fala com o Mapas JW.
 */
export interface MapasJwConfig {
  baseUrl: string;
  token: string;
  instancia: string;
}

export const MAPASJW_KV_KEY = "mapasjw.config";
export const MAPASJW_AUTH_KEY = "mapasjw.authFailed";
export const DEFAULT_INSTANCE = "salao";

/** Parte do Db usada aqui (permite testar com um Map). */
export interface KvStore {
  getKv(key: string): string | null;
}

export type MapasJwSource = "store" | "env";

/** https obrigatório (o token viaja no cabeçalho); http só em loopback, para desenvolvimento. */
export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  if (u.username || u.password) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function build(url: unknown, token: unknown, instancia: unknown): MapasJwConfig | null {
  const baseUrl = normalizeBaseUrl(url);
  const t = typeof token === "string" ? token.trim() : "";
  if (!baseUrl || !t) return null;
  const inst = typeof instancia === "string" && instancia.trim() ? instancia.trim().slice(0, 80) : DEFAULT_INSTANCE;
  return { baseUrl, token: t, instancia: inst };
}

export function resolveMapasJwConfigWithSource(
  kv: KvStore | null,
  env: NodeJS.ProcessEnv = process.env,
): { config: MapasJwConfig; source: MapasJwSource } | null {
  try {
    const raw = kv?.getKv(MAPASJW_KV_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { baseUrl?: unknown; token?: unknown; instancia?: unknown };
      const config = build(o.baseUrl, o.token, o.instancia);
      if (config) return { config, source: "store" };
    }
  } catch { /* store corrompido: cai para o ambiente */ }
  const config = build(env.KMC_MAPASJW_URL, env.KMC_MAPASJW_TOKEN, env.KMC_MAPASJW_INSTANCE);
  return config ? { config, source: "env" } : null;
}

/** `{baseUrl, token, instancia}` ou null (push inativo). */
export function resolveMapasJwConfig(kv: KvStore | null, env: NodeJS.ProcessEnv = process.env): MapasJwConfig | null {
  return resolveMapasJwConfigWithSource(kv, env)?.config ?? null;
}

/** Marca do DESTINO de um envio (URL + token): item montado para um destino nunca vai para outro. */
export function destinoFingerprint(cfg: { baseUrl: string; token: string }): string {
  return createHash("sha256").update(`${cfg.baseUrl}\n${cfg.token}`).digest("hex").slice(0, 16);
}

/** Impressão digital do token (nunca o token) para lembrar qual token foi recusado. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
