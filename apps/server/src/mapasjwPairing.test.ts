import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { loadConfig } from '@kmc/config';
import { Db } from './db.js';
import { AppContext } from './context.js';
import { buildApp } from './app.js';
import { LogRingBuffer } from './logger.js';
import { MapasJwPairing, PAIRING_KV_KEY, PairingError } from './mapasjwPairing.js';
import { MAPASJW_AUTH_KEY, MAPASJW_KV_KEY, destinoFingerprint, resolveMapasJwConfig, tokenFingerprint } from './mapasjwConfig.js';

const BASE = 'https://exemplo.invalid';
const TOKEN = 'kmc_' + 'ab'.repeat(32);
const SEGREDO = 'cd'.repeat(32);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const dbs: Db[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); dbs.splice(0).forEach(d => d.close()); });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const solicitada = (extra: Record<string, unknown> = {}) =>
  json(200, { solicitacao_id: 5, codigo: '3M2MSSYA', segredo: SEGREDO, expira_em: '2026-11-07T21:15:20-03:00', ...extra });

function setup(responses: Array<Response | Error> = []) {
  const db = new Db(':memory:'); dbs.push(db);
  let now = new Date('2026-11-07T23:45:20.000Z'); // 20:45 -03:00: 30 min antes de expirar
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const next = queue.shift();
    if (!next) throw new Error('fetch inesperado');
    if (next instanceof Error) throw next;
    return next;
  });
  const onPaired = vi.fn();
  const pairing = new MapasJwPairing({
    db, logger, appVersion: '0.3.0', onPaired, fetch: fetchMock as unknown as typeof fetch, now: () => now,
  });
  return { db, pairing, calls, fetchMock, onPaired, queue, setNow: (iso: string) => { now = new Date(iso); } };
}

it('solicitação feliz: corpo exato do contrato, kv gravado, sem token', async () => {
  const { pairing, calls, db } = setup([solicitada()]);
  const r = await pairing.solicitar(BASE + '/', '  Computador do som ', ' Exemplo ');
  expect(r).toEqual({ solicitacaoId: 5, codigo: '3M2MSSYA', expiraEm: '2026-11-07T21:15:20-03:00' });
  expect(calls[0]!.url).toBe(`${BASE}/api/kmc/instancias/solicitar`);
  expect(calls[0]!.init.method).toBe('POST');
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ nome: 'Computador do som', congregacao: 'exemplo', versao_kmc: '0.3.0' });
  const kv = JSON.parse(db.getKv(PAIRING_KV_KEY)!);
  expect(kv).toMatchObject({ baseUrl: BASE, solicitacaoId: 5, codigo: '3M2MSSYA', segredo: SEGREDO, nome: 'Computador do som', slug: 'exemplo' });
  const st = pairing.status();
  expect(st.estado).toBe('pendente');
  expect(st.codigo).toBe('3M2MSSYA');
  expect(JSON.stringify(st)).not.toContain(SEGREDO);
  expect(db.getKv(MAPASJW_KV_KEY)).toBeNull(); // nada de config antes da aprovação
});

it('pendente consulta com o cabeçalho do segredo; aprovada grava a config ANTES e limpa pairing e authFailed', async () => {
  const { pairing, calls, db, onPaired } = setup([solicitada(), json(200, { status: 'pendente' }), json(200, { status: 'aprovada', token: TOKEN })]);
  db.setKv(MAPASJW_AUTH_KEY, tokenFingerprint('token-antigo'));
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  expect((await pairing.consultar()).estado).toBe('pendente');
  expect(calls[1]!.url).toBe(`${BASE}/api/kmc/instancias/solicitar/5`);
  expect((calls[1]!.init.headers as Record<string, string>)['X-Solicitacao-Secret']).toBe(SEGREDO);
  expect(db.getKv(MAPASJW_KV_KEY)).toBeNull();

  onPaired.mockImplementation(() => { // quando o gancho roda, o token já tem de estar gravado
    expect(JSON.parse(db.getKv(MAPASJW_KV_KEY)!).token).toBe(TOKEN);
  });
  const st = await pairing.consultar();
  expect(st.estado).toBe('nenhum');
  expect(onPaired).toHaveBeenCalledTimes(1);
  expect(JSON.parse(db.getKv(MAPASJW_KV_KEY)!)).toEqual({ baseUrl: BASE, token: TOKEN, instancia: 'Salão' });
  expect(db.getKv(PAIRING_KV_KEY)).toBeNull();
  expect(db.getKv(MAPASJW_AUTH_KEY)).toBeNull();
  expect(resolveMapasJwConfig(db, {})).toEqual({ baseUrl: BASE, token: TOKEN, instancia: 'Salão' });
});

it('token é entregue uma única vez: consulta sem token não apaga nem sobrescreve a config gravada', async () => {
  const { pairing, calls, db } = setup([solicitada(), json(200, { status: 'aprovada', token: TOKEN }), json(200, { status: 'aprovada' })]);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  await pairing.consultar();
  const gravado = db.getKv(MAPASJW_KV_KEY);
  expect(gravado).toContain(TOKEN);
  await pairing.consultar(); // sem solicitação: nem faz requisição
  expect(calls).toHaveLength(2);
  expect(db.getKv(MAPASJW_KV_KEY)).toBe(gravado);
});

it('aprovada sem token numa solicitação ainda pendente vira "perdida" e preserva a config existente', async () => {
  const { pairing, db } = setup([solicitada(), json(200, { status: 'aprovada' })]);
  const existente = JSON.stringify({ baseUrl: BASE, token: 'kmc_existente', instancia: 'x' });
  db.setKv(MAPASJW_KV_KEY, existente);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  const st = await pairing.consultar();
  expect(st.estado).toBe('perdida');
  expect(st.mensagem).toMatch(/uma vez/);
  expect(db.getKv(MAPASJW_KV_KEY)).toBe(existente);
  expect(JSON.parse(db.getKv(PAIRING_KV_KEY)!).segredo).toBe(''); // segredo descartado
});

it('revogada vira "recusada" e para; consultas seguintes não fazem requisição', async () => {
  const { pairing, fetchMock, db } = setup([solicitada(), json(200, { status: 'revogada' })]);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  expect((await pairing.consultar()).estado).toBe('recusada');
  await pairing.consultar();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(db.getKv(MAPASJW_KV_KEY)).toBeNull();
});

it('422 (slug inválido) e 429 dão mensagem clara, sem retentativa e sem gravar nada', async () => {
  const a = setup([json(422, { message: 'Congregação não encontrada ou indisponível.' })]);
  const e422 = await a.pairing.solicitar(BASE, 'Salão', 'naoexiste').catch(e => e);
  expect(e422).toBeInstanceOf(PairingError);
  expect(e422.code).toBe('congregation_unavailable');
  expect(e422.message).toMatch(/slug/);
  expect(a.fetchMock).toHaveBeenCalledTimes(1);
  expect(a.db.getKv(PAIRING_KV_KEY)).toBeNull();

  const b = setup([json(429, {}, { 'retry-after': '60' })]);
  const e429 = await b.pairing.solicitar(BASE, 'Salão', 'exemplo').catch(e => e);
  expect(e429.code).toBe('rate_limited');
  expect(e429.message).toMatch(/Aguarde/);
  expect(b.fetchMock).toHaveBeenCalledTimes(1);
  expect(b.db.getKv(PAIRING_KV_KEY)).toBeNull();
});

it('entrada inválida nunca chega à rede', async () => {
  const { pairing, fetchMock } = setup();
  const cases: [string, string, string][] = [['http://exemplo.invalid', 'n', 'exemplo'], ['', 'n', 'exemplo'], [BASE, '', 'exemplo'], [BASE, 'n', 'Com Espaço'], [BASE, 'n', ''], [BASE, 'x'.repeat(81), 'exemplo']];
  for (const args of cases) {
    await expect(pairing.solicitar(...args)).rejects.toMatchObject({ code: 'invalid_input' });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it('falha de rede e resposta inesperada na solicitação não gravam nada', async () => {
  const a = setup([new TypeError('boom ' + BASE)]);
  const e = await a.pairing.solicitar(BASE, 'Salão', 'exemplo').catch(x => x);
  expect(e.code).toBe('upstream');
  expect(e.message).not.toContain('boom');
  const b = setup([json(200, { solicitacao_id: 'x' })]);
  await expect(b.pairing.solicitar(BASE, 'Salão', 'exemplo')).rejects.toMatchObject({ code: 'upstream' });
  expect(a.db.getKv(PAIRING_KV_KEY)).toBeNull();
  expect(b.db.getKv(PAIRING_KV_KEY)).toBeNull();
});

it('não permite segunda solicitação enquanto há uma pendente; cancelar libera', async () => {
  const { pairing, fetchMock } = setup([solicitada(), solicitada({ solicitacao_id: 6 })]);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  await expect(pairing.solicitar(BASE, 'Salão', 'exemplo')).rejects.toMatchObject({ code: 'pending_exists' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  pairing.cancelar();
  expect(pairing.status().estado).toBe('nenhum');
  expect((await pairing.solicitar(BASE, 'Salão', 'exemplo')).solicitacaoId).toBe(6);
});

it('expiração: vencida, faz UMA consulta final e só então marca "expirada"', async () => {
  const { pairing, fetchMock, setNow, db } = setup([solicitada(), json(200, { status: 'pendente' })]);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  setNow('2026-11-08T00:15:21.000Z'); // 21:15:21 -03:00
  expect(pairing.status().estado).toBe('expirada');
  expect(pairing.status().codigo).toBeNull();
  expect((await pairing.consultar()).estado).toBe('expirada');
  expect(fetchMock).toHaveBeenCalledTimes(2); // solicitação + consulta final
  expect(JSON.parse(db.getKv(PAIRING_KV_KEY)!).segredo).toBe('');
  await pairing.consultar();
  await pairing.consultar();
  expect(fetchMock).toHaveBeenCalledTimes(2); // nenhuma consulta além da final
  // expirada não bloqueia nova solicitação
  fetchMock.mockImplementationOnce(async () => solicitada({ solicitacao_id: 7, expira_em: '2026-11-07T22:00:00-03:00' }));
  expect((await pairing.solicitar(BASE, 'Salão', 'exemplo')).solicitacaoId).toBe(7);
});

it('expiração: aprovação em cima da hora ainda é recebida pela consulta final', async () => {
  const { pairing, setNow, db, onPaired } = setup([solicitada(), json(200, { status: 'aprovada', token: TOKEN })]);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  setNow('2026-11-08T00:15:21.000Z');
  expect((await pairing.consultar()).estado).toBe('nenhum');
  expect(JSON.parse(db.getKv(MAPASJW_KV_KEY)!).token).toBe(TOKEN);
  expect(onPaired).toHaveBeenCalledTimes(1);
});

it('expiração: falha de rede na consulta final também encerra como expirada (sem laço)', async () => {
  const { pairing, setNow, fetchMock } = setup([solicitada(), new TypeError('rede')]);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  setNow('2026-11-08T00:15:21.000Z');
  expect((await pairing.consultar()).estado).toBe('expirada');
  await pairing.consultar();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('erros transitórios (rede, 5xx, 429) mantêm pendente; 404 encerra como expirada', async () => {
  const { pairing } = setup([solicitada(), new TypeError('rede'), json(503, {}), json(429, {}), json(404, {})]);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  for (let i = 0; i < 3; i++) {
    const st = await pairing.consultar();
    expect(st.estado).toBe('pendente');
    expect(st.erroTransitorio).toBeTruthy();
  }
  expect((await pairing.consultar()).estado).toBe('expirada');
});

it('poll automático: 5 s entre consultas, para ao ser aprovada', async () => {
  vi.useFakeTimers();
  const { pairing, fetchMock, db } = setup([solicitada(), json(200, { status: 'pendente' }), json(200, { status: 'aprovada', token: TOKEN })]);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  pairing.start();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_900);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(200);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_100);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(db.getKv(MAPASJW_KV_KEY)).toContain(TOKEN);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetchMock).toHaveBeenCalledTimes(3); // parou
  pairing.stop();
});

it('sem solicitação, start() não agenda nem faz requisição', async () => {
  vi.useFakeTimers();
  const { pairing, fetchMock } = setup();
  pairing.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetchMock).not.toHaveBeenCalled();
  pairing.stop();
});

it('desconectar apaga a config e o push volta a ficar inativo', async () => {
  const { pairing, db } = setup([solicitada(), json(200, { status: 'aprovada', token: TOKEN })]);
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  await pairing.consultar();
  expect(resolveMapasJwConfig(db, {})).not.toBeNull();
  db.setKv(MAPASJW_AUTH_KEY, tokenFingerprint(TOKEN));
  pairing.desconectar();
  expect(db.getKv(MAPASJW_KV_KEY)).toBeNull();
  expect(db.getKv(MAPASJW_AUTH_KEY)).toBeNull();
  expect(resolveMapasJwConfig(db, {})).toBeNull();
});

// -- fila de saída: um destino nunca recebe item montado para outro ----------------

const ANTIGO = { baseUrl: BASE, token: 'kmc_' + '11'.repeat(32), instancia: 'a' };
const enqueueFor = (db: Db, cfg: { baseUrl: string; token: string }, date: string) =>
  db.outboxEnqueue(date, 'fim_de_semana', JSON.stringify({ data: date, tipo: 'fim_de_semana', presencial: 10, zoom: null, instancia: '' }), '2026-11-07T23:00:00.000Z', destinoFingerprint(cfg));

it('desconectar descarta os envios pendentes (e devolve quantos)', () => {
  const { pairing, db } = setup();
  db.setKv(MAPASJW_KV_KEY, JSON.stringify(ANTIGO));
  enqueueFor(db, ANTIGO, '2026-11-01'); enqueueFor(db, ANTIGO, '2026-11-02');
  expect(db.outboxCounts().pending).toBe(2);
  expect(pairing.desconectar()).toBe(2);
  expect(db.outboxCounts().pending).toBe(0);
});

it('parear com destino diferente descarta os pendentes ANTES de onPaired', async () => {
  const { pairing, db, onPaired } = setup([solicitada(), json(200, { status: 'aprovada', token: TOKEN })]);
  db.setKv(MAPASJW_KV_KEY, JSON.stringify(ANTIGO));
  enqueueFor(db, ANTIGO, '2026-11-01');
  onPaired.mockImplementation(() => { expect(db.outboxCounts().pending).toBe(0); });
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  await pairing.consultar();
  expect(onPaired).toHaveBeenCalledTimes(1);
  expect(db.outboxCounts().pending).toBe(0);
});

it('parear sem config anterior também descarta pendentes de origem desconhecida', async () => {
  const { pairing, db } = setup([solicitada(), json(200, { status: 'aprovada', token: TOKEN })]);
  enqueueFor(db, ANTIGO, '2026-11-01');
  await pairing.solicitar(BASE, 'Salão', 'exemplo');
  await pairing.consultar();
  expect(db.outboxCounts().pending).toBe(0);
});

it('item com marca de destino antigo (ou sem marca) é recusado no envio mesmo se sobrar na fila', async () => {
  const { AttendanceSync } = await import('./attendanceSync.js');
  const { MeetingScheduleSchema } = await import('@kmc/shared-types');
  const db = new Db(':memory:'); dbs.push(db);
  const env = { KMC_MAPASJW_URL: BASE, KMC_MAPASJW_TOKEN: TOKEN };
  const fetchMock = vi.fn(async () => json(200, { ok: true, atualizado: true }));
  const sync = new AttendanceSync({
    db, logger, appVersion: '0.3.0', env, fetch: fetchMock as unknown as typeof fetch, now: () => new Date('2026-11-07T23:15:03.000Z'),
    getMeeting: () => MeetingScheduleSchema.parse({ source: 'wol', kind: 'weekend', wolUrl: 'https://wol.exemplo.invalid/2026/45' }),
  });
  enqueueFor(db, ANTIGO, '2026-11-01'); // marca de outro destino
  expect(await sync.tick()).toBe('failed');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(db.outboxCounts()).toEqual({ pending: 0, failed: 1 });
  expect(db.outboxList(1)[0]!.lastError).toMatch(/outro destino/);
  // sem marca (linha antiga de antes da migração) também é recusada
  db.setPresencial('2026-11-07', 40);
  enqueueFor(db, { baseUrl: BASE, token: TOKEN }, '2026-11-02');
  (db as unknown as { db: { exec(s: string): void } }).db.exec("UPDATE attendance_outbox SET destino = NULL WHERE status = 'pending'");
  expect(await sync.tick()).toBe('failed');
  expect(fetchMock).not.toHaveBeenCalled();
  // item do destino atual segue normalmente
  expect(sync.enqueue('2026-11-07')).toBe(true);
  expect(await sync.tick()).toBe('sent');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

// -- rotas + integração com o AttendanceSync ----------------------------------

const made: { ctx: AppContext; dir: string }[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const m of made.splice(0)) { m.ctx.mapasjwPairing.stop(); m.ctx.db.close(); fs.rmSync(m.dir, { recursive: true, force: true }); } });
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function makeApp() {
  vi.stubEnv('KMC_MAPASJW_URL', ''); vi.stubEnv('KMC_MAPASJW_TOKEN', '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmc-pair-'));
  const cfg = loadConfig({
    KMC_DATA_DIR: dir, KMC_CHROMIUM_PROFILE_DIR: path.join(dir, 'p'), KMC_PUBLIC_DIR: path.join(dir, 'pub'),
    KMC_ADMIN_TOKEN: 'adm', KMC_VIEWER_TOKEN: 'vwr',
  });
  const ctx = new AppContext(cfg, pino({ level: 'silent' }), new LogRingBuffer());
  made.push({ ctx, dir });
  const app = await buildApp(ctx);
  return { ctx, app };
}
const admin = { authorization: 'Bearer adm', host: 'painel.local', origin: 'http://painel.local', 'content-type': 'application/json' };

it('rotas: fluxo completo, token/segredo nunca vazam, origem e papel são exigidos', async () => {
  const { ctx, app } = await makeApp();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(solicitada())
    .mockResolvedValueOnce(json(200, { status: 'aprovada', token: TOKEN }));
  vi.stubGlobal('fetch', fetchMock);

  // sem Origin igual ao Host => 403; viewer => 403; sem token => 401
  const body = JSON.stringify({ baseUrl: BASE, nome: 'Salão', slug: 'exemplo' });
  expect((await app.inject({ method: 'POST', url: '/api/v1/mapasjw/pair', headers: { ...admin, origin: 'http://outro.local' }, payload: body })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/v1/mapasjw/pair', headers: { ...admin, authorization: 'Bearer vwr' }, payload: body })).statusCode).toBe(403);
  expect((await app.inject({ method: 'GET', url: '/api/v1/mapasjw/pair' })).statusCode).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();

  const post = await app.inject({ method: 'POST', url: '/api/v1/mapasjw/pair', headers: admin, payload: body });
  expect(post.statusCode).toBe(200);
  expect(post.json()).toEqual({ solicitacaoId: 5, codigo: '3M2MSSYA', expiraEm: '2026-11-07T21:15:20-03:00' });
  const get = await app.inject({ method: 'GET', url: '/api/v1/mapasjw/pair', headers: admin });
  expect(get.json().estado).toBe('pendente');

  // há presencial de hoje: ao parear, o estado atual é enfileirado para reenvio
  ctx.db.setPresencial(localToday(), 33);
  await ctx.mapasjwPairing.consultar();
  expect(ctx.db.outboxCounts().pending).toBe(1);

  const outputs = [post.body, get.body,
    (await app.inject({ method: 'GET', url: '/api/v1/mapasjw/pair', headers: admin })).body,
    (await app.inject({ method: 'GET', url: '/api/v1/attendance/sync', headers: admin })).body];
  for (const o of outputs) { expect(o).not.toContain(TOKEN); expect(o).not.toContain(SEGREDO); expect(o).not.toContain(BASE); }
  const sync = (await app.inject({ method: 'GET', url: '/api/v1/attendance/sync', headers: admin })).json();
  expect(sync.state).toBe('connected');
  expect(sync.source).toBe('store');

  expect(ctx.db.outboxCounts().pending).toBe(1);
  const off = await app.inject({ method: 'POST', url: '/api/v1/mapasjw/disconnect', headers: admin, payload: '{}' });
  expect(off.statusCode).toBe(200);
  expect(off.json().state).toBe('disabled');
  expect(off.json().descartados).toBe(1);
  expect(ctx.db.outboxCounts().pending).toBe(0);
  expect(off.body).not.toContain(TOKEN);
  expect(ctx.attendanceSync.isActive()).toBe(false);
  await app.close();
});

it('rotas: 422/429 do Mapas JW viram o mesmo código HTTP com mensagem; cancel limpa', async () => {
  const { app } = await makeApp();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(422, {})).mockResolvedValueOnce(json(429, {})).mockResolvedValueOnce(solicitada()));
  const body = JSON.stringify({ baseUrl: BASE, nome: 'Salão', slug: 'exemplo' });
  const r422 = await app.inject({ method: 'POST', url: '/api/v1/mapasjw/pair', headers: admin, payload: body });
  expect(r422.statusCode).toBe(422); expect(r422.json().message).toMatch(/slug/);
  const r429 = await app.inject({ method: 'POST', url: '/api/v1/mapasjw/pair', headers: admin, payload: body });
  expect(r429.statusCode).toBe(429);
  expect((await app.inject({ method: 'POST', url: '/api/v1/mapasjw/pair', headers: admin, payload: JSON.stringify({ baseUrl: 'ftp://x', nome: 'a', slug: 'b' }) })).statusCode).toBe(400);
  await app.inject({ method: 'POST', url: '/api/v1/mapasjw/pair', headers: admin, payload: body });
  expect((await app.inject({ method: 'POST', url: '/api/v1/mapasjw/pair', headers: admin, payload: body })).statusCode).toBe(409);
  const cancel = await app.inject({ method: 'POST', url: '/api/v1/mapasjw/pair/cancel', headers: admin, payload: '{}' });
  expect(cancel.json().estado).toBe('nenhum');
  await app.close();
});
