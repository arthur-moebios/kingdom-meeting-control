import { describe, expect, it } from 'vitest';
import { insideViewport, isObstructed, nextEvaluationDelay, samplePoints, slotProbe, type Box } from './cameraObstruction.js';

const slot: Box = { left: 20, top: 100, right: 320, bottom: 260 };

/** Minimal stand-in for the DOM: nodes know their parent, elementFromPoint says what is painted on top. */
class Node {
  constructor(public name: string, public parent: Node | null = null) {}
  contains(other: unknown): boolean {
    for (let n = other as Node | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
}
const inside = (b: Box, x: number, y: number) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

function page(floating: Array<{ node: Node; box: Box }>) {
  const camera = new Node('slot'), label = new Node('label', camera), body = new Node('body');
  const elementFromPoint = (x: number, y: number): Node | null => {
    if (x < 0 || y < 0 || x > 1000 || y > 800) return null;
    const above = [...floating].reverse().find(f => inside(f.box, x, y)); // later = higher
    if (above) return above.node;
    return inside(slot, x, y) ? label : body;
  };
  return { camera, label, probe: slotProbe(camera, elementFromPoint) };
}

describe('regra de interseção da câmera', () => {
  it('sem nenhum elemento flutuante, a câmera fica livre', () => {
    const { probe } = page([]);
    expect(isObstructed(slot, probe)).toBe(false);
  });

  it('um filho do próprio slot não conta como obstrução', () => {
    const { camera, probe } = page([]);
    expect(camera.contains(new Node('x', camera))).toBe(true);
    expect(isObstructed(slot, probe)).toBe(false);
  });

  it('menu que cobre só uma faixa do canto da câmera esconde a prévia (caso da engrenagem)', () => {
    const menu = { node: new Node('menu'), box: { left: 250, top: 90, right: 480, bottom: 140 } };
    expect(isObstructed(slot, page([menu]).probe)).toBe(true);
  });

  it('diálogo em tela cheia esconde', () => {
    const dialog = { node: new Node('dialog'), box: { left: 0, top: 0, right: 1000, bottom: 800 } };
    expect(isObstructed(slot, page([dialog]).probe)).toBe(true);
  });

  it('flutuante que não encosta na câmera não esconde nada', () => {
    const far = { node: new Node('menu'), box: { left: 400, top: 10, right: 640, bottom: 80 } };
    const below = { node: new Node('popover'), box: { left: 20, top: 262, right: 320, bottom: 400 } };
    expect(isObstructed(slot, page([far, below]).probe)).toBe(false);
  });

  it('faixa estreita (24px) por cima também é detectada pela grade de pontos', () => {
    const strip = { node: new Node('tooltip'), box: { left: 100, top: 90, right: 124, bottom: 400 } };
    expect(isObstructed(slot, page([strip]).probe)).toBe(true);
  });

  it('ponto fora da janela (elementFromPoint nulo) não é avalizado', () => {
    expect(isObstructed({ left: -50, top: 10, right: 50, bottom: 60 }, page([]).probe)).toBe(true);
  });

  it('a grade fica dentro do retângulo, limitada e com bordas', () => {
    const points = samplePoints(slot);
    expect(points.length).toBeGreaterThanOrEqual(4);
    expect(points.length).toBeLessThanOrEqual(100);
    for (const [x, y] of points) expect(inside(slot, x, y)).toBe(true);
    expect(Math.min(...points.map(p => p[0]))).toBe(22);
    expect(Math.max(...points.map(p => p[0]))).toBe(318);
  });

  it('retângulo mínimo e degenerado não quebram a amostragem', () => {
    expect(samplePoints({ left: 5, top: 5, right: 6, bottom: 6 }).length).toBe(1);
    expect(isObstructed({ left: 5, top: 5, right: 5, bottom: 5 }, () => true)).toBe(false);
  });
});

describe('janela de visualização', () => {
  it('exige área e que o retângulo caiba na janela', () => {
    expect(insideViewport(slot, 800, 600)).toBe(true);
    expect(insideViewport({ ...slot, right: 900 }, 800, 600)).toBe(false);
    expect(insideViewport({ ...slot, left: -1 }, 800, 600)).toBe(false);
    expect(insideViewport({ left: 10, top: 10, right: 10, bottom: 50 }, 800, 600)).toBe(false);
  });
});

describe('limitação de avaliações (relógio injetado)', () => {
  it('a primeira roda na hora; as seguintes esperam o intervalo mínimo', () => {
    expect(nextEvaluationDelay(null, 1_000)).toBe(0);
    expect(nextEvaluationDelay(1_000, 1_020)).toBe(40);
    expect(nextEvaluationDelay(1_000, 1_060)).toBe(0);
    expect(nextEvaluationDelay(1_000, 9_999)).toBe(0);
  });
});
