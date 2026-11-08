import { describe, expect, it } from 'vitest';
import { applyHostMessage, CAMERA_REASONS, describeCamera, effectiveStatus, HOST_SILENCE_MS, initialStatus, parseCameraState } from './cameraState.js';

// Todo relógio é injetado: nenhum teste lê Date.now().
const T0 = 1_000_000;

describe('estado da prévia da câmera', () => {
  it('sem ponte do app Windows, diz que a prévia só existe lá', () => {
    expect(describeCamera(initialStatus(false)).text).toMatch(/só existe no app Windows/);
  });

  it('com a ponte, mas antes da primeira mensagem, aguarda o host', () => {
    const s = initialStatus(true);
    expect(s).toMatchObject({ kind: 'unavailable', reason: 'aguardando-host', receivedAt: null });
    expect(effectiveStatus(s, T0 + 10 * HOST_SILENCE_MS)).toBe(s);
  });

  it('aceita ativa, pausada e indisponível com o motivo', () => {
    let s = initialStatus(true);
    s = applyHostMessage(s, 'kmc-camera-state|active|ok', T0);
    expect(describeCamera(effectiveStatus(s, T0 + 1000))).toMatchObject({ kind: 'active', reason: 'ok' });
    s = applyHostMessage(s, 'kmc-camera-state|paused|zoom-minimizado', T0 + 2000);
    expect(describeCamera(s)).toMatchObject({ kind: 'paused', reason: 'zoom-minimizado' });
    expect(describeCamera(s).text).toMatch(/minimizado/);
    s = applyHostMessage(s, 'kmc-camera-state|unavailable|dwm-recusou', T0 + 3000);
    expect(describeCamera(s)).toMatchObject({ kind: 'unavailable', reason: 'dwm-recusou' });
  });

  it('silêncio do host por mais de 6 s derruba "ativa" para "sem resposta"', () => {
    const s = applyHostMessage(initialStatus(true), 'kmc-camera-state|active|ok', T0);
    expect(effectiveStatus(s, T0 + HOST_SILENCE_MS).kind).toBe('active');
    const later = effectiveStatus(s, T0 + HOST_SILENCE_MS + 1);
    expect(later).toMatchObject({ kind: 'unavailable', reason: 'host-sem-resposta' });
    expect(describeCamera(later).text).toMatch(/não responde/);
  });

  it('uma nova mensagem reinicia a contagem de silêncio', () => {
    let s = applyHostMessage(initialStatus(true), 'kmc-camera-state|active|ok', T0);
    s = applyHostMessage(s, 'kmc-camera-state|active|ok', T0 + 5000);
    expect(effectiveStatus(s, T0 + 10_000).kind).toBe('active');
  });

  it('mensagens inválidas são ignoradas sem alterar o estado', () => {
    const base = applyHostMessage(initialStatus(true), 'kmc-camera-state|paused|desligada', T0);
    for (const bad of [null, undefined, 42, {}, '', 'kmc-camera-state', 'kmc-camera-state|active', 'kmc-camera-state|live|ok',
      'kmc-camera-state|active|OK', 'kmc-camera-state|active|a|b', 'outra|active|ok', 'kmc-camera-state|active|' + 'x'.repeat(41)])
      expect(applyHostMessage(base, bad, T0 + 1)).toBe(base);
  });

  it('motivo conhecido com tipo trocado falha para o lado seguro', () => {
    expect(parseCameraState('kmc-camera-state|active|zoom-minimizado')).toEqual({ kind: 'unavailable', reason: 'host-sem-resposta' });
  });

  it('motivo desconhecido preserva o tipo e usa texto genérico (host mais novo que a página)', () => {
    const s = applyHostMessage(initialStatus(true), 'kmc-camera-state|paused|motivo-futuro', T0);
    expect(describeCamera(s)).toMatchObject({ kind: 'paused', text: 'Prévia pausada.' });
  });

  it('todo motivo da tabela tem texto e tipo coerentes', () => {
    for (const [reason, info] of Object.entries(CAMERA_REASONS)) {
      expect(info.text.length, reason).toBeGreaterThan(5);
      expect(['active', 'paused', 'unavailable']).toContain(info.kind);
    }
    expect(CAMERA_REASONS['ok']?.kind).toBe('active');
  });
});
