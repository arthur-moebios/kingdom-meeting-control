import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// Dev proxy so the dashboard (5173) talks to the backend (4317) without CORS.
const BACKEND = process.env.KMC_BACKEND ?? "http://127.0.0.1:4317";

import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), {
    name:'timer-pwa',enforce:'post',
    generateBundle(_options,bundle) {
      const files=new Set(['/remote.html','/remote.webmanifest','/remote-icons/icon-192.png','/remote-icons/icon-512.png']);
      const entry=Object.values(bundle).find(output=>output.type==='chunk' && output.isEntry && output.name==='remote');
      const visit=(name:string)=> {
        if(files.has('/'+name))return;files.add('/'+name);
        const output=bundle[name];if(output?.type!=='chunk')return;
        output.imports.forEach(visit);
        const metadata=(output as typeof output & {viteMetadata?:{importedCss:Set<string>}}).viteMetadata;
        metadata?.importedCss.forEach(css=>files.add('/'+css));
      };
      if(entry?.type==='chunk')visit(entry.fileName);
      const version=createHash('sha256').update(JSON.stringify([...files]))
        .update(fs.readFileSync(resolve(import.meta.dirname,'remote.html')))
        .update(fs.readFileSync(resolve(import.meta.dirname,'public/remote.webmanifest')))
        .update(fs.readFileSync(resolve(import.meta.dirname,'public/remote-icons/icon-192.png')))
        .update(fs.readFileSync(resolve(import.meta.dirname,'public/remote-icons/icon-512.png'))).digest('hex').slice(0,16);
      const source=fs.readFileSync(resolve(import.meta.dirname,'src/remote-sw-template.js'),'utf8')
        .replace('__VERSION__',version).replace('__PRECACHE__',JSON.stringify([...files]));
      this.emitFile({type:'asset',fileName:'remote-sw.js',source});
    },
  }],
  build: {
    rollupOptions: {
      input: {
        // Operator dashboard, the read-only tribune tablet view (/tablet.html),
        // and the mobile timer remote (/remote.html).
        main: resolve(import.meta.dirname, "index.html"),
        tablet: resolve(import.meta.dirname, "tablet.html"),
        remote: resolve(import.meta.dirname, "remote.html"),
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
