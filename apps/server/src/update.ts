import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { UpdateStatus } from '@kmc/shared-types';

/** Versão corrente do app (única fonte; routes.ts e context.ts a importam). */
export const APP_VERSION = '0.4.0';
export const UPDATE_REPO = process.env.KMC_UPDATE_REPO || 'arthur-moebios/kingdom-meeting-control';
const ASSET_NAME = 'KingdomMeetingControl-setup.exe';

export type UpdateInfo = UpdateStatus;

/** "x.y.z" -> [x,y,z]; null se não for uma versão válida. */
export function parseVersion(s: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(s).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** <0 se a<b, 0 se iguais, >0 se a>b. Versão inválida conta como 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0], y = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
/** Extrai a versão do nome da release ("Windows 0.3.0 — Zoom nativo") ou do corpo ("Versão 0.3.0"). */
export function extractVersion(name: unknown, body: unknown): string | null {
  const a = /(\d+\.\d+\.\d+)/.exec(String(name ?? ''));
  if (a) return a[1]!;
  const b = /Vers[ãa]o\s+v?(\d+\.\d+\.\d+)/i.exec(String(body ?? ''));
  return b ? b[1]! : null;
}

export async function checkLatest(current: string): Promise<UpdateInfo> {
  const base: UpdateInfo = { current, latest: null, available: false, assetUrl: null, assetSize: null, checkedAt: new Date().toISOString(), error: null };
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/tags/pc-latest`, {
      headers: { 'User-Agent': 'kmc-updater', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const rel = await res.json() as { name?: string; body?: string; assets?: { name: string; browser_download_url: string; size: number }[] };
    const latest = extractVersion(rel.name, rel.body);
    if (!latest) throw new Error('Versão não encontrada na release.');
    const asset = rel.assets?.find(a => a.name === ASSET_NAME);
    return { ...base, latest, assetUrl: asset?.browser_download_url ?? null, assetSize: asset?.size ?? null,
      available: compareVersions(latest, current) > 0 && !!asset };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Baixa o instalador, valida e o executa destacado (o app será fechado e reaberto pelo instalador). */
export async function applyUpdate(info: UpdateInfo): Promise<{ started: true }> {
  if (process.platform !== 'win32') throw new Error('Atualização automática disponível apenas no Windows.');
  if (!info.available || !info.assetUrl || !info.assetSize) throw new Error('Nenhuma atualização disponível.');
  const res = await fetch(info.assetUrl, { headers: { 'User-Agent': 'kmc-updater' }, signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status !== 200) throw new Error(`Download falhou (HTTP ${res.status}).`);
  if (Number(res.headers.get('content-length')) !== info.assetSize) throw new Error('Tamanho do instalador diferente do esperado.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== info.assetSize) throw new Error('Download incompleto.');
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('Arquivo baixado não é um executável válido.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmc-update-'));
  const exe = path.join(dir, ASSET_NAME);
  fs.writeFileSync(exe, buf);
  spawn(exe, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS'], { detached: true, stdio: 'ignore' }).unref();
  return { started: true };
}
