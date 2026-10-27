import { defineConfig } from "vitest/config";
import path from "node:path";

const r = (p: string) => path.resolve(import.meta.dirname, p);

export default defineConfig({
  resolve: {
    alias: {
      "@kmc/shared-types": r("packages/shared-types/src/index.ts"),
      "@kmc/config": r("packages/config/src/index.ts"),
      "@kmc/zoom-web-adapter": r("packages/zoom-web-adapter/src/index.ts"),
      "@kmc/zoom-automation": r("packages/zoom-automation/src/index.ts"),
      "@kmc/presentation-monitor": r("packages/presentation-monitor/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
  },
});
