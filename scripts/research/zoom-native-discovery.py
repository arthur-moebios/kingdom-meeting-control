"""Discover the native meeting process without UI actions or process injection."""
import ctypes as C
import ctypes.wintypes as W
import importlib.util
import json
import os
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('zoom_windows', HERE / 'zoom-native-windows.py')
windows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(windows)
kernel = C.WinDLL('kernel32', use_last_error=True)
kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
kernel.OpenProcess.restype = W.HANDLE
kernel.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)]
kernel.CloseHandle.argtypes = [W.HANDLE]

def candidates():
    expected = pathlib.Path(os.environ['APPDATA']) / 'Zoom/bin/Zoom.exe'
    result = {}
    for window in windows.windows_for_process():
        if not window['visible'] or window['className'] not in ('ConfMultiTabContentWndClass', 'VideoPreviewWndClass'):
            continue
        handle = kernel.OpenProcess(0x1000, False, window['pid'])
        if not handle:
            continue
        try:
            path = C.create_unicode_buffer(32768)
            length = W.DWORD(len(path))
            if not kernel.QueryFullProcessImageNameW(handle, 0, path, C.byref(length)):
                continue
            if pathlib.Path(path.value).resolve() != expected.resolve():
                continue
        finally:
            kernel.CloseHandle(handle)
        key = window['pid'], window['threadId']
        result[key] = {'pid': window['pid'], 'thread': window['threadId'], 'window': window['hwnd'], 'className': window['className']}
    return list(result.values())

def discover_one():
    found = candidates()
    if len(found) != 1:
        raise RuntimeError(f'Expected one native Zoom meeting process, found {len(found)}; refusing to guess')
    return found[0]

if __name__ == '__main__':
    print(json.dumps(candidates()))
