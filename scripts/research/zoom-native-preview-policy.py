"""User-scoped documented Zoom preview configuration, with compare-and-restore.

No SDK, UI automation, administrator registry hive, or process termination.
https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065466
"""
import argparse
import datetime
import json
import pathlib
import winreg

ROOT = pathlib.Path(__file__).resolve().parents[2]
KEY = r'Software\Policies\Zoom\Zoom Meetings\Meetings'
NAME = 'AlwaysShowVideoPreviewDialog'
BACKUP = ROOT / 'runtime/data/zoom-native-research/preview-policy-backup.json'

def read():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY) as key:
            value, kind = winreg.QueryValueEx(key, NAME)
            return {'present': True, 'value': value, 'type': kind}
    except FileNotFoundError:
        return {'present': False}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['status', 'apply', 'restore'])
    args = parser.parse_args()
    before = read()
    if args.action == 'apply':
        if not BACKUP.exists():
            BACKUP.parent.mkdir(parents=True, exist_ok=True)
            record = {'hive': 'HKCU', 'key': KEY, 'name': NAME, 'before': before,
                      'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            with BACKUP.open('x', encoding='utf-8') as out:
                json.dump(record, out, indent=2)
        else:
            record = json.loads(BACKUP.read_text(encoding='utf-8'))
            if record.get('key') != KEY or record.get('name') != NAME:
                raise RuntimeError('Backup is for a different setting; no registry write made')
            if before != record['before'] and before != {'present': True, 'value': 0, 'type': winreg.REG_DWORD}:
                raise RuntimeError('Setting changed since backup; refusing to overwrite')
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, KEY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, NAME, 0, winreg.REG_DWORD, 0)
    elif args.action == 'restore':
        record = json.loads(BACKUP.read_text(encoding='utf-8'))
        if record.get('key') != KEY or record.get('name') != NAME:
            raise RuntimeError('Backup identity differs; no registry write made')
        if before != {'present': True, 'value': 0, 'type': winreg.REG_DWORD}:
            raise RuntimeError('Current setting is no longer our value; refusing restore')
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY, 0, winreg.KEY_SET_VALUE) as key:
            old = record['before']
            if old['present']:
                winreg.SetValueEx(key, NAME, 0, old['type'], old['value'])
            else:
                winreg.DeleteValue(key, NAME)
    print(json.dumps({'action': args.action, 'hive': 'HKCU', 'key': KEY, 'name': NAME,
                      'before': before, 'after': read(), 'backup': str(BACKUP)}))

if __name__ == '__main__':
    main()
