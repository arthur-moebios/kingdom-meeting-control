using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Read-only fallback: the projection adjusted by JwlMediaWin is disabled and
// topmost. Require its CoreWindow to belong to the running JW process as well.
public static class JwNativeMediaWindows
{
    delegate bool Visitor(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visitor, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Visitor visitor, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder value, int length);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int length);
    static string Name(IntPtr window, bool title) { var s=new StringBuilder(256); if(title) GetWindowText(window,s,s.Capacity); else GetClassName(window,s,s.Capacity); return s.ToString(); }
    public static long FindProjection()
    {
        var pids=new HashSet<uint>();
        foreach(var process in Process.GetProcessesByName("JWLibrary")) using(process) pids.Add((uint)process.Id);
        var matches=new List<IntPtr>();
        EnumWindows((window, state) => {
            if(!IsWindowVisible(window) || IsIconic(window) || IsWindowEnabled(window) ||
               (GetWindowLongPtr(window,-20).ToInt64() & 8)==0 ||
               Name(window,false)!="ApplicationFrameWindow" || Name(window,true)!="JW Library") return true;
            int cloaked; if(DwmGetWindowAttribute(window,14,out cloaked,4)==0 && cloaked!=0) return true;
            bool ownsCore=false;
            EnumChildWindows(window,(child,arg) => { uint pid; GetWindowThreadProcessId(child,out pid);
                if(pids.Contains(pid) && Name(child,false)=="Windows.UI.Core.CoreWindow") ownsCore=true;
                return true; },IntPtr.Zero);
            if(ownsCore) matches.Add(window);
            return true;
        },IntPtr.Zero);
        return matches.Count==1 ? matches[0].ToInt64() : 0;
    }
}
