import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { loadConfig } from '@kmc/config';
import { AppContext } from './context.js';
import { buildApp } from './app.js';
import { LogRingBuffer } from './logger.js';

const made: { ctx: AppContext; dir: string }[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const m of made.splice(0)) { m.ctx.db.close(); fs.rmSync(m.dir, { recursive: true, force: true }); } });

function make(env: Record<string, string> = {}, auth = false) {
  vi.stubEnv('KMC_MAPASJW_URL', env.KMC_MAPASJW_URL ?? '');
  vi.stubEnv('KMC_MAPASJW_TOKEN', env.KMC_MAPASJW_TOKEN ?? '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmc-att-'));
  const cfg = loadConfig({
    KMC_DATA_DIR: dir, KMC_CHROMIUM_PROFILE_DIR: path.join(dir, 'p'), KMC_PUBLIC_DIR: path.join(dir, 'pub'),
    ...(auth ? { KMC_ADMIN_TOKEN: 'adm', KMC_VIEWER_TOKEN: 'vwr' } : {}),
  });
  const ctx = new AppContext(cfg, pino({ level: 'silent' }), new LogRingBuffer());
  made.push({ ctx, dir });
  const events: { type: string; data: Record<string, unknown> }[] = [];
  ctx.bus.subscribe(ev => { if (ev.type === 'attendance.changed') events.push(ev); });
  return { ctx, events };
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

it('snapshot traz a assistência de hoje (null enquanto nada foi registrado)', () => {
  const { ctx } = make();
  expect(ctx.getSnapshot().attendance).toBeNull();
  ctx.recordPresencial(today(), 42, 'admin');
  expect(ctx.getSnapshot().attendance).toEqual({ date: today(), zoom: null, presencial: 42, total: 42 });
});

it('attendance.changed só sai em mudança real e não faz fetch sem configuração', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const { ctx, events } = make();
  ctx.recordPresencial(today(), 10, 'admin');
  ctx.recordPresencial(today(), 10, 'admin'); // igual: sem evento
  ctx.recordPresencial(today(), 12, 'remote');
  expect(events.map(e => e.data.presencial)).toEqual([10, 12]);
  expect(events[0]!.data).toEqual({ date: today(), presencial: 10, zoom: null, total: 10 });
  expect(ctx.db.outboxCounts().pending).toBe(0); // push inativo: nada na fila
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('com configuração, cada mudança entra (colapsada) no outbox', () => {
  const { ctx } = make({ KMC_MAPASJW_URL: 'https://exemplo.invalid', KMC_MAPASJW_TOKEN: 't' });
  ctx.recordPresencial(today(), 10, 'admin');
  ctx.recordPresencial(today(), 12, 'admin');
  expect(ctx.db.outboxCounts().pending).toBe(1);
  expect(JSON.parse(ctx.db.outboxList(1)[0]!.payload)).toMatchObject({ presencial: 12 });
});

it('auto-captura do Zoom emite só quando o número consolidado muda', async () => {
  const { ctx, events } = make();
  const raw = { pollName: 'Presença', question: 'q', totalVoted: 1, totalParticipants: 3, options: [{ label: '2', votes: 1 }] };
  (ctx as unknown as { zoom: unknown }).zoom = { state: 'IN_MEETING', scrapePollResults: async () => raw, getStatus: () => ({ participantCount: 3 }) };
  await ctx.capturePollResults(false);
  await ctx.capturePollResults(false); // mesma contagem: sem novo evento
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject({ zoom: 4, total: 4 }); // 2*1 + (3-1) ausentes
  raw.options = [{ label: '3', votes: 1 }];
  await ctx.capturePollResults(false);
  expect(events).toHaveLength(2);
});

it('REST: :date devolve {date,presencial,zoom,total}; today e sync existem; sync exige admin', async () => {
  const { ctx } = make({}, true);
  const app = await buildApp(ctx);
  try {
    const h = (t: string) => ({ authorization: `Bearer ${t}` });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/attendance/2026-11-01', headers: h('adm'), payload: { presencial: 40 } });
    expect(put.json()).toEqual({ date: '2026-11-01', zoom: null, presencial: 40, total: 40 });
    const get = await app.inject({ url: '/api/v1/attendance/2026-11-01', headers: h('vwr') });
    expect(get.json()).toEqual({ date: '2026-11-01', zoom: null, presencial: 40, total: 40 });
    const t = await app.inject({ url: '/api/v1/attendance/today', headers: h('vwr') });
    expect(t.json()).toMatchObject({ date: today(), presencial: 0, zoom: null, total: 0 });
    expect((await app.inject({ url: '/api/v1/attendance/sync', headers: h('vwr') })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/attendance/sync' })).statusCode).toBe(401);
    const sync = await app.inject({ url: '/api/v1/attendance/sync', headers: h('adm') });
    expect(sync.json()).toMatchObject({ enabled: false, state: 'disabled', pending: 0 });
  } finally { await app.close(); }
});
