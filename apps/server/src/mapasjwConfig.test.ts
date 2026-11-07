import { expect, it } from 'vitest';
import { MAPASJW_KV_KEY, normalizeBaseUrl, resolveMapasJwConfig, resolveMapasJwConfigWithSource } from './mapasjwConfig.js';

const kvOf = (m: Map<string, string>) => ({ getKv: (k: string) => m.get(k) ?? null });
const ENV = { KMC_MAPASJW_URL: 'https://env.exemplo.invalid/', KMC_MAPASJW_TOKEN: 'tok-env', KMC_MAPASJW_INSTANCE: 'do-ambiente' };
const STORE = JSON.stringify({ baseUrl: 'https://store.exemplo.invalid', token: 'tok-store', instancia: 'do-store' });

it('sem store e sem ambiente a configuração é nula (push inativo)', () => {
  expect(resolveMapasJwConfig(kvOf(new Map()), {})).toBeNull();
  expect(resolveMapasJwConfig(null, {})).toBeNull();
  expect(resolveMapasJwConfig(kvOf(new Map()), { KMC_MAPASJW_URL: '', KMC_MAPASJW_TOKEN: '' })).toBeNull();
  expect(resolveMapasJwConfig(kvOf(new Map()), { KMC_MAPASJW_URL: 'https://x.exemplo.invalid' })).toBeNull(); // falta token
});

it('o store local tem precedência sobre o ambiente', () => {
  const kv = new Map([[MAPASJW_KV_KEY, STORE]]);
  expect(resolveMapasJwConfigWithSource(kvOf(kv), ENV)).toEqual({
    source: 'store', config: { baseUrl: 'https://store.exemplo.invalid', token: 'tok-store', instancia: 'do-store' },
  });
});

it('sem store usa o ambiente, normalizando a URL e aplicando a instância padrão', () => {
  expect(resolveMapasJwConfig(kvOf(new Map()), ENV)).toEqual({ baseUrl: 'https://env.exemplo.invalid', token: 'tok-env', instancia: 'do-ambiente' });
  expect(resolveMapasJwConfig(kvOf(new Map()), { ...ENV, KMC_MAPASJW_INSTANCE: undefined })?.instancia).toBe('salao');
});

it('é recarregável: gravar o store depois passa a valer sem reiniciar', () => {
  const kv = new Map<string, string>();
  expect(resolveMapasJwConfig(kvOf(kv), {})).toBeNull();
  kv.set(MAPASJW_KV_KEY, STORE);
  expect(resolveMapasJwConfig(kvOf(kv), {})?.token).toBe('tok-store');
  kv.set(MAPASJW_KV_KEY, '{lixo');
  expect(resolveMapasJwConfig(kvOf(kv), ENV)?.token).toBe('tok-env'); // store corrompido cai no ambiente
});

it('rejeita URL insegura ou com credenciais (token só viaja por https ou loopback)', () => {
  expect(normalizeBaseUrl('http://exemplo.invalid')).toBeNull();
  expect(normalizeBaseUrl('https://u:p@exemplo.invalid')).toBeNull();
  expect(normalizeBaseUrl('ftp://exemplo.invalid')).toBeNull();
  expect(normalizeBaseUrl('http://localhost:8000/')).toBe('http://localhost:8000');
});
