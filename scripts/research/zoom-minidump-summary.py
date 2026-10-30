"""Read-only MINIDUMP metadata; no process execution or dump upload."""
import hashlib
import json
import pathlib
import struct
import sys

path = pathlib.Path(sys.argv[1])
data = path.read_bytes()
u32 = lambda p: struct.unpack_from('<I', data, p)[0]
u64 = lambda p: struct.unpack_from('<Q', data, p)[0]
if data[:4] != b'MDMP':
    raise RuntimeError('Not a Windows minidump')
streams = {u32(u32(12) + i * 12): (u32(u32(12) + i * 12 + 4), u32(u32(12) + i * 12 + 8)) for i in range(u32(8))}
modules = []
if 4 in streams:
    start = streams[4][1]
    for i in range(u32(start)):
        p = start + 4 + i * 108
        name_at = u32(p + 20)
        name = data[name_at + 4:name_at + 4 + u32(name_at)].decode('utf-16le', errors='replace')
        modules.append({'name': pathlib.PureWindowsPath(name).name, 'base': u64(p), 'size': u32(p + 8)})
def locate(address):
    m = next((m for m in modules if m['base'] <= address < m['base'] + m['size']), None)
    return {'address': hex(address), 'module': m['name'] if m else None, 'rva': hex(address - m['base']) if m else None}
result = {'kind': 'supplementary-windows-minidump-metadata', 'path': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'streams': list(streams)}
if 6 in streams:
    p = streams[6][1]
    thread = u32(p)
    result['exception'] = {'threadId': thread, 'code': hex(u32(p + 8)), 'instruction': locate(u64(p + 24)),
                           'parameters': [hex(u64(p + 40 + i * 8)) for i in range(min(15, u32(p + 32)))]}
    if 3 in streams:
        start = streams[3][1]
        for i in range(u32(start)):
            q = start + 4 + i * 48
            if u32(q) == thread:
                length, rva = u32(q + 32), u32(q + 36)
                candidates = []
                for at in range(rva, min(rva + length, len(data)) - 7, 8):
                    target = locate(u64(at))
                    if target['module']:
                        candidates.append(target)
                        if len(candidates) == 30:
                            break
                result['stackModulePointerCandidates'] = candidates
result['limitations'] = ['Not REA Evidence.', 'Stack pointer candidates are not a verified unwound call stack.', 'Only metadata is decoded; no memory strings or credentials are emitted.']
print(json.dumps(result, indent=2))
