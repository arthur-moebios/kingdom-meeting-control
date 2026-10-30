"""Bounded ReadProcessMemory inspection; no injection, remote calls or writes."""
import ctypes as C
import ctypes.wintypes as W
import hashlib
import pathlib
import struct
import importlib.util


class ModuleEntry(C.Structure):
    _fields_ = [('dwSize', W.DWORD), ('th32ModuleID', W.DWORD), ('th32ProcessID', W.DWORD),
                ('GlblcntUsage', W.DWORD), ('ProccntUsage', W.DWORD),
                ('modBaseAddr', C.c_void_p), ('modBaseSize', W.DWORD), ('hModule', W.HMODULE),
                ('szModule', W.WCHAR * 256), ('szExePath', W.WCHAR * 260)]


class ProcessReader:
    def __init__(self, pid):
        self.pid = pid
        self.verified = {}
        self.kernel = C.WinDLL('kernel32', use_last_error=True)
        self.kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
        self.kernel.OpenProcess.restype = W.HANDLE
        self.kernel.CloseHandle.argtypes = [W.HANDLE]
        self.kernel.GetExitCodeProcess.argtypes = [W.HANDLE, C.POINTER(W.DWORD)]
        self.kernel.GetExitCodeProcess.restype = W.BOOL
        self.kernel.ReadProcessMemory.argtypes = [W.HANDLE, C.c_void_p, C.c_void_p, C.c_size_t, C.POINTER(C.c_size_t)]
        self.kernel.ReadProcessMemory.restype = W.BOOL
        self.kernel.CreateToolhelp32Snapshot.argtypes = [W.DWORD, W.DWORD]
        self.kernel.CreateToolhelp32Snapshot.restype = W.HANDLE
        self.kernel.Module32FirstW.argtypes = [W.HANDLE, C.POINTER(ModuleEntry)]
        self.kernel.Module32NextW.argtypes = [W.HANDLE, C.POINTER(ModuleEntry)]
        # No PROCESS_VM_WRITE, VM_OPERATION, CREATE_THREAD or SUSPEND_RESUME.
        self.handle = self.kernel.OpenProcess(0x1010, False, pid)
        if not self.handle:
            raise C.WinError(C.get_last_error())
        try:
            self.modules = self._modules()
        except BaseException:
            self.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None

    def is_alive(self):
        code = W.DWORD()
        return bool(self.handle and self.kernel.GetExitCodeProcess(self.handle, C.byref(code)) and code.value == 259)

    def _modules(self):
        snapshot = self.kernel.CreateToolhelp32Snapshot(0x18, self.pid)
        if snapshot == C.c_void_p(-1).value:
            raise C.WinError(C.get_last_error())
        try:
            entry = ModuleEntry()
            entry.dwSize = C.sizeof(entry)
            modules = []
            ok = self.kernel.Module32FirstW(snapshot, C.byref(entry))
            while ok:
                modules.append({'name': entry.szModule, 'path': entry.szExePath,
                                'base': entry.modBaseAddr, 'size': entry.modBaseSize})
                ok = self.kernel.Module32NextW(snapshot, C.byref(entry))
            return modules
        finally:
            self.kernel.CloseHandle(snapshot)

    def read(self, address, size):
        if not self.handle or type(address) is not int or address < 0x10000 or not 0 < size <= 1024 * 1024:
            raise ValueError('Invalid or excessive memory read')
        buffer = C.create_string_buffer(size)
        actual = C.c_size_t()
        if not self.kernel.ReadProcessMemory(self.handle, address, buffer, size, C.byref(actual)) or actual.value != size:
            raise C.WinError(C.get_last_error())
        return buffer.raw

    def ptr(self, address):
        return struct.unpack('<Q', self.read(address, 8))[0]

    def u32(self, address):
        return struct.unpack('<I', self.read(address, 4))[0]

    def module(self, name, sha256=None):
        found = [m for m in self.modules if m['name'].lower() == name.lower()]
        if len(found) != 1:
            raise RuntimeError('Expected one loaded module: ' + name)
        result = found[0]
        if sha256 and self.verified.get(name.lower()) != sha256:
            if hashlib.sha256(pathlib.Path(result['path']).read_bytes()).hexdigest() != sha256:
                raise RuntimeError('Unverified module version: ' + name)
            self.verified[name.lower()] = sha256
        return result

    def locate(self, address):
        module = next((m for m in self.modules if m['base'] <= address < m['base'] + m['size']), None)
        return {'module': module['name'], 'rva': hex(address - module['base'])} if module else None

    def cstring(self, address):
        # Cmmlib 7.1.9 c_str@CStringT<wchar_t> at RVA 0x5e60:
        # lea rax,[rcx+8]; cmp qword [rax+0x18],8; jb inline; mov rax,[rax].
        # Supplementary PE instruction evidence, not a remote function call.
        header = self.read(address, 40)
        length, capacity = struct.unpack_from('<QQ', header, 24)
        if length > 1024 or capacity < length or capacity > 1024 * 1024:
            raise ValueError('Invalid or excessive CString bounds')
        data = address + 8 if capacity < 8 else struct.unpack_from('<Q', header, 8)[0]
        raw = self.read(data, (length + 1) * 2)
        if raw[-2:] != b'\0\0' or self.read(address, 40) != header:
            raise ValueError('CString changed while reading')
        return raw[:-2].decode('utf-16le')


def raw_user_fields(reader, layout):
    video = reader.module('zVideoApp.dll', '013b84868cb1d2d6c1a45359194d7e090bad87cd1e0ef7e46eba9efbf2f3d2c6')
    reader.module('Cmmlib.dll', '9142c8d94f3e5ef8b61f2499e101d647f5623bd05b10ab903ee9d231c7a5d246')
    vector = reader.read(layout['users'] + 0x18, 24)
    begin, end, capacity = struct.unpack('<QQQ', vector)
    if end < begin or capacity < end or (end - begin) % 8 or (capacity - begin) % 8 or capacity - begin > 4096 * 8:
        raise ValueError('Invalid or excessive user vector')
    pointers = reader.read(begin, end - begin) if end != begin else b''
    users = []
    for (person,) in struct.iter_unpack('<Q', pointers):
        if reader.ptr(person) != video['base'] + 0x7490f0:
            raise ValueError('Unexpected user object vtable')
        fields = {hex(offset): reader.u32(person + offset) for offset in (0x2d8, 0x408, 0x410, 0x494, 0x498, 0x5a4, 0x5ac, 0x5b4)}
        if fields['0x2d8'] == 0:
            raise ValueError('Invalid zero participant ID')
        fields['stringCandidates'] = {hex(offset): reader.cstring(person + offset) for offset in (0x2f0, 0x340)}
        fields['displayGuardMethod'] = reader.locate(reader.ptr(reader.ptr(person) + 0x6c8))
        users.append(fields)
    if reader.read(layout['users'] + 0x18, 24) != vector or (end != begin and reader.read(begin, end - begin) != pointers):
        raise ValueError('User vector changed while reading')
    return users


def participant_snapshot(reader):
    layout = bridge_layout(reader)
    raw = raw_user_fields(reader, layout)
    participants, waiting = [], []
    for item in raw:
        # Bridge GetDisplayNameByNodeID -> CmmUser virtual +0xd0. The native
        # getter chooses the override at +0x340, fallback +0x2f0, unless hidden.
        hidden = bool(item['0x5a4'] & (1 << 22))
        name = '' if hidden else item['stringCandidates']['0x340'] or item['stringCandidates']['0x2f0']
        muted = {0: False, 1: True}.get(item['0x410'])
        person = {'id': str(item['0x2d8']), 'displayName': name,
                  'handRaised': {0: False, 1: True}.get(item['0x5ac']),
                  'isHost': {0: False, 1: True}.get(item['0x494']),
                  'isCoHost': {0: False, 1: True}.get(item['0x498']),
                  'isMuted': muted, 'audioTypeRaw': item['0x408'],
                  'audioStateRaw': item['0x410']}
        (waiting if item['0x5b4'] == 1 else participants).append(person)
    after = bridge_layout(reader)
    if any(layout[key] != after[key] for key in ('root', 'meeting', 'info', 'data', 'users')):
        raise ValueError('Meeting context changed while reading')
    return {'source': 'zoom-native-passive-memory', 'pid': reader.pid,
            'sessionToken': str(layout['meeting']) + ':' + str(layout['info']),
            'meetingId': None, 'participants': participants, 'waitingRoom': waiting,
            'partial': False, 'mutationsExecuted': 0,
            'limitations': ['Meeting ID is not yet decoded; session identity uses context pointers.',
                            'Hand order is detection time, not server time.',
                            'Live hands/roles/mute changes still require a controlled test.']}


def poll_layout(reader):
    ui = reader.module('zVideoUI.dll', 'bd40c94d3eb1118e1c89e0216f6902f86b12eb9babf138ab05c844e98aef7749')
    root = reader.ptr(ui['base'] + 0xd29b18)
    instance = reader.ptr(root + 0xd8)
    method = reader.locate(reader.ptr(reader.ptr(instance) + 0x20))
    if method != {'module': 'zVideoApp.dll', 'rva': '0x44bf0'}:
        raise ValueError('Unexpected conference holder getter')
    holder = reader.ptr(instance + 0x70)
    if reader.locate(reader.ptr(reader.ptr(holder) + 0x10)) != {'module': 'zVideoApp.dll', 'rva': '0x82a10'}:
        raise ValueError('Unexpected active conference resolver')
    video = reader.module('zVideoApp.dll', '013b84868cb1d2d6c1a45359194d7e090bad87cd1e0ef7e46eba9efbf2f3d2c6')
    manager = reader.ptr(video['base'] + 0x96e5d0)
    conference = reader.ptr(manager + 0x2a20)
    interface = conference + 0x2b0
    if reader.locate(reader.ptr(reader.ptr(interface))) != {'module': 'zVideoApp.dll', 'rva': '0x506d90'}:
        raise ValueError('Unexpected conference API interface')
    api = conference + 0x178
    if reader.locate(reader.ptr(reader.ptr(api) + 0x98)) != {'module': 'zVideoApp.dll', 'rva': '0x4f6790'}:
        raise ValueError('Unexpected poll API getter')
    component = reader.ptr(api - 8)
    plugin = reader.module('zVideoAppPlugin.dll', '67939de0ae3508071956204fc62b670bd51bd8b93c0d294b8f92ba4c0929e48f')
    if reader.ptr(component) != plugin['base'] + 0x43698:
        raise ValueError('Unexpected poll component interface')
    begin, end = reader.ptr(component + 0x40), reader.ptr(component + 0x48)
    if end < begin or end - begin > 128 * 8 or (end - begin) % 8:
        raise ValueError('Invalid poll vector bounds')
    objects = []
    for at in range(begin, end, 8):
        poll = reader.ptr(at)
        table = reader.ptr(poll)
        objects.append({'address': poll, 'vtable': reader.locate(table),
                        'methods': {hex(slot): reader.locate(reader.ptr(table + slot)) for slot in range(0, 0x140, 8)}})
    return {'conference': conference, 'component': component,
            'vtable': reader.locate(reader.ptr(component)),
            'vector': [reader.ptr(component + offset) for offset in (0x40, 0x48, 0x50)], 'pollObjects': objects,
            'backendMethods': {hex(slot): reader.locate(reader.ptr(reader.ptr(reader.ptr(component + 0x20)) + slot))
                               for slot in (0x28, 0x30, 0x38)}}


def pointer_vector(reader, address, limit):
    header = reader.read(address, 24)
    begin, end, capacity = struct.unpack('<QQQ', header)
    if end < begin or capacity < end or capacity - begin > limit * 8 or (end - begin) % 8 or (capacity - begin) % 8:
        raise ValueError('Invalid bounded vector')
    raw = reader.read(begin, end - begin) if begin != end else b''
    return [v[0] for v in struct.iter_unpack('<Q', raw)], (address, header, begin, raw)


def verify_vector(reader, guard):
    address, header, begin, raw = guard
    if reader.read(address, 24) != header or (raw and reader.read(begin, len(raw)) != raw):
        raise ValueError('Vector changed while reading')


def poll_snapshot(reader):
    layout = poll_layout(reader)
    web = reader.module('zWebService.dll', 'c49409475e4a745ae10cd058fb66e19c2426105f479f0335149a0ba267c6ea45')
    documents, doc_guard = pointer_vector(reader, layout['component'] + 0x40, 128)
    polls = []
    for document in documents:
        if reader.ptr(document) != web['base'] + 0x709618:
            raise ValueError('Unexpected poll document type')
        poll = {'id': reader.cstring(document + 8), 'name': reader.cstring(document + 0x30),
                'rawCounters': {hex(o): reader.u32(document + o) for o in (0x58, 0x5c, 0x80, 0x8c, 0x90, 0x94, 0x98, 0x9c, 0xa0, 0xa4, 0xb8, 0xbc)},
                'questions': []}
        questions, question_guard = pointer_vector(reader, document + 0x60, 128)
        for question in questions:
            if reader.ptr(question) != web['base'] + 0x709788:
                raise ValueError('Unexpected poll question type')
            q = {'id': reader.cstring(question + 8), 'text': reader.cstring(question + 0x30),
                 'rawCounters': {hex(o): reader.u32(question + o) for o in (0x98, 0x9c, 0xf0, 0xf4, 0xf8, 0x118, 0x11c)},
                 'options': []}
            options, option_guard = pointer_vector(reader, question + 0x80, 256)
            for option in options:
                if reader.ptr(option) != web['base'] + 0x7098c8:
                    raise ValueError('Unexpected poll option type')
                q['options'].append({'id': reader.cstring(option + 8), 'label': reader.cstring(option + 0x30),
                                     'rawCounters': {hex(o): reader.u32(option + o) for o in (0x58, 0x5c, 0xd8)}})
            verify_vector(reader, option_guard)
            poll['questions'].append(q)
        verify_vector(reader, question_guard)
        polls.append(poll)
    verify_vector(reader, doc_guard)
    spec = importlib.util.spec_from_file_location('native_poll_normalizer', pathlib.Path(__file__).with_name('zoom-native-read-model.py'))
    model = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(model)
    normalized = model.normalize_poll_results(polls)
    return {'source': 'zoom-native-passive-memory', 'items': polls,
            'partial': any(result['partial'] for result in normalized), 'rawModelPartial': False,
            'normalizedResults': normalized,
            'limitations': ['Eligible voter count and additional question types remain pending.']}


def bridge_layout(reader):
    bridge = reader.module('zoom_meeting_bridge.dll', '417c53cd26dfd8c24d6b9225db18bdc4fc03ec198aa2dac8f61c80322bc5f2b2')
    base = bridge['base']
    root = reader.ptr(base + 0x21ca38)
    if reader.ptr(root + 8) != base + 0x18f950:
        raise RuntimeError('Unexpected active meeting manager')
    # Emulate only the observed reads in GetActiveMeeting/0x13680/0x251a8.
    choices = [reader.ptr(root + offset) for offset in (0x670, 0x6d8, 0x740)]
    meeting = next((value for value in choices if value), root + 0x780)
    if reader.ptr(meeting) not in (base + 0x18fcc8, base + 0x191c60):
        raise RuntimeError('Unexpected meeting interface; no fallback scan: ' + str(reader.locate(reader.ptr(meeting))))
    info = reader.ptr(meeting + 0x2a58)
    if reader.ptr(info) != base + 0x197b50:
        raise RuntimeError('Unexpected meeting info interface')
    data = reader.ptr(info - 8)
    users = reader.ptr(data + 0x80)
    table = reader.ptr(users)
    if reader.ptr(base + 0x21ca38) != root:
        raise RuntimeError('Meeting manager changed during read')
    return {'root': root, 'meeting': meeting, 'info': info, 'data': data, 'users': users,
            'userListVtable': reader.locate(table),
            'userListMethods': {hex(slot): reader.locate(reader.ptr(table + slot))
                                for slot in (0x10, 0x18, 0x28, 0x40)}}


if __name__ == '__main__':
    import argparse
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--raw-users', action='store_true')
    parser.add_argument('--participants', action='store_true')
    parser.add_argument('--poll-layout', action='store_true')
    parser.add_argument('--polls', action='store_true')
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    with ProcessReader(args.pid) as reader:
        layout = bridge_layout(reader)
        result = poll_snapshot(reader) if args.polls else poll_layout(reader) if args.poll_layout else participant_snapshot(reader) if args.participants else raw_user_fields(reader, layout) if args.raw_users else layout
        if args.output:
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({'output': str(args.output), 'rows': len(result) if isinstance(result, list) else len(result.get('participants', []))}))
        else:
            print(json.dumps(result))
