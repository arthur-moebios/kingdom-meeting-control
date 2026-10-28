using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

// Read-only identification adapted from JwlMediaWin.Core/Fixer.cs:
// https://github.com/AntonyCorbett/JwlMediaWin/blob/b0bb10ac9f2dd1bb8b2452dd0ce3abf427bab29b/JwlMediaWin.Core/Fixer.cs
// The fixer disables the media window after adjusting it. Do NOT filter by
// IsEnabled: that would exclude the exact window we want to share.
public static class JwMediaWindows
{
    public static AutomationElement FindMediaWindow()
    {
        AutomationElement result = null;
        var windows = AutomationElement.RootElement.FindAll(TreeScope.Children,
            new PropertyCondition(AutomationElement.NameProperty, "JW Library"));
        foreach (AutomationElement window in windows)
        {
            var core = window.FindFirst(TreeScope.Children, new AndCondition(
                new PropertyCondition(AutomationElement.NameProperty, "JW Library"),
                new PropertyCondition(AutomationElement.ClassNameProperty, "Windows.UI.Core.CoreWindow")));
            if (core == null) continue;
            var media = core.FindFirst(TreeScope.Children, new OrCondition(
                new PropertyCondition(AutomationElement.ClassNameProperty, "Microsoft.UI.Xaml.Controls.WebView2"),
                new PropertyCondition(AutomationElement.ClassNameProperty, "ProgressRing"),
                new PropertyCondition(AutomationElement.AutomationIdProperty, "ImageViewer")));
            bool empty = core.FindFirst(TreeScope.Children, Condition.TrueCondition) == null;
            if (media == null && !empty) continue;
            if (result != null) return null; // ambiguous: never guess another JW window
            result = window;
        }
        return result;
    }

    public static bool IsTopmost(AutomationElement window)
    {
        object pattern;
        return window.TryGetCurrentPattern(WindowPattern.Pattern, out pattern) &&
            ((WindowPattern)pattern).Current.IsTopmost;
    }

    private delegate bool EnumWindowsProc(IntPtr handle, IntPtr arg);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr arg);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int size);

    // WebRTC enumerates visible, non-minimized native windows in EnumWindows
    // order. Only the JW sources are needed to resolve the duplicate title.
    public static int[] CapturableJwHandles()
    {
        var handles = new List<int>();
        EnumWindows((handle, arg) =>
        {
            if (!IsWindowVisible(handle) || IsIconic(handle)) return true;
            int cloaked;
            if (DwmGetWindowAttribute(handle, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            var title = new StringBuilder(256);
            GetWindowText(handle, title, title.Capacity);
            if (title.ToString() == "JW Library") handles.Add(handle.ToInt32());
            return true;
        }, IntPtr.Zero);
        return handles.ToArray();
    }
}
