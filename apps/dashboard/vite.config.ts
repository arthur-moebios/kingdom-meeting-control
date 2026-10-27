import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy so the dashboard (5173) talks to the backend (4317) without CORS.
const BACKEND = process.env.KMC_BACKEND ?? "http://127.0.0.1:4317";

import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        // Operator dashboard + the read-only tribune tablet view (/tablet.html).
        main: resolve(import.meta.dirname, "index.html"),
        tablet: resolve(import.meta.dirname, "tablet.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND.replace(/^http/, "ws"), ws: true },
    },
  },
});
