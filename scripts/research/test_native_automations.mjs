import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAutomations, validateAutomationSettings } from './native-automations.mjs';

test('automation activation requires exact room and explicit feature flags', () => {
  for (const value of [{}, { meetingId: 'bad', autoShare: true, autoAdmit: true },
    { meetingId: '1234567890', autoShare: true }, { meetingId: '1234567890', autoShare: 'true', autoAdmit: true }])
    assert.throws(() => validateAutomationSettings(value));
});

test('native worker state distinguishes local send from reception and stops gracefully', async () => {
  let process, launch;
  const controller = createAutomations({ python: 'python', scriptDir: 'research', toolsDir: 'tools', logPath: 'test.jsonl',
    spawnWorker: (exe, args, options) => {
      launch = { exe, args, options };
      process = new EventEmitter();
      process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.stdin = new PassThrough();
      process.stdin.on('finish', () => queueMicrotask(() => process.emit('close', 0)));
      return process;
    } });
  await controller.configure({ meetingId: '1234567890', autoShare: true, autoAdmit: true });
  assert.ok(launch.args.includes('--auto-admit')); assert.ok(launch.args.includes('--managed'));
  assert.equal(launch.options.windowsHide, true);
  const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
  emit({ event: 'watch_started' }); assert.equal(controller.snapshot().phase, 'running');
  emit({ event: 'native_call', command: 'start', result: { returnRaw: 1 } }); assert.equal(controller.snapshot().share, 'sent-locally');
  assert.match(controller.snapshot().message, /não confirmada/);
  emit({ event: 'admission_requested', result: { acceptedLocally: 1 } });
  assert.match(controller.snapshot().message, /aguardando confirmação/);
  emit({ event: 'admission_error', message: 'Host role required' });
  assert.equal(controller.snapshot().lastError, 'Host role required');
  await controller.stop(); assert.equal(controller.snapshot().phase, 'stopped');
});

test('disabled configuration never starts a native worker', async () => {
  const controller = createAutomations({ spawnWorker: () => assert.fail('Unexpected process') });
  await controller.configure({ meetingId: '1234567890', autoShare: false, autoAdmit: false });
  assert.equal(controller.snapshot().phase, 'stopped');
});
