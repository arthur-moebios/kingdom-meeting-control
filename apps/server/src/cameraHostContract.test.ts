import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAMERA_REASONS } from '../../dashboard/src/cameraState.js';

// A camada C# não compila fora do Windows. Este teste ao menos impede que os códigos de
// motivo do host e a tabela da página divirjam em silêncio.
const cs = readFileSync(new URL('../../../scripts/win/OperatorDesktop.cs', import.meta.url), 'utf8');

describe('contrato host C# <-> página', () => {
  const block = /static class CameraReason\s*\{([\s\S]*?)\n\}/.exec(cs)?.[1] ?? '';
  const consts = [...block.matchAll(/public const string (\w+) = "([a-z-]+)";/g)].map(m => [m[1] as string, m[2] as string] as const);
  const hostReasons = consts.map(c => c[1]);

  it('o host declara motivos', () => expect(hostReasons.length).toBeGreaterThan(5));

  it('todo motivo do host existe na tabela da página', () => {
    for (const r of hostReasons) expect(CAMERA_REASONS[r], r).toBeDefined();
  });

  it('todo motivo da tabela que não é local da página é produzido pelo host', () => {
    for (const [r, info] of Object.entries(CAMERA_REASONS)) if (!info.local) expect(hostReasons, r).toContain(r);
  });

  it('o host posta no formato que a página lê', () => {
    expect(cs).toContain('"kmc-camera-state|" + a.Kind + "|" + a.Reason');
    expect(cs).toContain('PostWebMessageAsString');
  });

  it('cada CameraAssessment construído no host casa o tipo com a tabela', () => {
    const byName = new Map(consts);
    const uses = [...cs.matchAll(/new CameraAssessment\("(\w+)", CameraReason\.(\w+)\)/g)];
    expect(uses.length).toBeGreaterThan(5);
    for (const [, kind, name] of uses) {
      const reason = byName.get(name as string) as string;
      expect(CAMERA_REASONS[reason]?.kind, `${name} -> ${reason}`).toBe(kind);
    }
  });

  it('o host não tira mais a janela do Zoom do desktop virtual', () => {
    expect(cs).not.toMatch(/desktop\.Right\s*\+/);
    expect(cs).toContain('HwndBottom');
  });
});
