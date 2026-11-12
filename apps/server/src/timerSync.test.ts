import { afterEach, expect, it, vi } from 'vitest';
import { MeetingService } from '@kmc/meeting';
import { MeetingScheduleSchema, SettingsSchema, type TimerRoom } from '@kmc/shared-types';
import { Db } from './db.js';
import { TimerSync } from './timerSync.js';
import { TimerHistory } from './timerHistory.js';
import { AttendanceSync } from './attendanceSync.js';

const ENV = { KMC_MAPASJW_URL: 'https://exemplo.invalid', KMC_MAPASJW_TOKEN: 'segredo-de-teste', KMC_MAPASJW_INSTANCE: 'salao-teste' };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const dbs: Db[] = [];
afterEach(() => { dbs.splice(0).forEach(d => d.close()); Object.values(logger).forEach(f => f.mockClear()); });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(env: NodeJS.ProcessEnv = ENV, responses: Array<Response | Error> = []) {
  const db = new Db(':memory:'); dbs.push(db);
  let t = Date.parse('2026-11-11T22:00:00.000Z');
  const now = () => new Date(t);
  const advance = (ms: number) => { t += ms; };
  const mk = () => new MeetingService({ log: { info() {}, warn() {}, error() {} }, getSettings: () => SettingsSchema.parse({}), emit: () => {}, loadState: () => null, saveState: () => {}, now: () => t });
  const rooms: Record<TimerRoom, MeetingService> = { main: mk(), b: mk() };
  const dates: Record<TimerRoom, string | null> = { main: '2026-11-11', b: '2026-11-11' };
  const names: Record<TimerRoom, Record<string, { name: string; secondName: string }>> = { main: {}, b: {} };
  const calls: { url: string; body: any }[] = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
    const next = queue.shift() ?? json(200, { ok: true, atualizado: true, motivo: null });
    if (next instanceof Error) throw next;
    return next;
  });
  let sync!: TimerSync;
  const history = new TimerHistory({
    db, now, getMeeting: r => rooms[r].getState(), getDate: r => dates[r], getAssignments: r => names[r],
    onChange: (d, tp, r) => sync.enqueueSnapshot(d, tp, r),
  });
  sync = new TimerSync({ db, logger, getMeeting: () => MeetingScheduleSchema.parse({}), appVersion: '0.5.2', fetch: fetchMock as unknown as typeof fetch, now, env }, history);
  const load = (room: TimerRoom, kind: 'midweek' | 'weekend', parts: { section: string; title: string; allottedSec: number }[]) => {
    rooms[room].replaceProgramme({ weekLabel: 'x', title: 't', kind, parts });
    history.observe(room);
  };
  /** Mede uma parte: inicia, deixa correr `sec` segundos e pausa (o que o operador faz). */
  const measure = (room: TimerRoom, idx: number, sec: number) => {
    const id = rooms[room].getState().parts[idx]!.id;
    rooms[room].start(id); history.observe(room);
    advance(sec * 1000);
    rooms[room].pause(id); history.observe(room);
  };
  return { db, sync, history, rooms, dates, names, calls, fetchMock, advance, load, measure };
}
const MID = [
  { section: 'TESOUROS DA PALAVRA DE DEUS', title: 'Discurso', allottedSec: 600 },
  { section: 'TESOUROS DA PALAVRA DE DEUS', title: 'Leitura da Bíblia', allottedSec: 240 },
  { section: 'NOSSA VIDA CRISTÃ', title: 'Estudo bíblico', allottedSec: 1800 },
];

it('consolida ao pausar: medido vai com usado_s, nunca iniciado vai null (não 0)', async () => {
  const { sync, load, measure, calls } = setup();
  load('main', 'midweek', MID);
  expect(await sync.tick()).toBe('idle'); // nada medido: nada enfileirado
  measure('main', 0, 640);
  expect(await sync.tick()).toBe('sent');
  const b = calls[0]!.body;
  expect(calls[0]!.url).toBe('https://exemplo.invalid/api/kmc/cronometro');
  expect(b).toMatchObject({ data: '2026-11-11', tipo: 'meio_semana', sala: 'main', instancia: 'salao-teste', versao_kmc: '0.5.2' });
  expect(b.partes.map((p: any) => [p.titulo, p.previsto_s, p.usado_s])).toEqual([['Discurso', 600, 640], ['Leitura da Bíblia', 240, null], ['Estudo bíblico', 1800, null]]);
  expect(new Set(b.partes.map((p: any) => p.chave)).size).toBe(3);
  expect(Object.keys(b).sort()).toEqual(['capturado_em', 'data', 'instancia', 'partes', 'sala', 'tipo', 'versao_kmc']);
});

it('reset, resetAll e reimportar a programação não apagam a medição', () => {
  const { load, measure, rooms, history, db } = setup();
  load('main', 'midweek', MID);
  measure('main', 0, 600);
  const id = rooms.main.getState().parts[0]!.id;
  rooms.main.reset(id); history.observe('main');
  rooms.main.resetAll(); history.observe('main');
  const snap = () => history.load('2026-11-11', 'meio_semana', 'main')!.parts;
  expect(snap()[0]!.usado_s).toBe(600);
  const chave = snap()[0]!.chave;
  // reimportação: ids novos, mesmos títulos => mesma medição e mesma chave
  load('main', 'midweek', MID);
  expect(snap()[0]).toMatchObject({ usado_s: 600, chave });
  // título editado depois também não perde a parte
  rooms.main.setTitle(rooms.main.getState().parts[0]!.id, 'Discurso (editado)'); history.observe('main');
  expect(snap()).toHaveLength(3);
  expect(snap()[0]).toMatchObject({ usado_s: 600, chave, titulo: 'Discurso (editado)' });
  expect(db.getTimerSnapshot('2026-11-11', 'meio_semana', 'main')).not.toBeNull();
});

it('refazer a medição depois do reset substitui; ajuste manual do tempo também consolida', () => {
  const { load, measure, rooms, history } = setup();
  load('main', 'midweek', MID);
  measure('main', 1, 300);
  rooms.main.reset(rooms.main.getState().parts[1]!.id); history.observe('main');
  measure('main', 1, 200);
  rooms.main.setElapsed(rooms.main.getState().parts[2]!.id, 1500); history.observe('main');
  const parts = history.load('2026-11-11', 'meio_semana', 'main')!.parts;
  expect(parts.map(p => p.usado_s)).toEqual([null, 200, 1500]);
});

it('parte ainda correndo não é gravada, exceto no encerramento do app (live)', () => {
  const { load, rooms, history, advance } = setup();
  load('main', 'midweek', MID);
  rooms.main.start(rooms.main.getState().parts[0]!.id); history.observe('main');
  advance(90_000);
  expect(history.observe('main')).toBe(false);
  expect(history.observe('main', true)).toBe(true);
  expect(history.load('2026-11-11', 'meio_semana', 'main')!.parts[0]!.usado_s).toBe(90);
});

it('Sala B vai separada, com designados; no fim de semana a Sala B é ignorada', async () => {
  const { sync, load, measure, names, rooms, calls, history } = setup();
  load('b', 'midweek', [{ section: 'FAÇA SEU MELHOR NO MINISTÉRIO', title: 'Iniciando conversas', allottedSec: 180 }]);
  names.b[rooms.b.getState().parts[0]!.id] = { name: 'Maria', secondName: 'Ana' };
  measure('b', 0, 200);
  load('main', 'midweek', MID); measure('main', 0, 100);
  expect(await sync.tick()).toBe('sent'); expect(await sync.tick()).toBe('sent');
  const bySala = Object.fromEntries(calls.map(c => [c.body.sala, c.body]));
  expect(bySala.b.partes[0]).toMatchObject({ usado_s: 200, previsto_s: 180, designado: 'Maria', ajudante: 'Ana' });
  expect(bySala.main.partes[0].usado_s).toBe(100);
  // fim de semana
  const w = setup();
  w.load('b', 'weekend', [{ section: 'x', title: 'y', allottedSec: 60 }]);
  w.measure('b', 0, 30);
  expect(w.history.load('2026-11-11', 'fim_de_semana', 'b')).toBeNull();
  expect(w.db.timerOutbox.outboxCounts()).toEqual({ pending: 0, failed: 0 });
});

it('coalesce mudanças seguidas da mesma reunião/sala em um envio com o estado mais recente', async () => {
  const { db, sync, load, measure, calls } = setup();
  load('main', 'midweek', MID);
  measure('main', 0, 100); measure('main', 1, 50); measure('main', 2, 10);
  expect(db.timerOutbox.outboxCounts().pending).toBe(1);
  expect(await sync.tick()).toBe('sent');
  expect(await sync.tick()).toBe('idle');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.partes.map((p: any) => p.usado_s)).toEqual([100, 50, 10]);
});

it('sem pareamento nada é enfileirado nem enviado; não toca a fila da assistência', async () => {
  const { db, sync, load, measure, fetchMock } = setup({});
  load('main', 'midweek', MID); measure('main', 0, 100);
  expect(await sync.tick()).toBe('inactive');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(db.timerOutbox.outboxCounts()).toEqual({ pending: 0, failed: 0 });
  expect(sync.status().state).toBe('disabled');
  expect(sync.enqueue()).toBe(false);
  expect(db.outboxCounts()).toEqual({ pending: 0, failed: 0 });
});

it('retentativa com backoff em 503/rede e 422 é permanente; status usa a fila do cronômetro', async () => {
  const { db, sync, load, measure, advance, fetchMock } = setup(ENV, [json(503, {}), new Error('ECONNRESET'), json(200, { ok: true, atualizado: true })]);
  load('main', 'midweek', MID); measure('main', 0, 100);
  expect(await sync.tick()).toBe('retry');
  expect(sync.status()).toMatchObject({ pending: 1 });
  advance(5_000); expect(await sync.tick()).toBe('retry');
  advance(10_000); expect(await sync.tick()).toBe('sent');
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(sync.status()).toMatchObject({ pending: 0, state: 'connected' });
  expect(JSON.stringify(sync.status())).not.toContain('segredo-de-teste');

  const x = setup(ENV, [json(422, { message: 'inválido' })]);
  x.load('main', 'midweek', MID); x.measure('main', 0, 100);
  expect(await x.sync.tick()).toBe('failed');
  expect(x.db.timerOutbox.outboxCounts()).toEqual({ pending: 0, failed: 1 });
  expect(db.timerOutbox.outboxCounts()).toEqual({ pending: 0, failed: 0 });
});

it('pareamento novo descarta pendentes das duas filas e enqueueRecent reenvia o histórico', async () => {
  const { db, sync, load, measure } = setup();
  load('main', 'midweek', MID); measure('main', 0, 100);
  expect(db.outboxDiscardPending()).toBe(1);
  expect(db.timerOutbox.outboxCounts().pending).toBe(0);
  expect(sync.enqueueRecent()).toBe(1);
  expect(db.timerOutbox.outboxCounts().pending).toBe(1);
  expect(new AttendanceSync({ db, logger, getMeeting: () => MeetingScheduleSchema.parse({}), appVersion: 'x', env: ENV }).status().pending).toBe(0);
});
