// Appended only by the separate controls runner. Catalog is injected from the
// adjacent, version-pinned JSON; callers cannot supply native addresses.
function validateControlRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('Control request required');
  const command = Object.prototype.hasOwnProperty.call(NATIVE_CONTROL_CATALOG.commands, request.command)
    ? NATIVE_CONTROL_CATALOG.commands[request.command] : null;
  if (!command) throw new Error('Unknown control command');
  if (request.execute !== true) throw new Error('Explicit execution required');
  if (typeof request.meetingId !== 'string' || !/^\d{9,11}$/.test(request.meetingId))
    throw new Error('Explicit meeting ID required');
  const args = command.args.map(arg => {
    if (typeof arg === 'number') return arg;
    if (arg === 'participantId') {
      if (!Number.isInteger(request.participantId) || request.participantId <= 0 || request.participantId > 0xffffffff)
        throw new Error('A current, nonzero uint32 participant ID is required');
      return request.participantId;
    }
    if (arg === 'allowUnmute') {
      if (typeof request.allowUnmute !== 'boolean') throw new Error('Explicit allowUnmute boolean required');
      return Number(request.allowUnmute);
    }
    throw new Error('Unsupported argument in control catalog');
  });
  return { command, args };
}

function controlMeeting() {
  const module = Process.getModuleByName('zoom_meeting_bridge.dll');
  const entry = module.getExportByName('GetActiveMeeting');
  if (!entry.equals(module.base.add(0x23390))) throw new Error('Unexpected meeting entry');
  const meeting = new NativeFunction(entry, 'pointer', [], 'win64')();
  if (meeting.isNull()) throw new Error('No active meeting');
  if (!NATIVE_CONTROL_CATALOG.meetingVtableRvas.some(rva => readPointer(meeting).equals(module.base.add(rva))))
    throw new Error('Unexpected meeting vtable');
  return { module, meeting };
}

function controlHelper(context, helperName) {
  const layout = NATIVE_CONTROL_CATALOG.helpers[helperName];
  const table = readPointer(context.meeting);
  const getter = readPointer(table.add(layout.getterSlot * Process.pointerSize));
  if (!getter.equals(context.module.base.add(layout.getterRva))) throw new Error('Unexpected helper getter');
  const stored = readPointer(context.meeting.add(layout.meetingOffset));
  if (stored.isNull()) throw new Error('Control helper not initialized');
  const instance = stored.add(layout.adjust);
  if (!readPointer(instance).equals(context.module.base.add(layout.vtableRva)))
    throw new Error('Unexpected control interface vtable');
  return instance;
}

function controlCall(context, definition, args) {
  const helper = controlHelper(context, definition.helper);
  const address = readPointer(readPointer(helper).add(definition.slot * Process.pointerSize));
  if (!address.equals(context.module.base.add(definition.rva))) throw new Error('Unexpected control method');
  const range = Process.findRangeByAddress(address);
  if (!range || !range.protection.includes('x')) throw new Error('Control method is not executable');
  return new NativeFunction(address, definition.returnType,
    ['pointer', ...args.map(() => 'uint')], 'win64')(helper, ...args);
}

function controlRole() {
  const module = Process.getModuleByName('zVideoUI.dll');
  const get = name => new NativeFunction(module.getExportByName(name), 'int', [], 'win64')();
  return { hostRaw: get('?IsHost@ConfUserBridge@@SAHXZ'), cohostRaw: get('?IsCoHost@ConfUserBridge@@SAHXZ') };
}

rpc.exports.control = function (request, threadId, wakeWindowText = '0') {
  const { command, args } = validateControlRequest(request);
  return onMainThread(threadId, () => {
    const before = videoState();
    if (before.meetingIdRaw !== request.meetingId) throw new Error('Meeting identity changed; command refused');
    if (before.inMeetingRaw !== 1 || before.conferenceReadyRaw !== 1) throw new Error('Meeting is not fully ready');
    const role = controlRole();
    if (command.role === 'host' && role.hostRaw !== 1) throw new Error('Host role required');
    if (command.role === 'host-or-cohost' && role.hostRaw !== 1 && role.cohostRaw !== 1)
      throw new Error('Host or cohost role required');
    const context = controlMeeting();
    if (command.role === 'can-reclaim-host') {
      const eligible = controlCall(context, NATIVE_CONTROL_CATALOG.commands['can-reclaim-host'], []);
      if (eligible !== 1) throw new Error('Native client does not allow reclaiming host');
    }
    const started = Date.now();
    const raw = controlCall(context, command, args);
    const elapsedMs = Date.now() - started;
    // Most wrappers are void and store an error in the bridge. A local
    // acceptance still does not prove that the remote participant changed.
    const acceptedLocally = command.mutates
      ? new NativeFunction(context.module.base.add(0x113b0), 'bool', [], 'win64')() : null;
    let bridgeErrorCodeRaw = null;
    if (command.mutates) {
      try {
        const errors = new NativeFunction(context.module.base.add(0x34994), 'pointer', [], 'win64')();
        const getter = readPointer(readPointer(errors).add(8));
        if (getter.compare(context.module.base) >= 0 && getter.compare(context.module.base.add(context.module.size)) < 0)
          bridgeErrorCodeRaw = new NativeFunction(getter, 'int', ['pointer'], 'win64')(errors);
      } catch { /* diagnostic only; acceptance still comes from the proven getter */ }
    }
    return { command: request.command, meetingId: before.meetingIdRaw, role, args,
      returnRaw: command.returnType === 'void' ? null : raw,
      acceptedLocally, bridgeErrorCodeRaw, effectConfirmed: false, callElapsedMs: elapsedMs,
      validation: command.validation };
  }, wakeWindowText);
};

// Start only: component slot 3 -> action 0. Caller derives the current document
// from the passive poll vector; revalidate membership on Zoom's UI thread.
rpc.exports.launchpoll = function (request, threadId, wakeWindowText = '0') {
  return onMainThread(threadId, () => {
    const before = videoState();
    if (before.meetingIdRaw !== request.meetingId || before.inMeetingRaw !== 1 || before.conferenceReadyRaw !== 1)
      throw new Error('Meeting identity/readiness changed');
    if (controlRole().hostRaw !== 1) throw new Error('Host role required for polls');
    const plugin = Process.getModuleByName('zVideoAppPlugin.dll');
    const web = Process.getModuleByName('zWebService.dll');
    const component = ptr(request.component), document = ptr(request.document);
    if (!readPointer(component).equals(plugin.base.add(0x43698)) || !readPointer(document).equals(web.base.add(0x709618)))
      throw new Error('Poll context changed');
    const begin = readPointer(component.add(0x40)), end = readPointer(component.add(0x48));
    let found = false, cursor = begin;
    for (let i = 0; i < 128 && cursor.compare(end) < 0; i++, cursor = cursor.add(8))
      if (readPointer(cursor).equals(document)) found = true;
    if (!found) throw new Error('Poll document no longer belongs to this meeting');
    const target = readPointer(readPointer(component).add(24));
    if (!target.equals(plugin.base.add(0x349a0))) throw new Error('Unexpected poll dispatcher');
    new NativeFunction(target, 'void', ['pointer', 'pointer'], 'win64')(component, document.add(8));
    return { command: 'launch-poll', dispatched: true, acceptedLocally: null, effectConfirmed: false };
  }, wakeWindowText);
};
