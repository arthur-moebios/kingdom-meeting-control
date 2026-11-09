import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { UpdateStatus, UpdateApplyResult } from '@kmc/shared-types';

/** Versão corrente do app (única fonte; routes.ts e context.ts a importam). */
export const APP_VERSION = '0.4.3';
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

const HASH_ASSET_SUFFIX = '.sha256';
const LAUNCHER_EXE = 'KingdomMeetingControl.exe';
const HELPER_TIMEOUT_MS = 30_000;
/** Tempo máximo que o auxiliar espera o app fechar antes de forçar (segundos). */
const APP_EXIT_WAIT_S = 60;

/** Falha da atualização; carrega o que o usuário precisa para concluir à mão. */
export class UpdateError extends Error {
  constructor(message: string, readonly details: { installerPath?: string; logPath?: string } = {}) {
    super(message);
    this.name = 'UpdateError';
  }
}

/**
 * Argumentos do instalador Inno. Sem /SUPPRESSMSGBOXES: se falhar, o motivo aparece.
 * /LOG grava o diagnóstico em arquivo. /CLOSEAPPLICATIONS fica como rede de segurança
 * (fecha quem ainda segurar arquivos); /RESTARTAPPLICATIONS foi removido de propósito:
 * o app já estará fechado e é o auxiliar que o reabre (evita abrir duas vezes).
 */
export function installerArgs(logPath: string): string[] {
  return ['/SILENT', '/NORESTART', '/CLOSEAPPLICATIONS', `/LOG="${logPath}"`];
}

/** Extrai o SHA256 (64 hex) de um arquivo no formato "<hash>  <nome>" ou só "<hash>". */
export function parseSha256(text: string): string | null {
  const m = /^\s*([0-9a-fA-F]{64})(?:\s|$)/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Script auxiliar (PowerShell). Fase 1 (sem -Detached) apenas se re-lança desacoplada, para
 * que o auxiliar NÃO seja filho direto do node (o Launcher.cs mata os filhos do node ao
 * fechar). Fase 2: espera o app sair, fecha o launcher, varre sobras, roda o instalador,
 * reabre o app e, se o instalador falhou, mostra o motivo.
 */
export const HELPER_SCRIPT = `param([Parameter(Mandatory=$true)][string]$Config, [switch]$Detached)
$ErrorActionPreference = 'Continue'
if (-not $Detached) {
  try {
    $a = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"{0}"' -f $PSCommandPath),'-Config',('"{0}"' -f $Config),'-Detached')
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $a -WindowStyle Hidden -ErrorAction Stop
    exit 0
  } catch { exit 2 }
}
$cfg = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
function Log($m) { try { Add-Content -LiteralPath $cfg.helperLog -Value ('{0:s} {1}' -f (Get-Date), $m) -Encoding UTF8 } catch {} }
function Wait-Gone([int]$id, [int]$sec) {
  $end = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $end) {
    if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}
Log "auxiliar iniciado; aguardando app (pid $($cfg.appPid))"
if (-not (Wait-Gone ([int]$cfg.appPid) ([int]$cfg.waitSeconds))) {
  Log 'timeout aguardando o app; encerrando a força'
  Stop-Process -Id ([int]$cfg.appPid) -Force -ErrorAction SilentlyContinue
}
if ($cfg.launcherPid) {
  $lp = Get-Process -Id ([int]$cfg.launcherPid) -ErrorAction SilentlyContinue
  if ($lp -and $lp.ProcessName -eq 'KingdomMeetingControl') {
    Log 'fechando a janela do launcher'
    [void]$lp.CloseMainWindow()
    if (-not (Wait-Gone ([int]$cfg.launcherPid) 30)) {
      Log 'launcher não fechou; encerrando a força'
      Stop-Process -Id ([int]$cfg.launcherPid) -Force -ErrorAction SilentlyContinue
    }
  }
}
if ($cfg.sweepDir) {
  $root = ([IO.Path]::GetFullPath($cfg.sweepDir)).TrimEnd('\\') + '\\'
  foreach ($p in Get-Process) {
    $path = $null
    try { $path = $p.Path } catch {}
    if ($path -and $p.Id -ne $PID -and $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      Log "encerrando processo remanescente: $($p.ProcessName) ($($p.Id))"
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 1
}
$code = -1
try {
  Log 'executando o instalador'
  $proc = Start-Process -FilePath $cfg.installerPath -ArgumentList $cfg.installerArgs -Wait -PassThru -ErrorAction Stop
  $code = $proc.ExitCode
} catch { Log "falha ao executar o instalador: $($_.Exception.Message)" }
Log "instalador terminou com código $code"
if ($cfg.relaunchExe -and (Test-Path -LiteralPath $cfg.relaunchExe)) {
  try { Start-Process -FilePath $cfg.relaunchExe -WorkingDirectory (Split-Path -Parent $cfg.relaunchExe) -ErrorAction Stop; Log 'app reaberto' }
  catch { Log "falha ao reabrir o app: $($_.Exception.Message)" }
}
if ($code -ne 0) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $msg = "A atualização não foi concluída (código $code).\`n\`nLog do instalador: $($cfg.installerLog)\`nInstalador baixado: $($cfg.installerPath)\`n\`nFeche o app e execute o instalador à mão, se precisar."
    [void][System.Windows.Forms.MessageBox]::Show($msg, 'Kingdom Meeting Control', 'OK', 'Error')
  } catch {}
}
`;

export interface UpdateDeps {
  fetch: typeof fetch;
  fs: Pick<typeof fs, 'mkdtempSync' | 'writeFileSync'>;
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => Pick<ChildProcess, 'pid'> & EventEmitter;
  platform: string;
  tmpdir: () => string;
  env: Record<string, string | undefined>;
  pid: number;
  ppid: number;
  warn: (msg: string) => void;
  helperTimeoutMs: number;
}
const realDeps = (): UpdateDeps => ({
  fetch: (...a) => fetch(...a), fs, spawn: spawn as unknown as UpdateDeps['spawn'], platform: process.platform,
  tmpdir: () => os.tmpdir(), env: process.env, pid: process.pid, ppid: process.ppid,
  warn: m => console.warn(`[update] ${m}`), helperTimeoutMs: HELPER_TIMEOUT_MS,
});

/** Confere o SHA256 publicado. true = verificado; false = asset ausente (404). Divergência/erro lança. */
async function verifySha256(d: UpdateDeps, assetUrl: string, buf: Buffer): Promise<boolean> {
  let res: Response;
  try {
    res = await d.fetch(assetUrl + HASH_ASSET_SUFFIX, { headers: { 'User-Agent': 'kmc-updater' }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new UpdateError(`Não foi possível baixar o SHA256 do instalador: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) {
    d.warn('Release sem arquivo .sha256: seguindo só com as checagens de tamanho e cabeçalho.');
    return false;
  }
  if (res.status !== 200) throw new UpdateError(`Não foi possível baixar o SHA256 do instalador (HTTP ${res.status}).`);
  const expected = parseSha256(await res.text());
  if (!expected) throw new UpdateError('Arquivo SHA256 da release está malformado; atualização abortada.');
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) throw new UpdateError('SHA256 do instalador baixado não confere com o publicado; atualização abortada e nada foi executado.');
  return true;
}

/** Resolve quando o auxiliar (fase 1) saiu com 0; rejeita em erro de spawn, saída != 0 ou timeout. */
function confirmHelper(child: ReturnType<UpdateDeps['spawn']>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('o auxiliar de atualização não respondeu a tempo')), timeoutMs);
    const fail = (e: Error) => { clearTimeout(t); reject(e); };
    child.once('error', e => fail(e));
    child.once('exit', code => { if (code === 0) { clearTimeout(t); resolve(); } else fail(new Error(`o auxiliar de atualização saiu com código ${code}`)); });
    setImmediate(() => { if (child.pid === undefined) fail(new Error('o auxiliar de atualização não iniciou (sem PID)')); });
  });
}

/**
 * Baixa e valida o instalador, grava-o com um script auxiliar em pasta temporária e dispara o auxiliar
 * destacado. Só devolve sucesso depois de confirmar que o auxiliar subiu. O CHAMADOR deve então encerrar
 * o app (graciosamente): é o auxiliar que espera o app sair, roda o instalador e reabre o app.
 */
export async function applyUpdate(info: UpdateInfo, overrides: Partial<UpdateDeps> = {}): Promise<UpdateApplyResult> {
  const d: UpdateDeps = { ...realDeps(), ...overrides };
  if (d.platform !== 'win32') throw new UpdateError('Atualização automática disponível apenas no Windows.');
  if (!info.available || !info.assetUrl || !info.assetSize) throw new UpdateError('Nenhuma atualização disponível.');
  const res = await d.fetch(info.assetUrl, { headers: { 'User-Agent': 'kmc-updater' }, signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status !== 200) throw new UpdateError(`Download falhou (HTTP ${res.status}).`);
  if (Number(res.headers.get('content-length')) !== info.assetSize) throw new UpdateError('Tamanho do instalador diferente do esperado.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== info.assetSize) throw new UpdateError('Download incompleto.');
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) throw new UpdateError('Arquivo baixado não é um executável válido.');
  const hashVerified = await verifySha256(d, info.assetUrl, buf);

  const w = path.win32;
  const dir = d.fs.mkdtempSync(w.join(d.tmpdir(), 'kmc-update-'));
  const exe = w.join(dir, ASSET_NAME), logPath = w.join(dir, 'kmc-update.log');
  const script = w.join(dir, 'kmc-update.ps1'), cfgPath = w.join(dir, 'kmc-update.json');
  const details = { installerPath: exe, logPath };
  const managed = d.env.KMC_PARENT_PROCESS_MANAGED === '1';
  const baseDir = d.env.KMC_BASE_DIR || null;
  if (!baseDir) d.warn('KMC_BASE_DIR ausente: o auxiliar não saberá reabrir o app.');
  try {
    d.fs.writeFileSync(exe, buf);
    d.fs.writeFileSync(script, '\uFEFF' + HELPER_SCRIPT, 'utf8');
    d.fs.writeFileSync(cfgPath, JSON.stringify({
      appPid: d.pid, launcherPid: managed ? d.ppid : null, waitSeconds: APP_EXIT_WAIT_S,
      sweepDir: managed ? baseDir : null, relaunchExe: baseDir ? w.join(baseDir, LAUNCHER_EXE) : null,
      installerPath: exe, installerArgs: installerArgs(logPath), installerLog: logPath, helperLog: w.join(dir, 'kmc-update-helper.log'),
    }), 'utf8');
  } catch (err) {
    throw new UpdateError(`Não foi possível gravar os arquivos da atualização: ${err instanceof Error ? err.message : String(err)}`, details);
  }
  const ps = w.join(d.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const child = d.spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Config', cfgPath],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => void 0); // erro tardio não pode derrubar o servidor
    await confirmHelper(child, d.helperTimeoutMs);
    (child as { unref?: () => void }).unref?.();
  } catch (err) {
    throw new UpdateError(`Não foi possível iniciar o instalador: ${err instanceof Error ? err.message : String(err)}`, details);
  }
  return { started: true, ...details, hashVerified };
}
