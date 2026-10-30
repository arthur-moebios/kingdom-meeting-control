"""Read-only Win32 window/thread inventory for a selected process."""
import ctypes as C
import ctypes.wintypes as W
import json
import sys

user = C.WinDLL('user32', use_last_error=True)
callback_type = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
user.EnumWindows.argtypes = [callback_type, W.LPARAM]
user.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
user.GetWindowThreadProcessId.restype = W.DWORD
user.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
user.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
user.IsWindowVisible.argtypes = [W.HWND]
user.GetWindowRect.argtypes = [W.HWND, C.POINTER(W.RECT)]
def windows_for_process(target=None):
    rows = []
    @callback_type
    def visit(hwnd, _):
        pid = W.DWORD()
        tid = user.GetWindowThreadProcessId(hwnd, C.byref(pid))
        if target is None or pid.value == target:
            title, name = C.create_unicode_buffer(1024), C.create_unicode_buffer(256)
            user.GetWindowTextW(hwnd, title, len(title))
            user.GetClassNameW(hwnd, name, len(name))
            bounds = W.RECT()
            user.GetWindowRect(hwnd, C.byref(bounds))
            rows.append({'hwnd': hwnd, 'pid': pid.value, 'threadId': tid, 'title': title.value,
                         'className': name.value, 'visible': bool(user.IsWindowVisible(hwnd)),
                         'bounds': [bounds.left, bounds.top, bounds.right, bounds.bottom]})
        return True
    user.EnumWindows(visit, 0)
    return rows

if __name__ == '__main__':
    print(json.dumps(windows_for_process(int(sys.argv[1]) if len(sys.argv) > 1 else None), ensure_ascii=False))
