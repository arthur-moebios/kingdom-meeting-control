import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('native panel retains stale reads, restricts control origin and rejects undeclared commands', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kmc-native-test-'));
  const publicDir = path.join(directory, 'public');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<h1>Native test</h1>');
  await fs.writeFile(path.join(directory, 'secret.txt'), 'must not be served');
  await fs.writeFile(path.join(directory, 'zoom-native-read.py'),
    `console.log(JSON.stringify({source:'zoom-native-passive-memory',observedAt:new Date(Date.now()-10000).toISOString(),participants:[{id:'42',displayName:'João'}],partial:false}));`);
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./native-dashboard-server.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KMC_NATIVE_PYTHON: process.execPath, KMC_NATIVE_SCRIPTS: directory,
      KMC_NATIVE_PORT: String(port), KMC_PUBLIC_DIR: publicDir },
  });
  t.after(async () => {
    if (child.exitCode === null) { const ended = once(child, 'close'); child.kill(); await ended; }
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('kmc-native-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let response;
  for (let i = 0; i < 40; i++) {
    try { response = await fetch(base + '/api/v1/native/snapshot'); if (response.ok) break; } catch { }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(response?.ok);
  const state = await response.json();
  assert.equal(state.participants[0].displayName, 'João');
  assert.equal(state.stale, true); assert.equal(state.partial, true);
  assert.equal((await fetch(base + '/api/v1/zoom/leave', { method: 'POST' })).status, 405);
  assert.equal((await (await fetch(base + '/api/v1/native/automations')).json()).phase, 'stopped');
  assert.equal((await fetch(base + '/api/v1/native/automations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://external.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/v1/native/automations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' })).status, 400);
  assert.equal((await fetch(base + '/%2e%2e%2fsecret.txt')).status, 403);
  const invalidHost = await new Promise((resolve, reject) => {
    const request = http.get(base + '/', { headers: { Host: 'remote.invalid' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(invalidHost, 403);
  assert.match(await (await fetch(base + '/')).text(), /Native test/);
});
