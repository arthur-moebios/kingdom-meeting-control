using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;

// Read-only UIA observer. Selectors adapted from JarbasJWL/frmPrincipal.cs:
// https://github.com/arthur-moebios/JarbasJWL/blob/c2dfa260a1cbb80b7095bc215675ee274db7fbb1/frmPrincipal.cs
// UIA callbacks only invalidate the state. All tree reads happen on this worker,
// against the entire JW root (event sender may be only a changed subtree).
public static class JwMediaObserver
{
    private static readonly AutoResetEvent Dirty = new AutoResetEvent(false);
    private static readonly StructureChangedEventHandler Structure = (s, e) => Dirty.Set();
    private static readonly AutomationPropertyChangedEventHandler Property = (s, e) => Dirty.Set();
    private static readonly Condition Video = new PropertyCondition(
        AutomationElement.AutomationIdProperty, "VolumeButton");
    private static readonly Condition Image = new AndCondition(
        new PropertyCondition(AutomationElement.NameProperty,
            "Watchtower.Apps.JWLibrary.Common.ViewModels.PlayMedia.ImageViewModel"),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
        new PropertyCondition(AutomationElement.ClassNameProperty, "FlipViewItem"));

    private static void Attach(AutomationElement root)
    {
        Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, Structure);
        Automation.AddAutomationPropertyChangedEventHandler(root, TreeScope.Subtree, Property,
            AutomationElement.NameProperty, AutomationElement.IsOffscreenProperty,
            SelectionItemPattern.IsSelectedProperty);
    }

    private static bool ParentAlive(int parentId)
    {
        try { using (var p = Process.GetProcessById(parentId)) return !p.HasExited; }
        catch { return false; }
    }

    public static void Run(int parentId, int reconcileMs)
    {
        var roots = new Dictionary<int, AutomationElement>();
        try
        {
            while (ParentAlive(parentId))
            {
                try
                {
                    bool running = false;
                    var pids = new HashSet<int>();
                    foreach (var p in Process.GetProcessesByName("JWLibrary"))
                    {
                        using (p) { pids.Add(p.Id); running = true; }
                    }
                    var current = new Dictionary<int, AutomationElement>();
                    var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
                    foreach (AutomationElement window in windows)
                    {
                        var c = window.Current;
                        // UWP may expose ApplicationFrameHost's PID, not JWLibrary's.
                        if (!pids.Contains(c.ProcessId) && c.Name != "JW Library") continue;
                        running = true;
                        int handle = c.NativeWindowHandle;
                        if (handle == 0) continue;
                        current[handle] = window;
                    }
                    // Reattach after close/reopen or root replacement. A periodic
                    // scan also covers providers that omit structure events.
                    bool changed = current.Count != roots.Count;
                    foreach (int handle in current.Keys) if (!roots.ContainsKey(handle)) changed = true;
                    if (changed)
                    {
                        Automation.RemoveAllEventHandlers();
                        roots.Clear();
                        foreach (var pair in current)
                        {
                            Attach(pair.Value);
                            roots.Add(pair.Key, pair.Value);
                        }
                    }
                    bool video = false, image = false;
                    foreach (var root in current.Values)
                    {
                        // Match stable IDs, independent of language or mute state.
                        video |= root.FindFirst(TreeScope.Descendants, Video) != null;
                        image |= root.FindFirst(TreeScope.Descendants, Image) != null;
                    }
                    var mediaWindow = JwMediaWindows.FindMediaWindow();
                    string mediaHandle = mediaWindow == null ? "null" :
                        mediaWindow.Current.NativeWindowHandle.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    var captureHandles = JwMediaWindows.CapturableJwHandles();
                    bool captureReady = mediaWindow != null && captureHandles.Length > 0 &&
                        captureHandles[0] == mediaWindow.Current.NativeWindowHandle &&
                        (captureHandles.Length == 1 || JwMediaWindows.IsTopmost(mediaWindow));
                    // One JSON line per scan is also a heartbeat for Node's watchdog.
                    Console.WriteLine("{\"jw\":" + (running ? "true" : "false") +
                        ",\"active\":" + (video || image ? "true" : "false") +
                        ",\"kind\":\"" + (video ? "video" : image ? "image" : "none") +
                        "\",\"mediaWindowHandle\":" + mediaHandle +
                        ",\"mediaWindowCaptureReady\":" + (captureReady ? "true" : "false") + "}");
                    Console.Out.Flush();
                }
                catch (Exception ex)
                {
                    // Never translate a failed read into 'media ended'.
                    Console.Error.WriteLine(ex.GetType().Name + ": " + ex.Message);
                    Automation.RemoveAllEventHandlers();
                    roots.Clear();
                }
                Dirty.WaitOne(reconcileMs);
            }
        }
        finally { Automation.RemoveAllEventHandlers(); }
    }
}
