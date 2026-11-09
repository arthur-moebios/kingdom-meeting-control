// O resolvedor parte→cena vive em @kmc/shared-types para ser importado tanto
// pelo servidor (automação) quanto pelo painel (mostrar a cena do "automático").
// Reexportado aqui para manter os imports e os testes do servidor estáveis.
export { resolveScene, type ScenePart } from "@kmc/shared-types";
