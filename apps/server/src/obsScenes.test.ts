import { describe, expect, it } from "vitest";
import type { ObsSettings } from "@kmc/shared-types";
import { resolveScene } from "./obsScenes.js";

const rule = (match: string, scene: string) => ({ id: match, match, scene });
const map = (rules: ObsSettings["rules"], defaultScene = ""): Pick<ObsSettings, "rules" | "defaultScene"> => ({
  rules,
  defaultScene,
});

describe("resolveScene", () => {
  it("o override da parte vence o mapa", () => {
    const part = { section: "Fim de Semana", title: "Discurso público", sceneOverride: "Palco lateral" };
    expect(resolveScene(part, map([rule("discurso", "Orador")], "Geral"))).toBe("Palco lateral");
  });

  it("casa a primeira regra cujo trecho aparece na seção+título", () => {
    const part = { section: "Fim de Semana", title: "A Sentinela: servir a Jeová" };
    expect(resolveScene(part, map([rule("discurso", "Orador"), rule("sentinela", "Leitura")]))).toBe("Leitura");
  });

  it("a ordem das regras importa — a primeira que casa ganha", () => {
    const part = { section: "Tesouros da Palavra de Deus", title: "Discurso" };
    const rules = [rule("tesouros", "Mesa"), rule("discurso", "Orador")];
    expect(resolveScene(part, map(rules))).toBe("Mesa");
  });

  it("o match não distingue maiúsculas e casa contra seção e título", () => {
    const part = { section: "NOSSA VIDA CRISTÃ", title: "Estudo bíblico de congregação" };
    expect(resolveScene(part, map([rule("vida cristã", "Mesa")]))).toBe("Mesa");
  });

  it("cai na cena padrão quando nenhuma regra casa", () => {
    const part = { section: "Início", title: "Cântico e oração" };
    expect(resolveScene(part, map([rule("discurso", "Orador")], "Geral"))).toBe("Geral");
  });

  it("retorna null quando não há regra nem cena padrão", () => {
    const part = { section: "Início", title: "Cântico" };
    expect(resolveScene(part, map([], ""))).toBeNull();
  });

  it("ignora regras com match ou cena em branco", () => {
    const part = { section: "Fim de Semana", title: "Discurso público" };
    expect(resolveScene(part, map([rule("  ", "Orador"), rule("discurso", "   ")], "Geral"))).toBe("Geral");
  });

  it("override em branco não conta — segue para o mapa", () => {
    const part = { section: "Fim de Semana", title: "Discurso público", sceneOverride: "   " };
    expect(resolveScene(part, map([rule("discurso", "Orador")]))).toBe("Orador");
  });
});
