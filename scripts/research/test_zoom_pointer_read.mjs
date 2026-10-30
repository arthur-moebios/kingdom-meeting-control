import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('unsafe pointer candidates never reach a native memory read', () => {
  let reads = 0;
  class Pointer {
    constructor(n) { this.n = n; }
    isNull() { return this.n === 0; }
    add(n) { return new Pointer(this.n + n); }
    compare(other) { return Math.sign(this.n - other.n); }
    readPointer() { reads++; return 'valid'; }
    toString() { return '0x' + this.n.toString(16); }
  }
  const context = vm.createContext({ rpc: {}, Process: { pointerSize: 8,
    findRangeByAddress(p) {
      if (p.n >= 100 && p.n < 200) return { base: new Pointer(100), size: 100, protection: 'rw-' };
      if (p.n >= 200 && p.n < 300) return { base: new Pointer(200), size: 100, protection: '---' };
      return null;
    } } });
  vm.runInContext(fs.readFileSync(new URL('./zoom-bridge-probe.js', import.meta.url), 'utf8'), context);
  for (const address of [0, 1, 99, 195, 200, 250, 999])
    assert.throws(() => context.readPointer(new Pointer(address)), /Refusing unreadable/);
  assert.equal(reads, 0, 'guard must fail before attempting any invalid read');
  assert.equal(context.readPointer(new Pointer(100)), 'valid');
  assert.equal(context.readPointer(new Pointer(192)), 'valid');
  assert.equal(reads, 2);
});

test('an in-meeting flag alone cannot authorize sharing before conference readiness', async () => {
  let nativeCalls = 0;
  const context = vm.createContext({ rpc: {}, NativeFunction: function () { nativeCalls++; throw new Error('Native call must not happen'); } });
  vm.runInContext(fs.readFileSync(new URL('./zoom-bridge-probe.js', import.meta.url), 'utf8'), context);
  context.onMainThread = async (_thread, fn) => fn();
  context.videoState = () => ({ inMeetingRaw: 1, conferenceReadyRaw: 0, sendingSource: '0x0' });
  context.bridgeContext = () => ({ module: {}, helper: {} });
  context.sharingSettings = () => ({});
  context.Process = { getCurrentThreadId: () => 1 };
  await assert.rejects(context.rpc.exports.run('start', 1, '42', 3), /not fully ready/);
  assert.equal(nativeCalls, 0);
});

test('media commands refuse a changed room before calling the native bridge', async () => {
  let calls = 0;
  const context = vm.createContext({ rpc: {}, NativeFunction: function () { calls++; throw new Error('Unexpected native call'); } });
  vm.runInContext(fs.readFileSync(new URL('./zoom-bridge-probe.js', import.meta.url), 'utf8'), context);
  context.onMainThread = async (_thread, callback) => callback();
  context.videoState = () => ({ meetingIdRaw: '1111111111', inMeetingRaw: 1, conferenceReadyRaw: 1 });
  for (const command of ['start', 'stop', 'configure-video', 'configure-image'])
    await assert.rejects(context.rpc.exports.run(command, 1, '42', 3, '0', '1234567890'), /identity or readiness changed/);
  assert.equal(calls, 0);
});
