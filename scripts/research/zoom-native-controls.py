"""Offline plans by default. Native controls are isolated from the official app."""
import argparse
import importlib.util
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
CATALOG = json.loads((HERE / 'zoom-native-controls.json').read_text(encoding='utf-8'))


def make_plan(command, meeting_id, participant_id=None, allow_unmute=None):
    definition = CATALOG['commands'][command]
    if not isinstance(meeting_id, str) or not re.fullmatch(r'\d{9,11}', meeting_id, re.ASCII):
        raise ValueError('An explicit meeting ID is required')
    arguments = []
    for field in definition['args']:
        if isinstance(field, int):
            arguments.append(field)
        elif field == 'participantId':
            if type(participant_id) is not int or not 0 < participant_id <= 0xffffffff:
                raise ValueError('A current, nonzero uint32 participant ID is required')
            arguments.append(participant_id)
        elif field == 'allowUnmute':
            if type(allow_unmute) is not bool:
                raise ValueError('Specify allow-unmute as true or false explicitly')
            arguments.append(int(allow_unmute))
        else:
            raise ValueError('Unsupported catalog argument')
    return {'command': command, 'meetingId': meeting_id, 'participantId': participant_id,
            'allowUnmute': allow_unmute, 'arguments': arguments, 'roleRequired': definition['role'],
            'meaning': definition['meaning'], 'validation': definition['validation'],
            'evidence': definition['evidence'], 'mutates': definition['mutates'],
            'execute': False, 'attachedToZoom': False}


def execute_plan(plan, pid=None, thread=None):
    if (pid is None) != (thread is None):
        raise ValueError('Supply both pid and thread, or neither')
    # Importing the Frida runner and discovery happens only after --execute.
    spec = importlib.util.spec_from_file_location('native_bridge_controls', HERE / 'zoom-bridge-probe.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    if pid is None:
        spec = importlib.util.spec_from_file_location('native_controls_discovery', HERE / 'zoom-native-discovery.py')
        discovery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(discovery)
        target = discovery.discover_one()
        pid, thread = target['pid'], target['thread']
    with bridge.BridgeClient(pid, controls=True) as client:
        client.verify('zoom_meeting_bridge.dll', CATALOG['bridgeSha256'])
        client.verify('zVideoUI.dll', 'bd40c94d3eb1118e1c89e0216f6902f86b12eb9babf138ab05c844e98aef7749')
        client.verify('Cmmlib.dll', '9142c8d94f3e5ef8b61f2499e101d647f5623bd05b10ab903ee9d231c7a5d246')
        request = {**plan, 'execute': True}
        return client.script.exports_sync.control(request, thread, client.wake_window(thread))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=CATALOG['commands'])
    parser.add_argument('--meeting-id', required=True)
    parser.add_argument('--participant-id', type=int)
    parser.add_argument('--allow-unmute', choices=('true', 'false'))
    parser.add_argument('--execute', action='store_true', help='Execute in Zoom; omission only prints an offline plan')
    parser.add_argument('--pid', type=int)
    parser.add_argument('--thread', type=int)
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    allow = None if args.allow_unmute is None else args.allow_unmute == 'true'
    try:
        plan = make_plan(args.command, args.meeting_id, args.participant_id, allow)
        result = execute_plan(plan, args.pid, args.thread) if args.execute else plan
    except (ValueError, RuntimeError) as error:
        parser.error(str(error))
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered, encoding='utf-8')
    print(rendered)


if __name__ == '__main__':
    main()
