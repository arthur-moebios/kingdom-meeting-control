import { afterEach, expect, it, vi } from 'vitest';
import { MeetingScheduleSchema } from '@kmc/shared-types';
import { Db } from './db.js';
import { AttendanceSync, BACKOFF_MAX_MS, backoffMs } from './attendanceSync.js';
import { MAPASJW_AUTH_KEY, MAPASJW_KV_KEY } from './mapasjwConfig.js';

const ENV = { KMC_MAPASJW_URL: 'https://exemplo.invalid', KMC_MAPASJW_TOKEN: 'segredo-de-teste', KMC_MAPASJW_INSTANCE: 'salao-teste' };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const dbs: Db[] = [];
afterEach(() => { vi.restoreAllMocks(); dbs.splice(0).forEach(d => d.close()); Object.values(logger).forEach(f => f.mockClear()); });

function setup(env: NodeJS.ProcessEnv = ENV, responses: Array<Response | Error> = []) {
  const db = new Db(':memory:'); dbs.push(db);
  let now = new Date('2026-11-07T23:15:03.000Z');
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const next = queue.shift() ?? json(200, { ok: true, atualizado: true, motivo: null });
    if (next instanceof Error) throw next;
    return next;
  });
  const sync = new AttendanceSync({
    db, logger,
    getMeeting: () => MeetingScheduleSchema.parse({ source: 'wol', kind: 'weekend', wolUrl: 'https://wol.exemplo.invalid/2026/45' }),
    appVersion: '0.3.0', fetch: fetchMock as unknown as typeof fetch, now: () => now, env,
  });
  return { db, sync, calls, fetchMock, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, queue };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

it('sem configuração não enfileira nem faz nenhum fetch', async () => {
  const { db, sync, fetchMock } = setup({});
  db.setPresencial('2026-11-07', 40);
  expect(sync.enqueue('2026-11-07')).toBe(false);
  expect(await sync.tick()).toBe('inactive');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(db.outboxCounts()).toEqual({ pending: 0, failed: 0 });
  expect(sync.status().state).toBe('disabled');
});

it('envia exatamente o contrato: corpo, cabeçalhos e sem congregation_id/total', async () => {
  const { db, sync, calls } = setup();
  db.setPresencial('2026-11-07', 40);
  expect(sync.enqueue('2026-11-07')).toBe(true);
  expect(await sync.tick()).toBe('sent');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://exemplo.invalid/api/kmc/assistencia');
  expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer segredo-de-teste');
  const body = JSON.parse(calls[0]!.init.body as string);
  expect(Object.keys(body).sort()).toEqual(['capturado_em', 'data', 'instancia', 'presencial', 'tipo', 'versao_kmc', 'zoom']);
  expect(body).toMatchObject({ data: '2026-11-07', tipo: 'fim_de_semana', presencial: 40, zoom: null, instancia: 'salao-teste', versao_kmc: '0.3.0' });
  expect(body.capturado_em).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  expect(db.outboxCounts()).toEqual({ pending: 0, failed: 0 });
  expect(sync.status()).toMatchObject({ state: 'connected', pending: 0, lastResult: { atualizado: true } });
  expect(JSON.stringify(sync.status())).not.toContain('segredo-de-teste');
});

it('colapsa pendentes do mesmo (date,tipo): o último valor vence', async () => {
  const { db, sync, calls } = setup();
  for (const n of [10, 20, 30]) { db.setPresencial('2026-11-07', n); sync.enqueue('2026-11-07'); }
  expect(db.outboxCounts().pending).toBe(1);
  expect(await sync.tick()).toBe('sent');
  expect(await sync.tick()).toBe('idle');
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.init.body as string).presencial).toBe(30);
  // datas diferentes não colapsam
  db.setPresencial('2026-11-04', 5); sync.enqueue('2026-11-04'); sync.enqueue('2026-11-07');
  expect(db.outboxCounts().pending).toBe(2);
});

it('backoff exponencial com teto de 5 min', () => {
  expect([1, 2, 3, 4].map(backoffMs)).toEqual([5000, 10000, 20000, 40000]);
  expect(backoffMs(30)).toBe(BACKOFF_MAX_MS);
});

it('5xx, 429 e erro de rede reenviam com backoff e depois entregam', async () => {
  const { db, sync, advance, fetchMock } = setup(ENV, [
    json(503, {}), new Error('ECONNRESET'), json(429, {}, { 'retry-after': '60' }),
  ]);
  db.setPresencial('2026-11-07', 40); sync.enqueue('2026-11-07');
  expect(await sync.tick()).toBe('retry');
  expect(await sync.tick()).toBe('idle');          // ainda não venceu
  advance(4_999); expect(await sync.tick()).toBe('idle');
  advance(1);     expect(await sync.tick()).toBe('retry');   // rede; próxima em 10 s
  advance(9_999); expect(await sync.tick()).toBe('idle');
  advance(1);     expect(await sync.tick()).toBe('retry');   // 429 com Retry-After 60 s (> 20 s)
  advance(59_999); expect(await sync.tick()).toBe('idle');
  advance(1);     expect(await sync.tick()).toBe('sent');
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(db.outboxCounts()).toEqual({ pending: 0, failed: 0 });
});

it('422 é permanente: não reenvia e registra o motivo', async () => {
  const { db, sync, advance, fetchMock } = setup(ENV, [json(422, { message: 'data inválida' })]);
  db.setPresencial('2026-11-07', 40); sync.enqueue('2026-11-07');
  expect(await sync.tick()).toBe('failed');
  advance(BACKOFF_MAX_MS * 10);
  expect(await sync.tick()).toBe('idle');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(db.outboxCounts()).toEqual({ pending: 0, failed: 1 });
  expect(sync.status().lastError).toMatchObject({ permanent: true, httpStatus: 422 });
  expect(sync.status().state).toBe('connected');
  expect(logger.error).toHaveBeenCalled();
});

it('401 é permanente e derruba o estado para "disconnected" até haver outro token', async () => {
  const { db, sync, fetchMock } = setup(ENV, [json(401, { message: 'Unauthenticated.' })]);
  db.setPresencial('2026-11-07', 40); sync.enqueue('2026-11-07');
  expect(await sync.tick()).toBe('failed');
  expect(sync.status()).toMatchObject({ state: 'disconnected', connected: false, failed: 1 });
  // novas mudanças continuam na fila, mas nada é enviado enquanto o token é o recusado
  db.setPresencial('2026-11-07', 41); sync.enqueue('2026-11-07');
  expect(await sync.tick()).toBe('paused');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // pareamento grava um token novo no store com o servidor rodando: volta a conectar e envia
  db.setKv(MAPASJW_KV_KEY, JSON.stringify({ baseUrl: 'https://novo.exemplo.invalid', token: 'token-novo', instancia: 'x' }));
  expect(sync.status().state).toBe('connected');
  // o item montado para o destino antigo NÃO é entregue ao novo (trava de destino)...
  expect(await sync.tick()).toBe('failed');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // ...mas o estado atual, enfileirado já para o destino novo, é enviado
  sync.enqueue('2026-11-07');
  expect(await sync.tick()).toBe('sent');
  expect(fetchMock.mock.calls[1]![0]).toBe('https://novo.exemplo.invalid/api/kmc/assistencia');
  expect(db.getKv(MAPASJW_AUTH_KEY)).toBeNull();
});

it('200 com atualizado=false (fora_de_ordem) conta como entregue', async () => {
  const { db, sync } = setup(ENV, [json(200, { ok: true, atualizado: false, motivo: 'fora_de_ordem' })]);
  db.setPresencial('2026-11-07', 40); sync.enqueue('2026-11-07');
  expect(await sync.tick()).toBe('sent');
  expect(sync.status().lastResult).toMatchObject({ atualizado: false, motivo: 'fora_de_ordem' });
});

it('redirecionamento (3xx) é permanente e não segue o token para outro host', async () => {
  const { db, sync, calls } = setup(ENV, [new Response(null, { status: 302, headers: { location: 'https://outro.invalid/' } })]);
  db.setPresencial('2026-11-07', 40); sync.enqueue('2026-11-07');
  expect(await sync.tick()).toBe('failed');
  expect(calls[0]!.init.redirect).toBe('manual');
});
