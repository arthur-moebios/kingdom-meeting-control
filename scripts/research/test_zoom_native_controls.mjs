import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const catalog = JSON.parse(fs.readFileSync(new URL('./zoom-native-controls.json', import.meta.url), 'utf8'));
const source = fs.readFileSync(new URL('./zoom-native-controls.js', import.meta.url), 'utf8');
function harness({ meetingId = '1234567890', ready = 1, host = 1, cohost = 0, eligible = 1 } = {}) {
  const calls = [];
  const context = vm.createContext({ rpc: { exports: {} }, NATIVE_CONTROL_CATALOG: catalog,
    NativeFunction: function () { return () => true; },
    onMainThread: async (_thread, callback) => callback(),
    videoState: () => ({ meetingIdRaw: meetingId, inMeetingRaw: 1, conferenceReadyRaw: ready }),
  });
  vm.runInContext(source, context);
  context.controlRole = () => ({ hostRaw: host, cohostRaw: cohost });
  context.controlMeeting = () => ({ module: { base: { add: n => n } } });
  context.controlCall = (_ctx, definition, args) => { calls.push({ definition, args }); return eligible; };
  const run = async request => context.rpc.exports.control({ execute: true, meetingId: '1234567890', ...request }, 1);
  return { run, calls, context };
}

test('no control runs without an explicit execution request', async () => {
  const h = harness();
  await assert.rejects(h.run({ command: 'mute-all', execute: false, allowUnmute: false }), /Explicit execution/);
  assert.equal(h.calls.length, 0);
});
test('a stale meeting identity or incomplete ingress blocks all commands', async () => {
  for (const options of [{ meetingId: '123456789' }, { ready: 0 }]) {
    const h = harness(options);
    await assert.rejects(h.run({ command: 'mute-self' }), /identity changed|not fully ready/);
    assert.equal(h.calls.length, 0);
  }
});
test('participant zero, names and non-uint32 IDs cannot become an all-user command', async () => {
  const h = harness();
  for (const participantId of [0, -1, 2 ** 32, 1.5, 'Arthur', '42', true])
    await assert.rejects(h.run({ command: 'mute-participant', participantId }), /uint32/);
  assert.equal(h.calls.length, 0);
});
test('mute-all never silently changes the permission to unmute', async () => {
  const h = harness();
  for (const allowUnmute of [undefined, null, 0, 'false'])
    await assert.rejects(h.run({ command: 'mute-all', allowUnmute }), /Explicit allowUnmute/);
  assert.equal(h.calls.length, 0);
  const result = await h.run({ command: 'mute-all', allowUnmute: false });
  assert.deepEqual(Array.from(result.args), [0]);
});
test('host-only changes refuse a cohost; participant actions refuse an attendee', async () => {
  const cohost = harness({ host: 0, cohost: 1 });
  await assert.rejects(cohost.run({ command: 'set-allow-unmute', allowUnmute: true }), /Host role/);
  assert.equal(cohost.calls.length, 0);
  const attendee = harness({ host: 0, cohost: 0 });
  await assert.rejects(attendee.run({ command: 'admit-all' }), /Host or cohost/);
  assert.equal(attendee.calls.length, 0);
});
test('reclaim requires current native eligibility and does not execute when refused', async () => {
  const h = harness({ eligible: 0 });
  await assert.rejects(h.run({ command: 'reclaim-host' }), /does not allow/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].definition.mutates, false);
});
test('accepted unmute remains distinct from a remotely confirmed effect', async () => {
  const h = harness();
  const result = await h.run({ command: 'ask-unmute-participant', participantId: 42 });
  assert.equal(result.acceptedLocally, true);
  assert.equal(result.effectConfirmed, false);
  assert.equal(result.validation, 'static-only');
  assert.deepEqual(Array.from(result.args), [42]);
});
test('the controls surface cannot invoke media, leave, or unknown commands', async () => {
  const h = harness();
  for (const command of ['start', 'stop', 'leave-alone', '__proto__', 'constructor'])
    await assert.rejects(h.run({ command }), /Unknown control/);
  assert.equal(h.calls.length, 0);
});
test('a changed native method is rejected before it can be called', () => {
  const h = harness();
  let invoked = false;
  h.context.controlHelper = () => ({});
  h.context.readPointer = () => ({ add: () => ({}), equals: () => false });
  h.context.Process = { pointerSize: 8 };
  h.context.NativeFunction = function () { invoked = true; return () => {}; };
  // Restore the real dispatcher after the harness mocked it.
  vm.runInContext(source, h.context);
  h.context.controlHelper = () => ({});
  assert.throws(() => h.context.controlCall({ module: { base: { add: () => ({}) } } },
    catalog.commands['mute-self'], []), /Unexpected control method/);
  assert.equal(invoked, false);
});
