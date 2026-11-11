"""Other native Zoom meeting processes on this machine: choose ours, close the rest.

Only processes that own a visible meeting window and run the per-user Zoom.exe
are ever considered; the signed-in main client (tray) is not a meeting process
and is never touched.
"""
import os
import pathlib


def select_meeting(found, meeting_id, probe):
    """Among several meeting processes, return the one connected to meeting_id.

    probe(candidate) returns the native `query` state (or raises). Anything but
    exactly one match is refused: guessing would control the wrong room.
    """
    matches = []
    for candidate in found:
        try:
            state = probe(candidate)
        except Exception:
            continue
        if state.get('inMeetingRaw') == 1 and state.get('conferenceReadyRaw') == 1 and state.get('meetingIdRaw') == meeting_id:
            matches.append(candidate)
    if len({item['pid'] for item in matches}) != 1:
        raise RuntimeError(f'Expected one native Zoom meeting process in the configured meeting, found {len(matches)} of {len(found)}; refusing to guess')
    return matches[0]


def others(found, own_pid):
    """PIDs of meeting processes that are not the controlled one."""
    return sorted({item['pid'] for item in found if item['pid'] != own_pid and item['pid'] != os.getpid()})


def terminate(pids, expected=None):
    """Terminate each PID after re-checking that it still is the per-user Zoom.exe."""
    import ctypes as C
    import ctypes.wintypes as W
    kernel = C.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    kernel.OpenProcess.restype = W.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)]
    kernel.TerminateProcess.argtypes = [W.HANDLE, W.UINT]
    kernel.TerminateProcess.restype = W.BOOL
    kernel.CloseHandle.argtypes = [W.HANDLE]
    expected = pathlib.Path(expected or pathlib.Path(os.environ['APPDATA']) / 'Zoom/bin/Zoom.exe').resolve()
    result = []
    for pid in pids:
        # PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION
        handle = kernel.OpenProcess(0x1001, False, pid)
        if not handle:
            result.append({'pid': pid, 'closed': False, 'reason': 'open-denied'})
            continue
        try:
            path = C.create_unicode_buffer(32768)
            length = W.DWORD(len(path))
            if not kernel.QueryFullProcessImageNameW(handle, 0, path, C.byref(length)) or pathlib.Path(path.value).resolve() != expected:
                result.append({'pid': pid, 'closed': False, 'reason': 'not-zoom'})
                continue
            closed = bool(kernel.TerminateProcess(handle, 0))
            result.append({'pid': pid, 'closed': closed} if closed else {'pid': pid, 'closed': False, 'reason': 'terminate-failed'})
        finally:
            kernel.CloseHandle(handle)
    return result
