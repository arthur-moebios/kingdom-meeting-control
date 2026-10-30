"""Bounded experimental JW -> native Zoom controller. Does not change official app."""
import argparse
import ctypes
import importlib.util
import json
import os
import pathlib
import queue
import re
import subprocess
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

BridgeClient = load('bridge_probe', 'zoom-bridge-probe.py').BridgeClient
MediaPolicy = load('media_policy', 'zoom-native-media-policy.py').MediaPolicy
MediaObservationFusion = load('media_fusion', 'zoom-native-media-policy.py').MediaObservationFusion
discover_one = load('zoom_discovery', 'zoom-native-discovery.py').discover_one

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int)
    parser.add_argument('--thread', type=int)
    parser.add_argument('--meeting-id', required=True)
    parser.add_argument('--duration', type=float, default=120)
    parser.add_argument('--log', type=pathlib.Path, required=True)
    parser.add_argument('--adopt-source', help='Exact source pointer from a share previously started by this research probe')
    parser.add_argument('--auto-admit', action='store_true')
    parser.add_argument('--no-share', action='store_true')
    parser.add_argument('--share-audio', choices=('true','false'), default='true')
    parser.add_argument('--observer-script', type=pathlib.Path)
    parser.add_argument('--managed', action='store_true', help='Run while the owning app keeps stdin open')
    args = parser.parse_args()
    stopping = threading.Event()
    requests = queue.Queue()
    if args.managed:
        def monitor_owner():
            import sys
            for line in sys.stdin:
                if line.strip() == 'stop':
                    break
                try:
                    requests.put(json.loads(line))
                except ValueError:
                    pass
            stopping.set()
        threading.Thread(target=monitor_owner, daemon=True).start()
    if not re.fullmatch(r'\d{9,11}', args.meeting_id, re.ASCII):
        parser.error('An explicit meeting ID is required')
    if (args.pid is None) != (args.thread is None):
        raise RuntimeError('Supply both --pid/--thread, or omit both for automatic discovery')
    if args.pid is None:
        connection = discover_one()
        args.pid, args.thread = connection['pid'], connection['thread']
    if not 1 <= args.duration <= 600:
        raise RuntimeError('Research runs must be bounded between 1 and 600 seconds')
    args.log.parent.mkdir(parents=True, exist_ok=True)
    log = args.log.open('a', encoding='utf-8', buffering=1)
    def emit(event, **data):
        nonlocal log
        row = json.dumps({'time': time.time(), 'event': event, **data}, ensure_ascii=False)
        print(row, flush=True)
        if log.tell() >= 10_000_000:
            log.close()
            os.replace(args.log, args.log.with_suffix(args.log.suffix + '.previous'))
            log = args.log.open('a', encoding='utf-8', buffering=1)
        log.write(row + '\n')

    user32 = ctypes.WinDLL('user32', use_last_error=True)
    user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    def owner_pid(hwnd):
        value = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(value))
        if not value.value:
            raise RuntimeError('JW HWND disappeared')
        return value.value

    samples = queue.Queue()
    observer = None
    playback_observer = None
    owned_source = None
    owned_hwnd = None
    desired = None
    pending_owned = False
    manual_paused = False
    def read_observer(process, source):
        for line in process.stdout:
            try:
                sample = json.loads(line)
                sample['source'] = source
                samples.put(sample)
            except (ValueError, TypeError):
                samples.put({'observerError': line.strip(), 'source': source})

    try:
        with BridgeClient(args.pid, controls=True) as client:
            def call(command, hwnd=None):
                started = time.monotonic()
                native_command = 'configure-video-muted' if command == 'configure-video' and args.share_audio == 'false' else command
                result = client.run(native_command, args.thread, hwnd, owner_pid(hwnd) if hwnd else None, args.meeting_id)
                emit('native_call', command=command, elapsedMs=round((time.monotonic() - started) * 1000, 2), result=result)
                return result
            initial = call('query')['before']
            if initial['inMeetingRaw'] != 1 or initial['conferenceReadyRaw'] != 1:
                raise RuntimeError('Join the test meeting before starting the media observer')
            if initial['meetingIdRaw'] != args.meeting_id:
                raise RuntimeError('Connected meeting differs from the selected test meeting')
            if not args.no_share and initial['sendingSource'] != '0x0':
                if args.adopt_source != initial['sendingSource']:
                    raise RuntimeError('Existing share not owned by this test; refusing takeover')
                owned_source = args.adopt_source
            # Observe media even when only manual sharing is enabled.
            def start_observer(source='uia'):
                script = args.observer_script or HERE.parent / 'win/watch-jw-media.ps1'
                if source == 'smtc':
                    script = script.with_name('watch-jw-playback.ps1')
                process = subprocess.Popen([
                    'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                    str(script), '-ParentId', str(os.getpid()), '-ReconcileMs', '100'
                ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                    text=True, encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NO_WINDOW)
                threading.Thread(target=read_observer, args=(process,source), daemon=True).start()
                return process
            observer = start_observer()
            playback_observer = start_observer('smtc')
            memory = load('automation_memory', 'zoom-native-memory.py')
            reader = memory.ProcessReader(args.pid)
            controls = load('automation_controls', 'zoom-native-controls.py')
            attempts = {}
            next_admit = 0
            policy = MediaPolicy()
            fusion = MediaObservationFusion()
            signals = {}
            started = time.monotonic()
            observer_deadline = started + 30
            playback_deadline = started + 30
            observer_ready = False
            next_reconcile = started
            latest_sample = None
            emit('watch_started', zoomPid=args.pid, observerPid=observer.pid if observer else None,
                 duration=args.duration, autoAdmit=args.auto_admit, autoShare=not args.no_share)
            try:
                while not stopping.is_set() and (args.managed or time.monotonic() - started < args.duration):
                    # Re-discover a new conference process instead of retaining a
                    # destroyed Frida script after leaving/reopening the room.
                    if not reader.is_alive() or client.session.is_detached or client.script.is_destroyed:
                        owned_source, pending_owned = None, False
                        raise RuntimeError('Zoom connection ended; controller must rediscover the meeting')
                    now = time.monotonic()
                    while not requests.empty():
                        request = requests.get_nowait()
                        try:
                            command = request.get('command')
                            if request.get('meetingId') != args.meeting_id:
                                raise RuntimeError('Command meeting differs from controller')
                            if command == 'share-start':
                                manual_paused = False
                                if not fusion.current(now) or not latest_sample or not latest_sample.get('active') or not latest_sample.get('mediaWindowHandle'):
                                    raise RuntimeError('Nenhuma mídia ativa identificada no JW Library')
                                state = call('query')['before']
                                if state['sendingSource'] != '0x0':
                                    raise RuntimeError('Já existe um compartilhamento ativo')
                                call('configure-video' if latest_sample['kind'] == 'video' else 'configure-image')
                                result = call('start', latest_sample['mediaWindowHandle'])
                                if result.get('returnRaw') != 1:
                                    raise RuntimeError('Zoom rejected sharing start')
                                owned_hwnd = latest_sample['mediaWindowHandle']
                                owned_source = result['after']['sendingSource']
                                if owned_source == '0x0':
                                    owned_source, pending_owned = None, True
                            elif command == 'share-stop':
                                state = call('query')['before']
                                if not owned_source or state['sendingSource'] != owned_source:
                                    raise RuntimeError('Compartilhamento não pertence a este controlador')
                                result = call('stop')
                                owned_source, owned_hwnd, pending_owned = None, None, False
                                manual_paused = True
                            elif command == 'leave':
                                result = call('leave')
                                owned_source, owned_hwnd, pending_owned = None, None, False
                                stopping.set()
                            elif command == 'launch-poll':
                                layout = memory.poll_layout(reader)
                                documents, guard = memory.pointer_vector(reader, layout['component'] + 0x40, 128)
                                wanted = request.get('pollName', '').strip()
                                selected = next((doc for doc in documents if not wanted or reader.cstring(doc + 0x30) == wanted), None)
                                if selected is None:
                                    raise RuntimeError('Enquete não encontrada')
                                memory.verify_vector(reader, guard)
                                client.verify('zVideoAppPlugin.dll', '67939de0ae3508071956204fc62b670bd51bd8b93c0d294b8f92ba4c0929e48f')
                                client.verify('zWebService.dll', 'c49409475e4a745ae10cd058fb66e19c2426105f479f0335149a0ba267c6ea45')
                                result = client.script.exports_sync.launchpoll({'meetingId': args.meeting_id,
                                    'component': hex(layout['component']), 'document': hex(selected)}, args.thread, client.wake_window(args.thread))
                            else:
                                if request.get('participantId') is not None:
                                    current_roster = memory.participant_snapshot(reader)
                                    current_people = current_roster['waitingRoom'] if command == 'admit-participant' else current_roster['participants']
                                    if not any(person['id'] == str(request['participantId']) for person in current_people):
                                        raise RuntimeError('Participante não está mais na lista atual')
                                plan = controls.make_plan(command, args.meeting_id, request.get('participantId'), request.get('allowUnmute'))
                                result = client.script.exports_sync.control({**plan, 'execute': True}, args.thread, client.wake_window(args.thread))
                            emit('command_result', id=request.get('id'), result=result)
                        except Exception as error:
                            emit('command_result', id=request.get('id'), error=str(error))
                    if args.auto_admit and now >= next_admit and not stopping.is_set():
                        next_admit = now + 0.5
                        try:
                            roster = memory.participant_snapshot(reader)
                            present = {p['id'] for p in roster['participants']}
                            for identity in list(attempts):
                                if identity in present:
                                    emit('admission_confirmed', participantId=identity)
                                    del attempts[identity]
                            for person in roster['waitingRoom']:
                                identity = person['id']
                                if now - attempts.get(identity, -100) < 5:
                                    continue
                                plan = controls.make_plan('admit-participant', args.meeting_id, int(identity))
                                outcome = client.script.exports_sync.control(
                                    {**plan, 'execute': True}, args.thread, client.wake_window(args.thread))
                                attempts[identity] = now
                                emit('admission_requested', participantId=identity, result=outcome)
                            emit('admission_observation', waiting=len(roster['waitingRoom']))
                        except Exception as error:
                            emit('admission_error', message=str(error))
                    try:
                        sample = samples.get(timeout=0.05)
                        if 'observerError' in sample:
                            emit('observer_warning' if fusion.current(now) is not None else 'observer_error', message=sample['observerError'])
                        else:
                            source = sample.get('source','uia')
                            signature = tuple(sample.get(key) for key in ('active','kind','mediaWindowHandle','playbackStatus'))
                            if signals.get(source) != signature:
                                signals[source] = signature
                                emit('media_signal', source=source, sample=sample)
                            if sample.get('source') == 'smtc':
                                playback_deadline = now + 15
                            else:
                                observer_deadline = now + 15
                            sample = fusion.observe(sample, now)
                            if sample is None:
                                continue
                            latest_sample = sample
                            if not observer_ready:
                                emit('observer_recovered')
                            observer_ready = True
                            intent = policy.observe(sample, now)
                            if intent is not None:
                                manual_paused = False
                                desired = intent
                                next_reconcile = now
                                emit('media_intent', hwnd=desired[0], kind=desired[1], source=sample.get('source','uia'))
                    except queue.Empty:
                        pass
                    if observer.poll() is not None or now >= observer_deadline:
                        # UIA compilation/provider stalls are independent of the
                        # meeting. Recover only this child, preserving Zoom and
                        # any owned share until a valid media observation arrives.
                        emit('observer_warning' if fusion.current(now) is not None else 'observer_error', message='JW UIA detector unavailable; restarting detector only')
                        if observer.poll() is None:
                            observer.terminate()
                            try:
                                observer.wait(timeout=1)
                            except subprocess.TimeoutExpired:
                                observer.kill()
                                observer.wait(timeout=1)
                        observer = start_observer()
                        observer_deadline = time.monotonic() + 30
                    if playback_observer.poll() is not None or now >= playback_deadline:
                        if playback_observer.poll() is None:
                            playback_observer.kill()
                            playback_observer.wait(timeout=1)
                        playback_observer = start_observer('smtc')
                        playback_deadline = time.monotonic() + 30
                    if now < next_reconcile:
                        continue
                    next_reconcile = now + 1
                    try:
                        state = call('query')['before']
                        if state['meetingIdRaw'] != args.meeting_id:
                            owned_source, pending_owned = None, False
                            stopping.set()
                            raise RuntimeError('Meeting changed; refusing media commands')
                        # Keep the meeting heartbeat alive even before the first
                        # media sample or after a deliberate manual share stop.
                        if not observer_ready or fusion.current(now) is None or desired is None or manual_paused:
                            continue
                        source = state['sendingSource']
                        if pending_owned and source != '0x0':
                            owned_source, pending_owned = source, False
                        if owned_source and source not in ('0x0', owned_source):
                            emit('ownership_lost', source=source)
                            owned_source, owned_hwnd = None, None
                        if owned_source and owned_hwnd is None:
                            owned_hwnd = desired[0]
                        if (owned_source or pending_owned) and (desired[0] is None or desired[0] != owned_hwnd):
                            call('stop')
                            owned_source, owned_hwnd, pending_owned = None, None, False
                            source = '0x0'
                        if desired[0] is None:
                            continue
                        if source != '0x0' and owned_source is None:
                            emit('foreign_share_present')
                            continue
                        wanted = 'configure-video' if desired[1] == 'video' else 'configure-image'
                        # Reconfigure on transitions, including image -> video with the same HWND.
                        if policy.current != getattr(policy, 'configured', None):
                            call(wanted)
                            policy.configured = policy.current
                        if source == '0x0' and not pending_owned and not args.no_share:
                            result = call('start', desired[0])
                            if result.get('returnRaw') != 1:
                                raise RuntimeError('Zoom rejected sharing start')
                            owned_hwnd = desired[0]
                            owned_source = result['after']['sendingSource']
                            if owned_source == '0x0':
                                owned_source, pending_owned = None, True
                            next_reconcile = time.monotonic() + 0.05
                    except Exception as error:
                        emit('reconcile_error', message=str(error))
            finally:
                if reader:
                    reader.close()
                if owned_source or pending_owned:
                    final = call('query')['before']
                    current = final['sendingSource']
                    if final['meetingIdRaw'] == args.meeting_id and owned_source and current == owned_source:
                        call('stop')
                emit('watch_stopped')
    finally:
        if observer is not None:
            observer.terminate()
            observer.wait(timeout=5)
        if playback_observer is not None:
            playback_observer.terminate()
            playback_observer.wait(timeout=5)
        log.close()

if __name__ == '__main__':
    main()
