import { describe, expect, it, vi } from 'vitest';
import type { ImportedProgramme } from '@kmc/shared-types';
import { MAPASJW_AUTH_KEY, MAPASJW_KV_KEY, tokenFingerprint } from './mapasjwConfig.js';
import { MapasJwProgrammeSync, mergeSynced, programmesFromMapasJw, type ApiProgramme } from './mapasjwProgramme.js';
import { MINISTRY, TREASURES } from './programmeImport.js';

const part = (over: Record<string, unknown>) => ({ numero: null, minutos: null, designado: null, ajudante: null, leitor: null, ...over });
const response: ApiProgramme = {
  semanas: [{
    semana: '2026-11-09',
    meio_semana: {
      data: '2026-11-11', apostila_disponivel: true, presidente: 'ALCIMAR FERNANDES', dirigente_sala_b: 'BRUNO BOTELHO',
      partes: [
        part({ tipo: 'cantico_oracao_inicial', secao: 'abertura', titulo: 'Cântico 98 e oração inicial', sala: 'principal', designado: 'CARLOS' }),
        part({ tipo: 'treasures', secao: 'tesouros', numero: 1, titulo: 'Não siga o exemplo de Zedequias', minutos: 10, sala: 'principal', designado: 'DILTON' }),
        part({ tipo: 'reading', secao: 'tesouros', numero: 3, titulo: 'Leitura da Bíblia', minutos: 4, sala: 'principal', designado: 'FELIPE MELLO' }),
        part({ tipo: 'reading', secao: 'tesouros', numero: 3, titulo: 'Leitura da Bíblia', minutos: 4, sala: 'sala_b', designado: 'JOÃO DA SILVA' }),
        part({ tipo: 'initcall', secao: 'faca_seu_melhor', numero: 4, titulo: 'Iniciando conversas', minutos: 3, sala: 'principal', designado: 'ADRIHANY', ajudante: 'ISABELLE' }),
        part({ tipo: 'initcall', secao: 'faca_seu_melhor', numero: 4, titulo: 'Iniciando conversas', minutos: 3, sala: 'sala_b', designado: 'ISABEL', ajudante: 'LADY' }),
        part({ tipo: 'lac', secao: 'nossa_vida_crista', numero: 7, titulo: 'Necessidades locais', minutos: 15, sala: 'principal', designado: 'GERSON' }),
        part({ tipo: 'cbs', secao: 'nossa_vida_crista', numero: 8, titulo: 'Estudo bíblico de congregação', minutos: 30, sala: 'principal', designado: 'ALEX', leitor: 'MARLON' }),
      ],
    },
    fim_de_semana: { data: '2026-11-14', presidente: 'FÁBIO', leitor_sentinela: 'PATRICK', dirigente_sentinela: null, discurso: { titulo: '', orador: null }, sentinela: { titulo: 'Coração obediente' } },
  }],
};

describe('programmesFromMapasJw', () => {
  const [mid, wk] = programmesFromMapasJw(response) as [ImportedProgramme, ImportedProgramme];

  it('traz a Leitura da Bíblia e as partes do ministério para a Sala B, com nomes e tempos', () => {
    expect(mid.roomBParts.map((p) => p.number)).toEqual(['3', '4']);
    expect(mid.roomBParts[0]).toMatchObject({ section: TREASURES, title: 'Leitura da Bíblia', name: 'JOÃO DA SILVA', allottedSec: 240 });
    expect(mid.roomBParts[1]).toMatchObject({ section: MINISTRY, name: 'ISABEL', secondName: 'LADY', allottedSec: 180 });
    expect(mid.conductorB).toBe('BRUNO BOTELHO');
  });

  it('a sala principal só leva partes com tempo (sem cântico/oração) e o leitor do estudo vai como segundo nome', () => {
    expect(mid.mainParts.map((p) => p.number)).toEqual(['1', '3', '4', '7', '8']);
    expect(mid.mainParts.find((p) => p.number === '3')!.name).toBe('FELIPE MELLO');
    expect(mid.mainParts.find((p) => p.number === '8')).toMatchObject({ name: 'ALEX', secondName: 'MARLON', allottedSec: 1800 });
    expect(mid).toMatchObject({ id: 'mapasjw-midweek-2026-11-11', date: '2026-11-11', label: '11 de novembro de 2026', sourceFile: 'Mapas JW', chairman: 'ALCIMAR FERNANDES' });
  });

  it('fim de semana: discurso e Estudo de A Sentinela (leitor como segundo nome)', () => {
    expect(wk.kind).toBe('weekend');
    expect(wk.mainParts.map((p) => p.title)).toEqual(['Discurso público', 'Estudo de A Sentinela']);
    expect(wk.mainParts[1]).toMatchObject({ secondName: 'PATRICK', allottedSec: 3600 });
    expect(wk.chairman).toBe('FÁBIO');
  });

  it('ignora semana sem apostila e dados inválidos', () => {
    expect(programmesFromMapasJw({ semanas: [{ meio_semana: { data: '2026-11-11', apostila_disponivel: false, partes: [] } }, { meio_semana: { data: 'x' } }] })).toEqual([]);
  });
});

describe('mergeSynced', () => {
  const incoming = programmesFromMapasJw(response)[0]!;

  it('sem registro anterior, usa o novo', () => expect(mergeSynced(undefined, incoming)).toBe(incoming));

  it('nomes editados à mão (manual) não são sobrescritos; o resto atualiza', () => {
    const existing = structuredClone(incoming);
    existing.roomBParts[0]!.name = 'LEITOR TROCADO';
    existing.roomBParts[0]!.manual = true;
    existing.mainParts[0]!.name = 'ANTIGO'; // não manual: o Mapas JW vence
    existing.conductorB = 'DIRIGENTE MANUAL';
    existing.conductorBManual = true;
    const merged = mergeSynced(existing, incoming);
    expect(merged.roomBParts[0]).toMatchObject({ name: 'LEITOR TROCADO', manual: true });
    expect(merged.roomBParts[1]!.name).toBe('ISABEL');
    expect(merged.mainParts[0]!.name).toBe('DILTON');
    expect(merged.conductorB).toBe('DIRIGENTE MANUAL');
  });
});

describe('MapasJwProgrammeSync', () => {
  const kvWith = (config?: object) => {
    const map = new Map<string, string>();
    if (config) map.set(MAPASJW_KV_KEY, JSON.stringify(config));
    return { map, db: { getKv: (k: string) => map.get(k) ?? null, setKv: (k: string, v: string) => void map.set(k, v), deleteKv: (k: string) => void map.delete(k) } };
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const cfg = { baseUrl: 'https://mapas.example.test', token: 'segredo-123', instancia: 'salao' };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sem pareamento não faz nenhuma chamada', async () => {
    const fetcher = vi.fn();
    const { db } = kvWith();
    const sync = new MapasJwProgrammeSync({ db, logger, apply: vi.fn(), fetch: fetcher as unknown as typeof fetch, env: {} });
    expect(await sync.sync()).toBe('inactive');
    expect(fetcher).not.toHaveBeenCalled();
    expect(sync.status().active).toBe(false);
  });

  it('pareado: busca com o token, 6 semanas a partir da segunda, e aplica o resultado', async () => {
    const { db } = kvWith(cfg);
    const apply = vi.fn();
    const fetcher = vi.fn(async () => json(200, response));
    const sync = new MapasJwProgrammeSync({ db, logger, apply, fetch: fetcher as unknown as typeof fetch, env: {}, now: () => new Date('2026-11-11T20:00:00') });
    expect(await sync.sync()).toBe('ok');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mapas.example.test/api/kmc/programacao?de=2026-11-09&ate=2026-12-20');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer segredo-123');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]).toHaveLength(2);
    expect(sync.status()).toMatchObject({ active: true, lastResult: 'ok', programmes: 2, weeks: 1, lastError: null });
  });

  it('401 pausa e marca o token como recusado, sem expor o segredo', async () => {
    const { db, map } = kvWith(cfg);
    const sync = new MapasJwProgrammeSync({ db, logger, apply: vi.fn(), fetch: (async () => json(401, { message: 'Token inválido' })) as unknown as typeof fetch, env: {} });
    expect(await sync.sync()).toBe('paused');
    expect(map.get(MAPASJW_AUTH_KEY)).toBe(tokenFingerprint('segredo-123'));
    // Já pausado: nem tenta de novo.
    const again = vi.fn();
    const sync2 = new MapasJwProgrammeSync({ db, logger, apply: vi.fn(), fetch: again as unknown as typeof fetch, env: {} });
    expect(await sync2.sync()).toBe('paused');
    expect(again).not.toHaveBeenCalled();
  });

  it('falha de rede vira erro com mensagem sem o token', async () => {
    const { db } = kvWith(cfg);
    const sync = new MapasJwProgrammeSync({ db, logger, apply: vi.fn(), fetch: (async () => { throw new Error('falhou segredo-123'); }) as unknown as typeof fetch, env: {} });
    expect(await sync.sync()).toBe('error');
    expect(sync.status().lastError).not.toContain('segredo-123');
  });
});
