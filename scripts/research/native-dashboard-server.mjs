// Isolated native panel. Controls require explicit, meeting-bound activation.
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createAutomations } from './native-automations.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(process.env.KMC_PUBLIC_DIR || path.join(base, 'public'));
const scriptDir = process.env.KMC_NATIVE_SCRIPTS || path.join(base, 'research');
const python = process.env.KMC_NATIVE_PYTHON || (existsSync(path.join(base, 'python', 'python.exe'))
  ? path.join(base, 'python', 'python.exe') : (await fs.readFile(path.join(base, 'native-python.txt'), 'utf8')).trim());
const port = Number(process.env.KMC_NATIVE_PORT || 4318);
const toolsDir = process.env.KMC_NATIVE_TOOLS || (existsSync(path.join(base, 'native-tools'))
  ? path.join(base, 'native-tools') : (await fs.readFile(path.join(base, 'native-tools.txt'), 'utf8').catch(() => '')).trim());
const automations = createAutomations({ python, scriptDir, toolsDir,
  logPath: path.join(base, 'native-automations.jsonl') });
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid native panel port');
let observation = null, worker = null, stopping = false, restart = null;
function startReader() {
  if (stopping) return;
  worker = spawn(python, [path.join(scriptDir, 'zoom-native-read.py'), '--managed', '--interval-ms', '500'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  let buffer = '';
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 2_000_000) { worker.kill(); buffer = ''; return; }
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const data = JSON.parse(line); if (data.source === 'zoom-native-passive-memory' && Array.isArray(data.participants)) observation = data; }
      catch { /* ignore a malformed observation, retain last known state */ }
    }
  });
  worker.stderr.on('data', () => {}); // transient missing meeting; retries below
  worker.on('error', () => {});
  worker.on('close', () => { worker = null; if (!stopping) restart = setTimeout(startReader, 2000); });
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (![String(`127.0.0.1:${port}`), String(`localhost:${port}`)].includes(req.headers.host || '')) return json(403, { error: 'Invalid host' });
  if (req.method === 'POST' && ['/api/v1/native/automations', '/api/v1/native/shutdown', '/api/v1/native/command', '/api/v1/native/desktop'].includes(req.url)) {
    if (req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`)
      return json(403, { error: 'Invalid origin' });
    if (req.headers['content-type'] !== 'application/json') return json(415, { error: 'JSON required' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(413, { error: 'Request too large' }); }
      if (req.url === '/api/v1/native/shutdown') {
        await automations.stop(); json(200, { stopped: true }); stop(); return;
      }
      const value = JSON.parse(body);
      if (req.url === '/api/v1/native/command') return json(200, await automations.command(value));
      if (req.url === '/api/v1/native/desktop') {
        if (typeof value.hidden !== 'boolean') throw new Error('hidden must be boolean');
        const file = path.join(base, 'native-desktop-request.json');
        await fs.writeFile(file + '.tmp', JSON.stringify({ hidden: value.hidden, revision: Date.now() }));
        await fs.rename(file + '.tmp', file);
        return json(200, value);
      }
      return json(200, await automations.configure(value));
    } catch (error) { return json(400, { error: error.message }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Painel somente leitura' });
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/v1/health') return json(200, { status: 'ok', mode: 'native-experimental' });
    if (url.pathname === '/api/v1/native/automations') return json(200, automations.snapshot());
    if (url.pathname === '/api/v1/native/snapshot') {
      if (!observation) return json(503, { error: 'Aguardando a reunião do Zoom nativo' });
      const stale = Date.now() - Date.parse(observation.observedAt) > 5000;
      return json(200, { ...observation, stale, partial: observation.partial || stale });
    }
    if (url.pathname.startsWith('/api/')) return json(404, { error: 'Rota indisponível neste painel' });
    const requested = decodeURIComponent(url.pathname);
    const file = path.resolve(publicDir, '.' + (requested === '/' ? '/index.html' : requested));
    if (!file.startsWith(publicDir + path.sep) || requested.includes('\0')) return json(403, { error: 'Invalid path' });
    const bytes = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { json(404, { error: 'Arquivo não encontrado' }); }
});
server.listen(port, '127.0.0.1', () => { console.log(`Native read-only panel on ${port}`); startReader(); });
async function stop() { if (stopping) return; stopping = true; clearTimeout(restart); await automations.stop().catch(() => {}); worker?.kill(); server.close(() => process.exit(0)); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
if (process.env.KMC_PARENT_PROCESS_MANAGED === '1') { process.stdin.on('end', stop); process.stdin.resume(); }
