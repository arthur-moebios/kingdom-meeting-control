import type { ImportedProgramme, ProgrammePart } from '@kmc/shared-types';
import { MINISTRY, TREASURES, isRoomBPart, normalize } from './programmeImport.js';
import { MAPASJW_AUTH_KEY, resolveMapasJwConfigWithSource, tokenFingerprint, type KvStore } from './mapasjwConfig.js';

/**
 * Leitura da programação das reuniões a partir do Mapas JW (GET /api/kmc/programacao),
 * que a serve já mesclada com o Hourglass: partes, minutos e designados de cada sala.
 * Só roda com o KMC pareado; um clone limpo nunca fala com o Mapas JW.
 *
 * O PDF continua valendo (importação manual) e o que o operador edita à mão no painel
 * nunca é sobrescrito por esta leitura (ver `mergeSynced`).
 */
export const PROGRAMME_PATH = '/api/kmc/programacao';
export const SYNC_FIRST_MS = 15_000;
export const SYNC_EVERY_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
export const SOURCE_LABEL = 'Mapas JW';

interface ApiPart {
  tipo?: string | null; secao?: string | null; numero?: number | null; titulo?: string | null; minutos?: number | null;
  sala?: string | null; designado?: string | null; ajudante?: string | null; leitor?: string | null;
}
interface ApiMidweek {
  data?: string | null; estrutura_especial?: boolean; apostila_disponivel?: boolean;
  presidente?: string | null; dirigente_sala_b?: string | null; partes?: ApiPart[];
}
interface ApiWeekend {
  data?: string | null; estrutura_especial?: boolean; presidente?: string | null; leitor_sentinela?: string | null;
  dirigente_sentinela?: string | null; discurso?: { titulo?: string | null; orador?: string | null } | null;
  sentinela?: { titulo?: string | null } | null;
}
export interface ApiWeek { semana?: string; meio_semana?: ApiMidweek | null; fim_de_semana?: ApiWeekend | null }
export interface ApiProgramme { semanas?: ApiWeek[]; nomes_indisponiveis?: boolean }

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const SECTIONS: Record<string, string> = { tesouros: TREASURES, faca_seu_melhor: MINISTRY, nossa_vida_crista: 'NOSSA VIDA CRISTÃ' };
const text = (value: unknown, max = 160) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const isIso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function labelFor(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} de ${MONTHS[(m ?? 1) - 1]} de ${y}`;
}

function toPart(part: ApiPart): ProgrammePart | null {
  const section = SECTIONS[text(part.secao)];
  if (!section || typeof part.minutos !== 'number' || part.minutos < 0 || part.numero == null) return null;
  // Estudo bíblico de congregação: o designado conduz e o leitor vai como segundo nome.
  const second = text(part.leitor) || text(part.ajudante);
  return { number: String(part.numero), section, title: text(part.titulo) || `Parte ${part.numero}`, allottedSec: Math.round(part.minutos * 60), name: text(part.designado), secondName: second };
}

function midweek(week: ApiMidweek): ImportedProgramme | null {
  if (!isIso(week.data) || week.apostila_disponivel === false) return null;
  const main: ProgrammePart[] = [], roomB: ProgrammePart[] = [];
  for (const raw of week.partes ?? []) {
    const part = toPart(raw);
    if (!part) continue;
    if (raw.sala === 'sala_b') { if (isRoomBPart(part)) roomB.push(part); }
    else main.push(part);
  }
  if (!main.length) return null;
  const warnings = ['Programação lida do Mapas JW (Hourglass).'];
  if (week.estrutura_especial) warnings.push('Semana com estrutura especial: confira as partes e os tempos antes de carregar.');
  return { id: `mapasjw-midweek-${week.data}`, date: week.data, label: labelFor(week.data), kind: 'midweek', sourceFile: SOURCE_LABEL,
    mainParts: main, roomBParts: roomB, conductorB: text(week.dirigente_sala_b), chairman: text(week.presidente), warnings };
}

function weekend(week: ApiWeekend): ImportedProgramme | null {
  if (!isIso(week.data)) return null;
  const warnings = ['Programação lida do Mapas JW (Hourglass).', 'O Hourglass não informa durações no fim de semana. Os tempos de 30 e 60 minutos são sugestões editáveis.'];
  if (week.estrutura_especial) warnings.push('Programação especial de visita: confira e edite os temas e tempos antes de carregar.');
  return { id: `mapasjw-weekend-${week.data}`, date: week.data, label: labelFor(week.data), kind: 'weekend', sourceFile: SOURCE_LABEL, roomBParts: [], conductorB: '', chairman: text(week.presidente), warnings,
    mainParts: [
      { number: '1', section: 'Fim de semana', title: text(week.discurso?.titulo, 200) || 'Discurso público', allottedSec: 1800, name: text(week.discurso?.orador), secondName: '' },
      { number: '2', section: 'Fim de semana', title: 'Estudo de A Sentinela', allottedSec: 3600, name: text(week.dirigente_sentinela), secondName: text(week.leitor_sentinela) },
    ] };
}

/** Converte a resposta do Mapas JW em programações do KMC (meio e fim de semana). */
export function programmesFromMapasJw(response: ApiProgramme): ImportedProgramme[] {
  const out: ImportedProgramme[] = [];
  for (const week of response.semanas ?? []) {
    const m = week.meio_semana ? midweek(week.meio_semana) : null;
    const w = week.fim_de_semana ? weekend(week.fim_de_semana) : null;
    if (m) out.push(m);
    if (w) out.push(w);
  }
  return out;
}

const partKey = (part: ProgrammePart) => `${part.number}|${normalize(part.title)}`;

/**
 * Mescla a leitura nova com o que já existe para a mesma data/tipo: partes e dirigente
 * da Sala B editados à mão (manual) ficam como estão; o resto vem do Mapas JW.
 */
export function mergeSynced(existing: ImportedProgramme | undefined, incoming: ImportedProgramme): ImportedProgramme {
  if (!existing) return incoming;
  const keep = (old: ProgrammePart[], next: ProgrammePart[]) => next.map((part) => {
    const previous = old.find((candidate) => candidate.manual && partKey(candidate) === partKey(part));
    return previous ? { ...part, name: previous.name, secondName: previous.secondName, manual: true } : part;
  });
  return {
    ...incoming,
    mainParts: keep(existing.mainParts, incoming.mainParts),
    roomBParts: keep(existing.roomBParts, incoming.roomBParts),
    conductorB: existing.conductorBManual ? existing.conductorB : incoming.conductorB,
    conductorBManual: existing.conductorBManual,
  };
}

export type ProgrammeSyncResult = 'inactive' | 'paused' | 'ok' | 'error';
export interface ProgrammeSyncStatus { active: boolean; lastAt: string | null; lastResult: ProgrammeSyncResult | null; lastError: string | null; weeks: number; programmes: number }
export interface ProgrammeSyncDeps {
  db: KvStore & { setKv(key: string, value: string): void; deleteKv(key: string): void };
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  /** Aplica as programações lidas (mescla com a biblioteca e atualiza o que está ativo). */
  apply: (programmes: ImportedProgramme[]) => void;
  fetch?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const localIso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export class MapasJwProgrammeSync {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;
  private state: ProgrammeSyncStatus = { active: false, lastAt: null, lastResult: null, lastError: null, weeks: 0, programmes: 0 };
  constructor(private readonly d: ProgrammeSyncDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }
  private resolve() { return resolveMapasJwConfigWithSource(this.d.db, this.d.env ?? process.env); }
  status(): ProgrammeSyncStatus { return { ...this.state, active: this.resolve() !== null }; }

  start(): void { this.stopped = false; this.schedule(SYNC_FIRST_MS); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync().finally(() => this.schedule(SYNC_EVERY_MS)), ms);
    this.timer.unref();
  }

  /** Lê a programação das próximas semanas (a partir da segunda-feira atual). */
  async sync(): Promise<ProgrammeSyncResult> {
    if (this.running) return this.state.lastResult ?? 'inactive';
    const resolved = this.resolve();
    const at = this.now().toISOString();
    if (!resolved) return this.finish('inactive', at, null, 0, 0);
    const cfg = resolved.config;
    if (this.d.db.getKv(MAPASJW_AUTH_KEY) === tokenFingerprint(cfg.token)) return this.finish('paused', at, 'token recusado pelo Mapas JW: pareie de novo', 0, 0);
    this.running = true;
    try {
      const today = this.now();
      const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      const until = new Date(monday); until.setDate(monday.getDate() + 6 * 7 - 1); // 6 semanas (o servidor aceita até 8)
      const url = `${cfg.baseUrl}${PROGRAMME_PATH}?de=${localIso(monday)}&ate=${localIso(until)}`;
      const res = await (this.d.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(this.d.timeoutMs ?? REQUEST_TIMEOUT_MS) });
      if (res.status === 401) { this.d.db.setKv(MAPASJW_AUTH_KEY, tokenFingerprint(cfg.token)); return this.finish('paused', at, 'token recusado pelo Mapas JW: pareie de novo', 0, 0); }
      if (!res.ok) return this.finish('error', at, `Mapas JW respondeu ${res.status}`, 0, 0);
      const body = (await res.json()) as ApiProgramme;
      const programmes = programmesFromMapasJw(body);
      if (programmes.length) this.d.apply(programmes);
      this.d.logger.info({}, `Programação lida do Mapas JW: ${programmes.length} reunião(ões) em ${body.semanas?.length ?? 0} semana(s)`);
      return this.finish('ok', at, null, body.semanas?.length ?? 0, programmes.length);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const message = name === 'TimeoutError' || name === 'AbortError' ? 'tempo esgotado' : String(err).split(cfg.token).join('***').slice(0, 200);
      this.d.logger.warn({}, `Leitura da programação do Mapas JW falhou: ${message}`);
      return this.finish('error', at, message, 0, 0);
    } finally { this.running = false; }
  }

  private finish(result: ProgrammeSyncResult, at: string, error: string | null, weeks: number, programmes: number): ProgrammeSyncResult {
    this.state = { active: result !== 'inactive', lastAt: at, lastResult: result, lastError: error, weeks, programmes };
    return result;
  }
}
