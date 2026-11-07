// O Vite 5 não reconhece `node:sqlite` (builtin recente) e quebra o import nos
// testes. Este shim só reexporta o módulo real do Node (22+) via require.
import { createRequire } from "node:module";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
export const DatabaseSync = sqlite.DatabaseSync;
export const StatementSync = sqlite.StatementSync;
