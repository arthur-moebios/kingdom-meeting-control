import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { applyUpdate, installerArgs, parseSha256, UpdateError, HELPER_SCRIPT, type UpdateDeps } from './update.js';
import type { UpdateStatus } from '@kmc/shared-types';

const body = Buffer.concat([Buffer.from('MZ'), Buffer.from('conteudo-falso-do-instalador')]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const info: UpdateStatus = { current: '0.4.0', latest: '0.4.1', available: true, assetUrl: 'https://example.invalid/dl/KingdomMeetingControl-setup.exe',
  assetSize: body.length, checkedAt: '', error: null };

type Reply = { status: number; body: Buffer | string; headers?: Record<string, string> } | Error;
function makeFetch(hash: Reply, exe: Reply = { status: 200, body, headers: { 'content-length': String(body.length) } }) {
  return vi.fn(async (url: string | URL | Request) => {
    const r = String(url).endsWith('.sha256') ? hash : exe;
    if (r instanceof Error) throw r;
    return new Response(r.body as never, { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
function fakeChild(mode: 'ok' | 'exit2' | 'error' | 'nopid') {
  const c = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
  c.unref = vi.fn();
  if (mode === 'nopid' || mode === 'error') c.pid = undefined; else c.pid = 4321;
  setImmediate(() => setImmediate(() => {
    if (mode === 'ok') c.emit('exit', 0, null);
    else if (mode === 'exit2') c.emit('exit', 2, null);
    else if (mode === 'error') c.emit('error', new Error('spawn powershell.exe ENOENT'));
  }));
  return c;
}
function deps(fetchFn: typeof fetch, mode: 'ok' | 'exit2' | 'error' | 'nopid' = 'ok', env: Record<string, string> = { KMC_PARENT_PROCESS_MANAGED: '1', KMC_BASE_DIR: 'C:\\Apps\\KMC', SystemRoot: 'C:\\Windows' }) {
  const writes: Record<string, string | Buffer> = {};
  const spawn = vi.fn(() => fakeChild(mode));
  const warn = vi.fn();
  const o: Partial<UpdateDeps> = {
    fetch: fetchFn, platform: 'win32', tmpdir: () => 'C:\\Temp', env, pid: 100, ppid: 50, warn, helperTimeoutMs: 500,
    fs: { mkdtempSync: ((p: string) => `${p}XYZ`) as never, writeFileSync: ((f: string, d: string | Buffer) => { writes[f] = d; }) as never },
    spawn: spawn as never,
  };
  return { o, writes, spawn, warn };
}

describe('argumentos do instalador', () => {
  it('sem SUPPRESSMSGBOXES/RESTARTAPPLICATIONS, com LOG', () => {
    const a = installerArgs('C:\\Temp\\kmc-update-X\\kmc-update.log');
    expect(a).toEqual(['/SILENT', '/NORESTART', '/CLOSEAPPLICATIONS', '/LOG="C:\\Temp\\kmc-update-X\\kmc-update.log"']);
    expect(a.join(' ')).not.toMatch(/SUPPRESSMSGBOXES|RESTARTAPPLICATIONS/);
  });
  it('script auxiliar não esconde erro e roda o instalador depois de esperar o app', () => {
    expect(HELPER_SCRIPT).toContain('-Detached');
    expect(HELPER_SCRIPT.indexOf('Wait-Gone')).toBeLessThan(HELPER_SCRIPT.indexOf('Start-Process -FilePath $cfg.installerPath'));
  });
});

describe('parseSha256', () => {
  it('aceita só hash e formato sha256sum; rejeita lixo', () => {
    const h = 'A'.repeat(64);
    expect(parseSha256(h)).toBe('a'.repeat(64));
    expect(parseSha256(`${h}  KingdomMeetingControl-setup.exe\n`)).toBe('a'.repeat(64));
    expect(parseSha256('nao-e-hash')).toBeNull();
    expect(parseSha256('abc')).toBeNull();
  });
});

describe('applyUpdate', () => {
  it('SHA256 igual: grava, dispara o auxiliar destacado e devolve sucesso', async () => {
    const { o, writes, spawn } = deps(makeFetch({ status: 200, body: `${sha(body)}  KingdomMeetingControl-setup.exe\n` }));
    const r = await applyUpdate(info, o);
    expect(r).toMatchObject({ started: true, hashVerified: true, installerPath: 'C:\\Temp\\kmc-update-XYZ\\KingdomMeetingControl-setup.exe', logPath: 'C:\\Temp\\kmc-update-XYZ\\kmc-update.log' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args).toContain('-File');
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    const cfg = JSON.parse(String(writes['C:\\Temp\\kmc-update-XYZ\\kmc-update.json']));
    expect(cfg).toMatchObject({ appPid: 100, launcherPid: 50, sweepDir: 'C:\\Apps\\KMC', relaunchExe: 'C:\\Apps\\KMC\\KingdomMeetingControl.exe' });
    expect(cfg.installerArgs).toEqual(installerArgs(r.logPath));
    expect(Buffer.isBuffer(writes[r.installerPath])).toBe(true);
    expect(String(writes['C:\\Temp\\kmc-update-XYZ\\kmc-update.ps1']).charCodeAt(0)).toBe(0xfeff);
  });
  it('SHA256 diferente: aborta e não grava nem executa nada', async () => {
    const { o, writes, spawn } = deps(makeFetch({ status: 200, body: 'b'.repeat(64) }));
    await expect(applyUpdate(info, o)).rejects.toThrow(/SHA256.*não confere/);
    expect(spawn).not.toHaveBeenCalled();
    expect(Object.keys(writes)).toHaveLength(0);
  });
  it('arquivo de hash malformado ou erro de rede/5xx: aborta', async () => {
    for (const hash of [{ status: 200, body: 'lixo' }, { status: 503, body: '' }, new Error('ECONNRESET')] as Reply[]) {
      const { o, spawn } = deps(makeFetch(hash));
      await expect(applyUpdate(info, o)).rejects.toBeInstanceOf(UpdateError);
      expect(spawn).not.toHaveBeenCalled();
    }
  });
  it('SHA256 ausente (404): segue com as checagens atuais e avisa', async () => {
    const { o, spawn, warn } = deps(makeFetch({ status: 404, body: 'Not Found' }));
    const r = await applyUpdate(info, o);
    expect(r.hashVerified).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sha256/i));
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('mantém as checagens de tamanho e MZ', async () => {
    const bad = Buffer.from('XX' + 'y'.repeat(body.length - 2));
    const { o } = deps(makeFetch({ status: 404, body: '' }, { status: 200, body: bad, headers: { 'content-length': String(bad.length) } }));
    await expect(applyUpdate(info, o)).rejects.toThrow(/executável válido/);
    const d2 = deps(makeFetch({ status: 404, body: '' }, { status: 200, body, headers: { 'content-length': '1' } }));
    await expect(applyUpdate(info, d2.o)).rejects.toThrow(/Tamanho/);
  });
  it.each(['error', 'nopid', 'exit2'] as const)('falha no lançamento (%s): não devolve sucesso e informa o caminho do instalador', async (mode) => {
    const { o } = deps(makeFetch({ status: 404, body: '' }), mode);
    const err = await applyUpdate(info, o).catch(e => e) as UpdateError;
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.message).toMatch(/Não foi possível iniciar o instalador/);
    expect(err.details.installerPath).toBe('C:\\Temp\\kmc-update-XYZ\\KingdomMeetingControl-setup.exe');
    expect(err.details.logPath).toMatch(/kmc-update\.log$/);
  });
  it('spawn que lança de forma síncrona também vira erro', async () => {
    const d = deps(makeFetch({ status: 404, body: '' }));
    d.o.spawn = (() => { throw new Error('EACCES'); }) as never;
    await expect(applyUpdate(info, d.o)).rejects.toThrow(/EACCES/);
  });
  it('erro tardio no ChildProcess depois do sucesso não derruba o processo', async () => {
    const child = fakeChild('ok');
    const d = deps(makeFetch({ status: 404, body: '' }));
    d.o.spawn = (() => child) as never;
    await applyUpdate(info, d.o);
    expect(() => child.emit('error', new Error('tarde'))).not.toThrow();
  });
  it('fora do Windows ou sem update disponível: recusa', async () => {
    const d = deps(makeFetch({ status: 404, body: '' }));
    await expect(applyUpdate(info, { ...d.o, platform: 'linux' })).rejects.toThrow(/apenas no Windows/);
    await expect(applyUpdate({ ...info, available: false }, d.o)).rejects.toThrow(/Nenhuma atualização/);
  });
  it('sem launcher gerenciado: não fecha launcher nem varre a pasta', async () => {
    const { o, writes } = deps(makeFetch({ status: 404, body: '' }), 'ok', { SystemRoot: 'C:\\Windows' });
    await applyUpdate(info, o);
    const cfg = JSON.parse(String(writes['C:\\Temp\\kmc-update-XYZ\\kmc-update.json']));
    expect(cfg).toMatchObject({ launcherPid: null, sweepDir: null, relaunchExe: null });
  });
});
