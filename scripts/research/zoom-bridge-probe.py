"""Version-checked research probe; detaches without terminating Zoom."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import pathlib
import os
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, os.environ.get('KMC_NATIVE_TOOLS', str(ROOT / 'runtime/data/zoom-native-tools')))
BRIDGE_SHA = '417c53cd26dfd8c24d6b9225db18bdc4fc03ec198aa2dac8f61c80322bc5f2b2'

class BridgeClient:
    def __init__(self, pid, controls=False):
        self.pid = pid
        self.controls = controls
        self.session = None
        self.script = None
        spec = importlib.util.spec_from_file_location('zoom_window_inventory', pathlib.Path(__file__).with_name('zoom-native-windows.py'))
        self.windows = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.windows)

    def wake_window(self, thread):
        windows = [w for w in self.windows.windows_for_process(self.pid) if w['threadId'] == thread]
        preferred = next((w for w in windows if w['className'] in ('ConfMultiTabContentWndClass', 'ZPPTMainFrmWndClassEx')), None)
        return str(preferred['hwnd'] if preferred else windows[0]['hwnd'] if windows else 0)

    def __enter__(self):
        import frida
        self.session = frida.attach(self.pid)
        try:
            source = pathlib.Path(__file__).with_suffix('.js').read_text(encoding='utf-8')
            if self.controls:
                folder = pathlib.Path(__file__).parent
                catalog = json.loads((folder / 'zoom-native-controls.json').read_text(encoding='utf-8'))
                source += '\nconst NATIVE_CONTROL_CATALOG = ' + json.dumps(catalog) + ';\n'
                source += (folder / 'zoom-native-controls.js').read_text(encoding='utf-8')
            self.script = self.session.create_script(source)
            self.script.load()
            self.inventory = self.script.exports_sync.inventory()
            for module in self.inventory['modules']:
                module['sha256'] = hashlib.sha256(pathlib.Path(module['path']).read_bytes()).hexdigest()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        try:
            if self.script is not None and not self.script.is_destroyed:
                self.script.unload()
        finally:
            if self.session is not None and not self.session.is_detached:
                self.session.detach()

    def verify(self, name, expected):
        module = next((m for m in self.inventory['modules'] if m['name'].lower() == name.lower()), None)
        if module is None or module['sha256'] != expected:
            raise RuntimeError(f'Unverified {name}; native operation refused')

    def run(self, command, thread=None, hwnd=None, window_pid=None, meeting_id=None):
        if command in ('preview-policy', 'preview-disable', 'preview-restore', 'entry-preferences', 'entry-mute', 'entry-camera-off', 'entry-auto-audio'):
            self.verify('cmmbiz.dll', '89e9cddcad6a87deb89ce5fe45019cf68060ba5643647f2ad8bc0c1205e89c33')
            self.verify('Cmmlib.dll', '9142c8d94f3e5ef8b61f2499e101d647f5623bd05b10ab903ee9d231c7a5d246')
            if thread is None:
                raise RuntimeError('--thread is required')
            invoke = lambda action: self.script.exports_sync.run(action, thread, '0', 0, self.wake_window(thread))
            if command == 'entry-preferences':
                return invoke(command)
            if command in ('entry-mute', 'entry-camera-off', 'entry-auto-audio'):
                preferences = invoke('entry-preferences')
                backup = ROOT / ('runtime/data/zoom-native-research/entry-audio-preferences-backup.json' if command == 'entry-auto-audio' else 'runtime/data/zoom-native-research/entry-native-preferences-backup.json')
                if not backup.exists():
                    with backup.open('x', encoding='utf-8') as out:
                        json.dump(preferences, out, indent=2)
                return invoke(command)
            before = invoke('preview-policy')
            if command == 'preview-policy':
                return before
            if before['returnRaw'] != 1 or before['policyId'] != 236:
                raise RuntimeError('Cannot read original preference; no update made')
            backup = ROOT / 'runtime/data/zoom-native-research/preview-native-preference-backup.json'
            if command == 'preview-disable':
                desired = 0
                if not backup.exists():
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    with backup.open('x', encoding='utf-8') as out:
                        json.dump({'name': 'AlwaysShowVideoPreviewDialog', 'original': before,
                                   'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}, out, indent=2)
            else:
                stored = json.loads(backup.read_text(encoding='utf-8'))
                if stored.get('name') != 'AlwaysShowVideoPreviewDialog' or stored['original']['policyId'] != 236:
                    raise RuntimeError('Backup does not match this preference')
                desired = stored['original']['valueRaw']
                if desired not in (0, 1):
                    raise RuntimeError('Original preference is not boolean')
            if before['valueRaw'] == desired:
                return {'command': command, 'changed': False, 'confirmed': True, 'before': before, 'after': before}
            update = invoke('preview-disable' if desired == 0 else 'preview-enable')
            after = before
            for _ in range(20):
                after = invoke('preview-policy')
                if after['returnRaw'] == 1 and after['valueRaw'] == desired:
                    break
                time.sleep(0.05)
            return {'command': command, 'changed': True, 'confirmed': after['returnRaw'] == 1 and after['valueRaw'] == desired,
                    'before': before, 'update': update, 'after': after, 'backup': str(backup)}
        self.verify('zoom_meeting_bridge.dll', BRIDGE_SHA)
        if command == 'status':
            return {'inventory': self.inventory, 'status': self.script.exports_sync.status()}
        self.verify('zVideoUI.dll', 'bd40c94d3eb1118e1c89e0216f6902f86b12eb9babf138ab05c844e98aef7749')
        self.verify('Cmmlib.dll', '9142c8d94f3e5ef8b61f2499e101d647f5623bd05b10ab903ee9d231c7a5d246')
        if command == 'confirm-preview':
            self.verify('zVideoApp.dll', '013b84868cb1d2d6c1a45359194d7e090bad87cd1e0ef7e46eba9efbf2f3d2c6')
        if thread is None or (command == 'start' and (not hwnd or not window_pid)):
            raise RuntimeError('--thread is required; start also requires --hwnd and --window-pid')
        return self.script.exports_sync.run(command, thread, str(hwnd or 0), window_pid or 0, self.wake_window(thread), meeting_id or '')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', required=True, type=int)
    parser.add_argument('--command', choices=['inventory', 'status', 'query', 'start', 'stop', 'optimize', 'audio', 'confirm-preview', 'configure-video', 'configure-image', 'preview-policy', 'preview-disable', 'preview-restore', 'entry-preferences', 'entry-mute', 'entry-camera-off', 'entry-auto-audio', 'leave-alone'], default='inventory')
    parser.add_argument('--thread', type=int)
    parser.add_argument('--hwnd', type=int)
    parser.add_argument('--window-pid', type=int)
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    with BridgeClient(args.pid) as client:
        result = client.inventory if args.command == 'inventory' else client.run(args.command, args.thread, args.hwnd, args.window_pid)
        if args.output:
            args.output.write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result))

if __name__ == '__main__':
    main()
