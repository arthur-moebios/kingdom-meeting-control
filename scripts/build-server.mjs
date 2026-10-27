// Bundles the backend (server + @kmc/* packages) into a single dist/server.mjs
// that runs with plain `node` (no tsx). Playwright stays external — it is shipped
// as node_modules alongside, with its Chromium under KMC_BROWSERS (see packaging).
import { build } from "esbuild";

await build({
    entryPoints: ["apps/server/src/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: "dist/server.mjs",
    // Playwright loads its own driver/browser files from disk — keep it external.
    external: ["playwright", "playwright-core"],
    banner: {
        js: [
            "import { createRequire as __kmcCr } from 'module';",
            "import { fileURLToPath as __kmcF } from 'url';",
            "import { dirname as __kmcD } from 'path';",
            "const require = __kmcCr(import.meta.url);",
            "const __filename = __kmcF(import.meta.url);",
            "const __dirname = __kmcD(__filename);",
        ].join("\n"),
    },
    logLevel: "info",
});

console.log("Built dist/server.mjs");
