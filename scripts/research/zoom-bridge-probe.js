// Experimental in-process research. No UI controls or target initialization.
// Zoom's crash handler may intercept access violations before Frida can turn
// them into JS exceptions. Never probe an unknown/null address with try/catch.
function readPointer(address) {
  const range = Process.findRangeByAddress(address);
  if (address.isNull() || !range || !range.protection.includes('r') ||
      address.add(Process.pointerSize).compare(range.base.add(range.size)) > 0)
    throw new Error('Refusing unreadable pointer address ' + address);
  return address.readPointer();
}
function onMainThread(threadId, callback, wakeWindowText = '0') {
  return new Promise((resolve, reject) => {
    let finished = false;
    let executing = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      hook.detach();
      if (error) reject(error); else resolve(value);
    };
    const hook = Interceptor.attach(Process.getModuleByName('user32.dll').getExportByName('DispatchMessageW'), {
      onLeave() {
        if (finished || executing || Process.getCurrentThreadId() !== threadId) return;
        executing = true;
        try { finish(null, callback()); } catch (error) { finish(error); }
      },
    });
    const timer = setTimeout(() => finish(new Error('No dispatch on selected main thread within 8 seconds')), 8000);
    const wakeWindow = ptr(wakeWindowText);
    if (!wakeWindow.isNull()) {
      try {
        const user = Process.getModuleByName('user32.dll');
        const owner = Memory.alloc(4);
        const windowThread = new NativeFunction(user.getExportByName('GetWindowThreadProcessId'), 'uint', ['pointer', 'pointer'], 'win64')(wakeWindow, owner);
        if (windowThread !== threadId || owner.readU32() !== Process.id) throw new Error('Wake window does not belong to selected Zoom thread');
        // WM_NULL only wakes the app message pump; it invokes no UI command.
        const posted = new NativeFunction(user.getExportByName('PostMessageW'), 'int', ['pointer', 'uint', 'pointer', 'pointer'], 'win64')(wakeWindow, 0, ptr(0), ptr(0));
        if (!posted) throw new Error('Could not wake Zoom message pump');
      } catch (error) { finish(error); }
    }
  });
}

function bridgeContext() {
  const module = Process.getModuleByName('zoom_meeting_bridge.dll');
  const meeting = new NativeFunction(module.getExportByName('GetActiveMeeting'), 'pointer', [], 'win64')();
  if (meeting.isNull()) throw new Error('No meeting instance');
  const getter = readPointer(readPointer(meeting).add(0x88));
  if (!getter.equals(module.base.add(0x1be30))) throw new Error('Unexpected sharing getter');
  const helper = readPointer(meeting.add(0x29c8));
  if (helper.isNull() || !readPointer(helper).equals(module.base.add(0x195b90)))
    throw new Error('Expected initialized sharing helper is absent');
  return { module, meeting, helper };
}

function videoState() {
  const module = Process.getModuleByName('zVideoUI.dll');
  const invoke = (name, result) => new NativeFunction(module.getExportByName(name), result, [], 'win64')();
  const common = Process.getModuleByName('Cmmlib.dll');
  const text = Memory.alloc(64);
  const number = Memory.alloc(8); number.writeS64(0);
  const destroyText = new NativeFunction(common.getExportByName('??1?$CStringT@_W@Cmm@@UEAA@XZ'), 'void', ['pointer'], 'win64');
  new NativeFunction(common.getExportByName('??0?$CStringT@_W@Cmm@@QEAA@XZ'), 'pointer', ['pointer'], 'win64')(text);
  let meetingIdRaw;
  try {
    new NativeFunction(module.getExportByName('?GetMeetingID@ConfStatusBridge@@SAHAEA_JAEAV?$CStringT@_W@Cmm@@@Z'),
      'int', ['pointer', 'pointer'], 'win64')(number, text);
    meetingIdRaw = number.readS64().toString();
  } finally {
    destroyText(text);
  }
  return { meetingIdRaw, conferenceReadyRaw: invoke('?IsConfReady@ConfStatusBridge@@SAHXZ', 'int'),
    inMeetingRaw: invoke('?IsInMeeting@UICommandBridge@@SAHXZ', 'int'),
    shareStatusRaw: invoke('?GetShareStatus@ConfStatusBridge@@SA?AW4CMM_SHARESTATUS@@XZ', 'int'),
    sendingSource: invoke('?GetMySendingShareSource@ShareApiBridge@@SAPEAVICmmASShareSource@@XZ', 'pointer').toString() };
}

function sharingSettings(module, helper) {
  const get = rva => new NativeFunction(module.base.add(rva), 'int', ['pointer', 'int'], 'win64')(helper, 0);
  return { optimizeRaw: get(0x475c0), computerAudioRaw: get(0x41090),
    audioModeRaw: new NativeFunction(module.base.add(0x48380), 'int', ['pointer'], 'win64')(helper) };
}

function readBooleanPreference(name) {
  const biz = Process.getModuleByName('cmmbiz.dll');
  const id = new NativeFunction(biz.getExportByName('?QueryIDViaKnownStr@zpref@@YA?AW4zPolicyId@1@PEBD@Z'), 'int', ['pointer'], 'win64')(Memory.allocUtf8String(name));
  if (id === 0x370 || id < 0 || id > 0x36f) throw new Error('Unknown preference name ' + name);
  const value = Memory.alloc(4); value.writeS32(-1);
  const flags = [Memory.alloc(8), Memory.alloc(8), Memory.alloc(8)];
  for (const flag of flags) flag.writeU64(0);
  const code = new NativeFunction(biz.getExportByName('?QueryBooleanPolicyValueFromMemory@Cmm@@YAHW4zPolicyId@zpref@@AEAHPEA_N22@Z'),
    'int', ['int', 'pointer', 'pointer', 'pointer', 'pointer'], 'win64')(id, value, ...flags);
  return { name, policyId: id, returnRaw: code, valueRaw: value.readS32(), flagsRaw: flags.map(f => f.readU8()) };
}

rpc.exports = {
  run(command, threadId, hwndText, expectedWindowPid, wakeWindowText = '0', expectedMeetingId = '') {
    if (command === 'entry-mute' || command === 'entry-camera-off' || command === 'entry-auto-audio') return onMainThread(threadId, () => {
      const name = command === 'entry-mute' ? 'MuteVoIPWhenJoinMeeting' : command === 'entry-auto-audio' ? 'AutoJoinVoIP' : 'TurnOffVideoCameraOnJoin';
      const before = readBooleanPreference(name);
      if (before.returnRaw !== 1 || ![0, 1].includes(before.valueRaw)) throw new Error('Cannot verify entry preference');
      const value = Memory.alloc(4); value.writeS32(1);
      const biz = Process.getModuleByName('cmmbiz.dll');
      const updateReturnRaw = new NativeFunction(biz.getExportByName('?UpdateUserSettingAsBoolean@Cmm@@YAHW4zPolicyId@zpref@@AEBHHPEAVIPolicyUpdateObserver@3@@Z'),
        'int', ['int', 'pointer', 'int', 'pointer'], 'win64')(before.policyId, value, 1, ptr(0));
      return { command, before, updateReturnRaw, after: readBooleanPreference(name) };
    }, wakeWindowText);
    if (command === 'entry-preferences') return onMainThread(threadId, () => ({ command,
      preferences: ['AlwaysShowVideoPreviewDialog', 'TurnOffVideoCameraOnJoin', 'MuteVoIPWhenJoinMeeting', 'AutoJoinVoIP'].map(readBooleanPreference)
    }), wakeWindowText);
    if (command === 'preview-policy' || command === 'preview-disable' || command === 'preview-enable') return onMainThread(threadId, () => {
      const biz = Process.getModuleByName('cmmbiz.dll');
      const id = new NativeFunction(biz.getExportByName('?QueryIDViaKnownStr@zpref@@YA?AW4zPolicyId@1@PEBD@Z'), 'int', ['pointer'], 'win64')(
        Memory.allocUtf8String('AlwaysShowVideoPreviewDialog'));
      if (id === 0x370 || id < 0 || id > 0x36f) throw new Error('Preview setting name is not recognized');
      const value = Memory.alloc(4); value.writeS32(-1);
      const flags = [Memory.alloc(8), Memory.alloc(8), Memory.alloc(8)];
      for (const flag of flags) flag.writeU64(0);
      const query = new NativeFunction(biz.getExportByName('?QueryBooleanPolicyValueFromMemory@Cmm@@YAHW4zPolicyId@zpref@@AEAHPEA_N22@Z'),
        'int', ['int', 'pointer', 'pointer', 'pointer', 'pointer'], 'win64');
      const result = query(id, value, ...flags);
      const provider = new NativeFunction(biz.getExportByName('?GetPolicyProvider@zpref@@YAPEAVIPolicyProvider@1@XZ'), 'pointer', [], 'win64')();
      const state = { command, processId: Process.id, threadId: Process.getCurrentThreadId(), policyId: id,
        returnRaw: result, valueRaw: value.readS32(), flagsRaw: flags.map(f => f.readU8()), providerPresent: !provider.isNull() };
      if (command !== 'preview-policy') {
        if (id !== 236 || result !== 1 || !state.providerPresent || ![0, 1].includes(state.valueRaw))
          throw new Error('Cannot verify the existing user preference; no update made');
        const desired = command === 'preview-disable' ? 0 : 1;
        value.writeS32(desired);
        state.updateReturnRaw = new NativeFunction(biz.getExportByName('?UpdateUserSettingAsBoolean@Cmm@@YAHW4zPolicyId@zpref@@AEBHHPEAVIPolicyUpdateObserver@3@@Z'),
          'int', ['int', 'pointer', 'int', 'pointer'], 'win64')(id, value, 1, ptr(0));
        state.desired = desired;
      }
      return state;
    }, wakeWindowText);
    return onMainThread(threadId, () => {
      const before = videoState();
      if (expectedMeetingId && command !== 'query' && (before.meetingIdRaw !== expectedMeetingId || before.inMeetingRaw !== 1 || before.conferenceReadyRaw !== 1))
        throw new Error('Meeting identity or readiness changed; command refused');
      const { module, helper } = bridgeContext();
      const result = { command, threadId: Process.getCurrentThreadId(), before };
      result.settingsBefore = sharingSettings(module, helper);
      if (command === 'query') {
        const flags = Memory.alloc(8); flags.writeU64(0);
        result.canStartRaw = new NativeFunction(module.base.add(0x3fac0), 'int', ['pointer', 'pointer'], 'win64')(helper, flags);
        const { meeting } = bridgeContext();
        const info = readPointer(meeting.add(0x2a58));
        if (!info.isNull() && readPointer(info).equals(module.base.add(0x197b50))) {
          result.participantsCountRaw = new NativeFunction(module.base.add(0x6f920), 'int', ['pointer', 'int'], 'win64')(info, 0);
        }
        return result;
      }
      if (command === 'confirm-preview') {
        if (before.inMeetingRaw !== 0) throw new Error('Meeting already active; preview confirmation refused');
        const meeting = new NativeFunction(module.getExportByName('GetActiveMeeting'), 'pointer', [], 'win64')();
        const meetingHelper = readPointer(meeting.add(0x2a58));
        if (meetingHelper.isNull() || !readPointer(meetingHelper).equals(module.base.add(0x197b50)))
          throw new Error('Unexpected meeting helper');
        const preview = meetingHelper.add(8);
        if (!readPointer(preview).equals(module.base.add(0x197ab8))) throw new Error('Unexpected preview interface');
        // Bridge forwards these flags to fields logged as audio_on/video_on.
        result.returnRaw = new NativeFunction(module.base.add(0x70c30), 'int',
          ['pointer', 'pointer', 'int', 'int'], 'win64')(preview, ptr(0), 0, 0);
        result.audioOn = false;
        result.videoOn = false;
        result.after = videoState();
        return result;
      }
      if (before.inMeetingRaw !== 1 || before.conferenceReadyRaw !== 1)
        throw new Error('Meeting is not fully ready');
      if (command === 'leave') {
        if (!expectedMeetingId || before.meetingIdRaw !== expectedMeetingId) throw new Error('Explicit meeting required for leave');
        const meeting = new NativeFunction(module.getExportByName('GetActiveMeeting'), 'pointer', [], 'win64')();
        const info = readPointer(meeting.add(0x2a58));
        if (!readPointer(info).equals(module.base.add(0x197b50))) throw new Error('Unexpected meeting info');
        const commands = info.add(8);
        if (!readPointer(commands).equals(module.base.add(0x197ab8))) throw new Error('Unexpected meeting commands');
        new NativeFunction(module.base.add(0x667e0), 'void', ['pointer', 'int'], 'win64')(commands, 0);
        return { command, dispatched: true, effectConfirmed: false };
      }
      if (command === 'leave-alone') {
        if (before.meetingIdRaw !== '1234567890' || before.sendingSource !== '0x0' || before.shareStatusRaw !== 0)
          throw new Error('Research leave requires the authorized room without sharing');
        const { meeting } = bridgeContext();
        const info = readPointer(meeting.add(0x2a58));
        if (!readPointer(info).equals(module.base.add(0x197b50))) throw new Error('Unexpected meeting info');
        const count = new NativeFunction(module.base.add(0x6f920), 'int', ['pointer', 'int'], 'win64')(info, 0);
        const data = readPointer(info.sub(8));
        const users = readPointer(data.add(0x80));
        const countAddress = readPointer(readPointer(users).add(0x10));
        const executable = Process.findRangeByAddress(countAddress);
        if (!executable || !executable.protection.includes('x')) throw new Error('Invalid user count function');
        const total = new NativeFunction(countAddress, 'uint', ['pointer'], 'win64')(users);
        if (count !== 1 || total !== 1) throw new Error('Leave test requires exactly one user');
        const commands = info.add(8);
        if (!readPointer(commands).equals(module.base.add(0x197ab8))) throw new Error('Unexpected meeting commands');
        result.participantsCountRaw = count; result.totalUsersRaw = total;
        new NativeFunction(module.base.add(0x667e0), 'void', ['pointer', 'int'], 'win64')(commands, 0);
        result.dispatched = true;
        return result; // Context may be destroyed after this call; do not query it again.
      }
      if (command === 'start') {
        if (before.sendingSource !== '0x0') throw new Error('An existing share is already active');
        const hwnd = ptr(hwndText);
        const isWindow = new NativeFunction(Process.getModuleByName('user32.dll').getExportByName('IsWindow'), 'int', ['pointer'], 'win64');
        if (!isWindow(hwnd)) throw new Error('Target HWND is no longer valid');
        const user32 = Process.getModuleByName('user32.dll');
        const ownerPid = Memory.alloc(4);
        new NativeFunction(user32.getExportByName('GetWindowThreadProcessId'), 'uint', ['pointer', 'pointer'], 'win64')(hwnd, ownerPid);
        const title = Memory.alloc(512);
        new NativeFunction(user32.getExportByName('GetWindowTextW'), 'int', ['pointer', 'pointer', 'int'], 'win64')(hwnd, title, 256);
        if (ownerPid.readU32() !== expectedWindowPid || title.readUtf16String() !== 'JW Library')
          throw new Error('JW Library target identity changed');
        result.target = { hwnd: hwnd.toString(), pid: ownerPid.readU32(), title: title.readUtf16String() };
        const items = Memory.alloc(8); items.writePointer(hwnd);
        const vector = Memory.alloc(24);
        vector.writePointer(items); vector.add(8).writePointer(items.add(8)); vector.add(16).writePointer(items.add(8));
        const start = new NativeFunction(module.base.add(0x3fcc0), 'int', ['pointer', 'pointer'], 'win64');
        const started = Date.now();
        result.returnRaw = start(helper, vector);
        result.callElapsedMs = Date.now() - started;
        result.hwnd = hwnd.toString();
      } else if (command === 'stop') {
        const started = Date.now();
        new NativeFunction(module.base.add(0x42d80), 'void', ['pointer', 'pointer'], 'win64')(helper, ptr(0));
        result.callElapsedMs = Date.now() - started;
      } else if (command === 'configure-video' || command === 'configure-image' || command === 'configure-video-muted') {
        const enabled = command === 'configure-image' ? 0 : 1;
        for (const rva of [0x412a0, 0x47a50])
          new NativeFunction(module.base.add(rva), 'void', ['pointer', 'int', 'int'], 'win64')(helper,
            rva === 0x412a0 ? Number(command === 'configure-video') : enabled, 0);
      } else if (command === 'optimize' || command === 'audio') {
        const rva = command === 'optimize' ? 0x47a50 : 0x412a0;
        new NativeFunction(module.base.add(rva), 'void', ['pointer', 'int', 'int'], 'win64')(helper, 1, 0);
      } else throw new Error('Unknown research command');
      result.after = videoState();
      result.settingsAfter = sharingSettings(module, helper);
      return result;
    }, wakeWindowText);
  },
  inventory() {
    return { processId: Process.id, architecture: Process.arch,
      modules: Process.enumerateModules().filter(m => /^(zoom_meeting_bridge|zVideoUI|zVideoApp|zVideoAppPlugin|zWebService|zUIClient|zToolSuiteIPCHost|Cmmlib|cmmbiz)\.dll$/i.test(m.name))
        .map(m => ({ name: m.name, path: m.path, base: m.base.toString(), size: m.size })),
      threads: Process.enumerateThreads().map(t => ({ id: t.id, state: t.state })) };
  },
  status() {
    const module = Process.getModuleByName('zoom_meeting_bridge.dll');
    const entry = module.getExportByName('GetActiveMeeting');
    if (!entry.equals(module.base.add(0x23390))) throw new Error('Unexpected getter RVA');
    const initialized = module.base.add(0x21ca38).readPointer();
    const result = { kind: 'bridge-meeting-query', processId: Process.id,
      bridgeRoot: initialized.toString(), initialized: !initialized.isNull(),
      meeting: null, helper: null, limitations: ['No sharing commands were executed.'] };
    if (initialized.isNull()) return result;
    const meeting = new NativeFunction(entry, 'pointer', [], 'win64')();
    result.meeting = meeting.toString();
    if (meeting.isNull()) return result;
    const table = readPointer(meeting);
    const helperGetter = readPointer(table.add(0x88));
    const owner = Process.findModuleByAddress(helperGetter);
    result.meetingVtable = table.toString();
    result.helperGetter = { address: helperGetter.toString(), module: owner?.name,
      rva: owner ? helperGetter.sub(owner.base).toString() : null };
    if (helperGetter.equals(module.base.add(0x1be30))) {
      const helper = readPointer(meeting.add(0x29c8));
      if (!helper.isNull()) {
        const table = readPointer(helper);
        result.helper = { interface: helper.toString(), vtableRva: table.sub(module.base).toString(),
          expected: table.equals(module.base.add(0x195b90)) };
      }
    }
    return result;
  },
};
