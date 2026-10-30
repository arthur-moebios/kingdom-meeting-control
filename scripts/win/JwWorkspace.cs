using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using System.IO;
using System.Text;
using System.Security;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
using System.Windows.Automation;

internal static class NativeWindowLayout
{
    public static void Restore(Form form, string directory)
    {
        try {
            var values=File.ReadAllText(Path.Combine(directory,"native-window-layout.txt")).Split(',');
            if(values.Length!=5) return;
            var saved=new Rectangle(int.Parse(values[0]),int.Parse(values[1]),int.Parse(values[2]),int.Parse(values[3]));
            if(saved.Width<300 || saved.Height<300) return;
            var work=Screen.FromRectangle(saved).WorkingArea;
            int width=Math.Min(saved.Width,work.Width), height=Math.Min(saved.Height,work.Height);
            form.StartPosition=FormStartPosition.Manual; form.WindowState=FormWindowState.Normal;
            form.Bounds=new Rectangle(Math.Max(work.Left,Math.Min(saved.Left,work.Right-width)),Math.Max(work.Top,Math.Min(saved.Top,work.Bottom-height)),width,height);
            if(values[4]=="1") form.WindowState=FormWindowState.Maximized;
        } catch { }
    }
    public static void Save(Form form, string directory)
    {
        try {
            var bounds=form.WindowState==FormWindowState.Normal ? form.Bounds : form.RestoreBounds;
            File.WriteAllText(Path.Combine(directory,"native-window-layout.txt"),String.Join(",",bounds.X,bounds.Y,bounds.Width,bounds.Height,form.WindowState==FormWindowState.Maximized ? 1 : 0));
        } catch { }
    }
}

internal static class NativeStartup
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string Name = "KingdomMeetingControlNative";
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    static dynamic Scheduler() { dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")); service.Connect(); return service; }
    public static bool Enabled { get { try { dynamic folder = Scheduler().GetFolder("\\"); dynamic task = folder.GetTask(Name); return (bool)task.Enabled; } catch { return false; } } }
    public static void Set(bool enabled)
    {
        using (var key = Registry.CurrentUser.CreateSubKey(Key))
        {
            key.DeleteValue(Name, false);
        }
        dynamic folder = Scheduler().GetFolder("\\");
        if (!enabled) { try { folder.DeleteTask(Name, 0); } catch { } return; }
        string executable = Application.ExecutablePath;
        using (var file = File.Open(executable, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            var resolved = new StringBuilder(32768);
            if (GetFinalPathNameByHandle(file.SafeFileHandle, resolved, (uint)resolved.Capacity, 0) > 0)
                executable = resolved.ToString().Replace(@"\\?\", "");
        }
        string sid = WindowsIdentity.GetCurrent().User.Value;
        string xml = "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
            "<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + sid + "</UserId><Delay>PT10S</Delay></LogonTrigger></Triggers>" +
            "<Principals><Principal id=\"Author\"><UserId>" + sid + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>" +
            "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>" +
            "<Actions Context=\"Author\"><Exec><Command>" + SecurityElement.Escape(executable) + "</Command><Arguments>--native-research</Arguments><WorkingDirectory>" +
            SecurityElement.Escape(Path.GetDirectoryName(executable)) + "</WorkingDirectory></Exec></Actions></Task>";
        folder.RegisterTask(Name, xml, 6, sid, null, 3, null);
    }
    public static void OpenJw()
    {
        Process.Start(new ProcessStartInfo("explorer.exe", @"shell:AppsFolder\WatchtowerBibleandTractSo.45909CDBADF3C_5rz59y55nfz3e!App") { UseShellExecute = true });
    }
}

// Reparents only the JW operator frame into our workspace. The projection frame
// keeps its HWND and top-level parent so the validated native capture is intact.
internal sealed class JwWorkspace : IDisposable
{
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr child);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    readonly Form form;
    readonly SplitContainer split;
    readonly Timer timer = new Timer { Interval = 500 };
    IntPtr jw, core, originalParent, style, extended;
    DesktopWindows.Placement placement;
    bool wanted;
    bool searching;
    public string Error { get; private set; }
    public JwWorkspace(Form form, SplitContainer split)
    {
        this.form = form; this.split = split;
        split.Panel1.Resize += (s, e) => Fit();
        split.Resize += (s, e) => AdjustMinimums();
        timer.Tick += (s, e) => {
            if (!wanted) return;
            if (jw == IntPtr.Zero) TryAttach();
            else if (!DesktopWindows.IsWindow(jw)) { jw = IntPtr.Zero; core = IntPtr.Zero; split.Panel1Collapsed = true; }
            else Fit();
        };
        timer.Start();
    }
    public void SetEnabled(bool enabled)
    {
        wanted = enabled;
        if (enabled) { if (jw == IntPtr.Zero) { NativeStartup.OpenJw(); TryAttach(); } }
        else Restore();
    }
    void TryAttach()
    {
        if (searching) return;
        searching = true;
        Task.Run(() => {
            IntPtr frame = DesktopWindows.JwOperator(), content = IntPtr.Zero;
            if (frame != IntPtr.Zero) {
                var root = AutomationElement.FromHandle(frame);
                var element = root.FindFirst(TreeScope.Children, new AndCondition(
                    new PropertyCondition(AutomationElement.NameProperty, "JW Library"),
                    new PropertyCondition(AutomationElement.ClassNameProperty, "Windows.UI.Core.CoreWindow")));
                if (element != null) content = new IntPtr(element.Current.NativeWindowHandle);
            }
            return Tuple.Create(frame, content);
        }).ContinueWith(task => {
            if (form.IsDisposed || !form.IsHandleCreated) return;
            try { form.BeginInvoke((Action)(() => {
                searching = false;
                if (!wanted || jw != IntPtr.Zero || task.IsFaulted || task.Result.Item1 == IntPtr.Zero) return;
                Attach(task.Result.Item1, task.Result.Item2);
            })); } catch { }
        });
    }
    void Attach(IntPtr target, IntPtr content)
    {
        // Both frames must already agree on DPI. Avoid a cross-process reset
        // that could affect the separate projection window.
        if (!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(target), GetWindowDpiAwarenessContext(form.Handle)))
        { Error = "O JW e o painel usam escalas de DPI diferentes; integração não aplicada."; wanted = false; MessageBox.Show(form, Error); return; }
        placement = DesktopWindows.Save(target); originalParent = GetParent(target);
        style = DesktopWindows.GetWindowLongPtr(target, -16); extended = DesktopWindows.GetWindowLongPtr(target, -20);
        var work = Screen.FromControl(form).WorkingArea;
        form.MinimumSize = new Size(Math.Min(920, work.Width), Math.Min(500, work.Height));
        form.WindowState = FormWindowState.Maximized;
        form.PerformLayout();
        AdjustMinimums();
        split.Panel1Collapsed = false;
        int available = split.ClientSize.Width - split.SplitterWidth;
        int operatorWidth = Math.Max(split.Panel2MinSize, Math.Min(380, available - split.Panel1MinSize));
        split.SplitterDistance = Math.Max(split.Panel1MinSize, available - operatorWidth);
        DesktopWindows.SetWindowLongPtr(target, -16, new IntPtr((style.ToInt64() | 0x40000000L) & ~0x80c40000L));
        DesktopWindows.SetWindowLongPtr(target, -20, new IntPtr((extended.ToInt64() | 0x80) & ~0x40000L));
        SetLastError(0);
        SetParent(target, split.Panel1.Handle);
        if (GetParent(target) != split.Panel1.Handle)
        {
            Error = "Não foi possível integrar o JW: " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
            DesktopWindows.SetWindowLongPtr(target, -16, style); DesktopWindows.SetWindowLongPtr(target, -20, extended);
            split.Panel1Collapsed = true; wanted = false; return;
        }
        jw = target; core = content; Error = null;
        form.Text = "Salão do Reino — JW Library e Painel do Operador";
        ShowWindow(jw, 1); Fit();
    }
    void AdjustMinimums()
    {
        int available = split.ClientSize.Width - split.SplitterWidth;
        if (available < split.Panel2MinSize + 1) return;
        // Include the form borders in the screen limit. A fixed 920px minimum
        // could extend beyond a 908px remote desktop and clip the controls.
        split.Panel1MinSize = Math.Min(600, available - split.Panel2MinSize);
    }
    void Fit()
    {
        if (jw == IntPtr.Zero || !DesktopWindows.IsWindow(jw)) return;
        var desired = split.Panel1.RectangleToScreen(split.Panel1.ClientRectangle);
        if (DesktopWindows.Bounds(jw) != desired)
            DesktopWindows.SetWindowPos(jw, IntPtr.Zero, 0, 0, split.Panel1.ClientSize.Width, split.Panel1.ClientSize.Height, 0x34);
        FitContent();
    }
    void FitContent()
    {
        // UWP exposes a separate CoreWindow surface; changing only the frame can
        // leave XAML at its old resolution and produce clipping/hit-test errors.
        if (core == IntPtr.Zero || !DesktopWindows.IsWindow(core)) return;
        DesktopWindows.Rect client;
        if (!DesktopWindows.GetClientRect(jw, out client)) return;
        int width = client.Right - client.Left, height = client.Bottom - client.Top;
        var bounds = DesktopWindows.Bounds(core);
        if (width > 0 && height > 0 && (bounds.Width != width || bounds.Height != height))
            DesktopWindows.SetWindowPos(core, IntPtr.Zero, 0, 0, width, height, 0x16);
    }
    void Restore()
    {
        if (jw != IntPtr.Zero && DesktopWindows.IsWindow(jw))
        {
            SetParent(jw, originalParent);
            DesktopWindows.SetWindowLongPtr(jw, -16, style);
            DesktopWindows.SetWindowLongPtr(jw, -20, extended);
            DesktopWindows.SetWindowPlacement(jw, ref placement);
            DesktopWindows.SetWindowPos(jw, IntPtr.Zero, 0, 0, 0, 0, 0x37);
            FitContent();
        }
        jw = IntPtr.Zero; core = IntPtr.Zero; split.Panel1Collapsed = true;
        split.Panel1MinSize = 420; form.MinimumSize = new Size(760, 500);
        form.Text = "Salão do Reino — Painel do Operador";
    }
    public void Dispose() { wanted = false; timer.Stop(); timer.Dispose(); Restore(); }
}
