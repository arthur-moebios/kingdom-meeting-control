using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Forms;

// Desktop-only presentation. Never invokes Zoom UIA actions or changes meeting,
// audio, camera, polling, sharing or participant settings.
internal static class DesktopWindows
{
    internal delegate bool EnumProc(IntPtr handle, IntPtr arg);
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct Placement
    { public int Length, Flags, ShowCmd; public Point Min, Max; public Rect Normal; }
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumProc callback, IntPtr arg);
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool GetWindowPlacement(IntPtr handle, ref Placement placement);
    [DllImport("user32.dll")] internal static extern bool SetWindowPlacement(IntPtr handle, ref Placement placement);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] internal static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
    [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetWindowLongPtr(IntPtr handle, int index, IntPtr value);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int bytes);
    internal static string Text(IntPtr handle) { var s = new StringBuilder(512); GetWindowText(handle, s, s.Capacity); return s.ToString(); }
    internal static string Class(IntPtr handle) { var s = new StringBuilder(256); GetClassName(handle, s, s.Capacity); return s.ToString(); }
    internal static Placement Save(IntPtr handle) { var p = new Placement(); p.Length = Marshal.SizeOf(typeof(Placement)); GetWindowPlacement(handle, ref p); return p; }
    internal static Rectangle Bounds(IntPtr handle) { Rect r; if (!GetWindowRect(handle, out r)) return Rectangle.Empty; return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom); }
    internal static bool IsZoom(IntPtr handle)
    {
        if (Class(handle) != "ConfMultiTabContentWndClass") return false;
        return IsZoomProcess(handle);
    }
    internal static bool IsZoomProcess(IntPtr handle)
    {
        uint pid; GetWindowThreadProcessId(handle, out pid);
        try
        {
            string path = Process.GetProcessById((int)pid).MainModule.FileName;
            string expected = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Zoom", "bin", "Zoom.exe");
            return String.Equals(path, expected, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }
    internal static IntPtr Zoom()
    {
        var matches = new List<IntPtr>();
        EnumWindows((h, a) => { if (IsWindowVisible(h) && IsZoom(h)) matches.Add(h); return true; }, IntPtr.Zero);
        return matches.Count == 1 ? matches[0] : IntPtr.Zero;
    }
    internal static IntPtr JwOperator()
    {
        // Reuse the existing media identity; only the other JW window may be docked.
        IntPtr media = IntPtr.Zero;
        try { var element = JwMediaWindows.FindMediaWindow(); if (element != null) media = new IntPtr(element.Current.NativeWindowHandle); }
        catch { return IntPtr.Zero; }
        if (media == IntPtr.Zero) return IntPtr.Zero;
        var matches = new List<IntPtr>();
        EnumWindows((h, a) =>
        {
            if (h == media || !IsWindowVisible(h) || IsIconic(h) || Text(h) != "JW Library") return true;
            int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            if (Class(h) == "ApplicationFrameWindow") matches.Add(h);
            return true;
        }, IntPtr.Zero);
        return matches.Count == 1 ? matches[0] : IntPtr.Zero;
    }
}

internal sealed class HostVideoPreview : Form
{
    [StructLayout(LayoutKind.Sequential)] struct ThumbnailProperties
    {
        public uint Flags;
        public DesktopWindows.Rect Destination, Source;
        public byte Opacity;
        [MarshalAs(UnmanagedType.Bool)] public bool Visible;
        [MarshalAs(UnmanagedType.Bool)] public bool ClientOnly;
    }
    [DllImport("dwmapi.dll")] static extern int DwmRegisterThumbnail(IntPtr destination, IntPtr source, out IntPtr thumbnail);
    [DllImport("dwmapi.dll")] static extern int DwmUpdateThumbnailProperties(IntPtr thumbnail, ref ThumbnailProperties properties);
    [DllImport("dwmapi.dll")] static extern int DwmUnregisterThumbnail(IntPtr thumbnail);
    IntPtr thumbnail, sourceWindow;
    public HostVideoPreview() { Text = "Prévia — câmera do anfitrião"; FormBorderStyle = FormBorderStyle.None; StartPosition = FormStartPosition.Manual; ShowInTaskbar = false; BackColor = Color.Black; }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { var p = base.CreateParams; p.ExStyle |= 0x08000080; return p; } // no activate, tool window
    }
    public void ClearVideo()
    {
        if (thumbnail != IntPtr.Zero) DwmUnregisterThumbnail(thumbnail);
        thumbnail = IntPtr.Zero; sourceWindow = IntPtr.Zero; Hide();
    }
    public void UpdateVideo(Form owner, Rectangle destination, IntPtr source, Rectangle crop)
    {
        if (sourceWindow != source || thumbnail == IntPtr.Zero)
        {
            ClearVideo();
            if (DwmRegisterThumbnail(Handle, source, out thumbnail) != 0) { thumbnail = IntPtr.Zero; throw new InvalidOperationException("Prévia indisponível"); }
            sourceWindow = source;
        }
        Bounds = destination;
        double scale = Math.Min((double)ClientSize.Width / crop.Width, (double)ClientSize.Height / crop.Height);
        int w = (int)(crop.Width * scale), h = (int)(crop.Height * scale);
        var p = new ThumbnailProperties { Flags = 1 | 2 | 4 | 8 | 16, Opacity = 255, Visible = true, ClientOnly = false };
        p.Source = new DesktopWindows.Rect { Left = crop.Left, Top = crop.Top, Right = crop.Right, Bottom = crop.Bottom };
        p.Destination = new DesktopWindows.Rect { Left = (ClientSize.Width - w) / 2, Top = (ClientSize.Height - h) / 2,
            Right = (ClientSize.Width + w) / 2, Bottom = (ClientSize.Height + h) / 2 };
        if (DwmUpdateThumbnailProperties(thumbnail, ref p) != 0) { ClearVideo(); throw new InvalidOperationException("Prévia indisponível"); }
        if (!Visible) Show(owner);
    }
    protected override void Dispose(bool disposing) { ClearVideo(); base.Dispose(disposing); }
}

internal sealed class OperatorDesktop : IDisposable
{
    readonly Form form;
    readonly Panel previewArea;
    readonly Splitter cameraDivider;
    readonly Label status;
    readonly ToolStripButton dockButton, zoomButton, previewButton;
    readonly Timer timer;
    readonly HostVideoPreview preview = new HostVideoPreview();
    Microsoft.Web.WebView2.WinForms.WebView2 cameraWeb;
    bool embeddedCamera, cameraSlotVisible;
    Rectangle cameraSlot;
    IntPtr jw, zoom;
    DesktopWindows.Placement jwOriginal, zoomOriginal;
    IntPtr zoomStyle;
    bool jwResized, zoomHidden, disposed, scanning;
    Rectangle hostCrop;
    IntPtr hostSource;
    string hostStatus = "Procurando a câmera do anfitrião…";
    DateTime nextScan = DateTime.MinValue;
    DateTime hostObservedAt = DateTime.MinValue;
    public event Action<bool> WorkspaceChanged;
    string desktopRequest = "";
    public OperatorDesktop(Form form, Control surface = null)
    {
        this.form = form;
        if (surface == null) surface = form;
        string cameraLayoutFile = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"native-camera-height.txt");
        int cameraHeight = 144, savedHeight;
        try { if (int.TryParse(System.IO.File.ReadAllText(cameraLayoutFile),out savedHeight)) cameraHeight=Math.Max(80,Math.Min(360,savedHeight)); } catch { }
        previewArea = new Panel { Dock = DockStyle.Top, Height = cameraHeight, BackColor = Color.Black };
        cameraDivider = new Splitter { Dock=DockStyle.Top, Height=6, MinSize=80, MinExtra=300, BackColor=Color.FromArgb(32,48,73), Cursor=Cursors.HSplit };
        cameraDivider.SplitterMoving += (s,e) => { e.SplitY=Math.Max(previewArea.Top+80,Math.Min(previewArea.Top+360,e.SplitY)); };
        cameraDivider.SplitterMoved += (s,e) => { try { System.IO.File.WriteAllText(cameraLayoutFile,previewArea.Height.ToString()); } catch { } PositionPreview(); };
        cameraDivider.DoubleClick += (s,e) => { previewArea.Height=144; try { System.IO.File.WriteAllText(cameraLayoutFile,"144"); } catch { } PositionPreview(); };
        status = new Label { Dock = DockStyle.Fill, ForeColor = Color.Silver, TextAlign = ContentAlignment.MiddleCenter, Text = hostStatus };
        previewArea.Controls.Add(status);
        var tools = new ToolStrip { Dock = DockStyle.Top, GripStyle = ToolStripGripStyle.Hidden, BackColor = Color.FromArgb(17, 28, 46), ForeColor = Color.White };
        dockButton = new ToolStripButton("Acoplar ao JW") { CheckOnClick = true };
        zoomButton = new ToolStripButton("Ocultar Zoom") { CheckOnClick = true };
        previewButton = new ToolStripButton("Câmera do anfitrião") { CheckOnClick = true, Checked = true };
        tools.Items.AddRange(new ToolStripItem[] { dockButton, zoomButton, previewButton });
        // A workspace has its own split layout. Legacy side docking would shrink
        // the entire workspace to 380px and break the two-pane minimum sizes.
        if (surface != form) { dockButton.Enabled = false; dockButton.Visible = false; }
        tools.LayoutStyle = ToolStripLayoutStyle.Flow;
        var openJw = new ToolStripButton("Abrir JW Library");
        var unified = new ToolStripButton("Janela única") { CheckOnClick = true };
        var startup = new ToolStripButton("Iniciar com Windows") { CheckOnClick = true, Checked = NativeStartup.Enabled };
        openJw.Click += (s, e) => NativeStartup.OpenJw();
        unified.CheckedChanged += (s, e) => { dockButton.Checked = false; if (WorkspaceChanged != null) WorkspaceChanged(unified.Checked); };
        startup.CheckedChanged += (s, e) => NativeStartup.Set(startup.Checked);
        tools.Items.AddRange(new ToolStripItem[] { openJw, unified, startup });
        surface.Controls.Add(cameraDivider); surface.Controls.Add(previewArea); surface.Controls.Add(tools);
        surface.SizeChanged += (s,e) => { if(!embeddedCamera) previewArea.Height=Math.Min(previewArea.Height,Math.Max(80,surface.ClientSize.Height-tools.Height-cameraDivider.Height-300)); else PositionEmbeddedCamera(); PositionPreview(); };
        dockButton.CheckedChanged += (s, e) => { if (!dockButton.Checked) RestoreJw(); else nextScan = DateTime.MinValue; };
        zoomButton.CheckedChanged += (s, e) => { if (!zoomButton.Checked) RestoreZoom(); };
        previewButton.CheckedChanged += (s, e) => { previewArea.Visible = previewButton.Checked && (!embeddedCamera || cameraSlotVisible); cameraDivider.Visible = previewButton.Checked && !embeddedCamera; if (!previewButton.Checked) preview.ClearVideo(); else if(embeddedCamera) PositionEmbeddedCamera(); };
        form.LocationChanged += (s, e) => PositionPreview();
        form.SizeChanged += (s, e) => PositionPreview();
        timer = new Timer { Interval = 250 };
        timer.Tick += Tick; timer.Start();
    }
    public void EnableDock() { dockButton.Checked = true; }
    public void HideZoom() { zoomButton.Checked = true; }
    public void EmbedCamera(Microsoft.Web.WebView2.WinForms.WebView2 web)
    {
        embeddedCamera=true;cameraWeb=web;
        previewArea.Dock=DockStyle.None;previewArea.Visible=false;cameraDivider.Visible=false;
        web.CoreWebView2.NavigationStarting += (s,e) => {cameraSlotVisible=false;PositionEmbeddedCamera();};
        web.SizeChanged += (s,e) => PositionEmbeddedCamera();
        web.LocationChanged += (s,e) => PositionEmbeddedCamera();
        web.CoreWebView2.WebMessageReceived += (s,e) => {
            try {
                var source=new Uri(e.Source);
                if(source.Scheme!="http" || source.Host!="127.0.0.1" || source.Port!=4319 || (source.AbsolutePath!="/" && source.AbsolutePath!="/index.html")) return;
                var values=e.TryGetWebMessageAsString().Split('|');
                if(values.Length!=7 || values[0]!="kmc-camera-slot")return;
                var numbers=new double[5];
                for(int i=0;i<5;i++)if(!double.TryParse(values[i+1],System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out numbers[i]) || double.IsNaN(numbers[i]) || double.IsInfinity(numbers[i]) || Math.Abs(numbers[i])>100000)return;
                double scale=numbers[4];if(scale<0.25 || scale>8)return;
                cameraSlot=new Rectangle((int)Math.Round(numbers[0]*scale),(int)Math.Round(numbers[1]*scale),(int)Math.Round(numbers[2]*scale),(int)Math.Round(numbers[3]*scale));
                cameraSlotVisible=values[6]=="1" && cameraSlot.Width>0 && cameraSlot.Height>0;
                PositionEmbeddedCamera();
            } catch { }
        };
    }
    void PositionEmbeddedCamera()
    {
        if(!embeddedCamera || cameraWeb==null || disposed)return;
        bool visible=cameraSlotVisible && previewButton.Checked && cameraWeb.ClientRectangle.Contains(cameraSlot);
        previewArea.Visible=visible;
        if(visible) {
            var screen=cameraWeb.RectangleToScreen(cameraSlot);
            var point=previewArea.Parent.PointToClient(screen.Location);
            previewArea.Bounds=new Rectangle(point,screen.Size);previewArea.BringToFront();
        }
        PositionPreview();
    }
    void Tick(object sender, EventArgs args)
    {
        if (disposed) return;
        try {
            var file = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-desktop-request.json");
            if (System.IO.File.Exists(file)) {
                var value = System.IO.File.ReadAllText(file);
                if (desktopRequest != value) {
                    desktopRequest = value;
                    bool hidden = Regex.IsMatch(value, "\"hidden\"\\s*:\\s*true");
                    if (zoomButton.Checked == hidden && !hidden) RestoreZoom();
                    else zoomButton.Checked = hidden;
                }
            }
        } catch { }
        if (zoom != IntPtr.Zero && (!DesktopWindows.IsWindow(zoom) || !DesktopWindows.IsZoom(zoom))) { zoom = IntPtr.Zero; zoomHidden = false; hostSource = IntPtr.Zero; }
        if (zoom == IntPtr.Zero) zoom = DesktopWindows.Zoom();
        if (zoomButton.Checked && zoom != IntPtr.Zero && !zoomHidden) HideNativeZoom();
        if (zoomHidden) KeepOutsideDesktop(zoom);
        if (dockButton.Checked && jw != IntPtr.Zero && DesktopWindows.IsWindow(jw)) FollowJw();
        if (DateTime.UtcNow >= nextScan && !scanning)
        {
            nextScan = DateTime.UtcNow.AddSeconds(1); scanning = true;
            IntPtr zoomAtScan = zoom;
            bool findJw = dockButton.Checked && (jw == IntPtr.Zero || !DesktopWindows.IsWindow(jw));
            Task.Run(() =>
            {
                IntPtr foundJw = findJw ? DesktopWindows.JwOperator() : IntPtr.Zero;
                Rectangle crop; string message;
                FindHost(zoomAtScan, out crop, out message);
                if (disposed || !form.IsHandleCreated) return;
                try { form.BeginInvoke((Action)(() =>
                {
                    scanning = false; if (disposed) return;
                    if (foundJw != IntPtr.Zero && dockButton.Checked) AttachJw(foundJw);
                    if (zoomAtScan == zoom) { hostCrop = crop; hostSource = crop.IsEmpty ? IntPtr.Zero : zoomAtScan; hostStatus = message; hostObservedAt = DateTime.UtcNow; }
                    PositionPreview();
                })); } catch { }
            });
        }
        PositionPreview();
    }
    static void FindHost(IntPtr source, out Rectangle crop, out string message)
    {
        crop = Rectangle.Empty; message = "Abra a reunião no Zoom nativo";
        if (source == IntPtr.Zero || !DesktopWindows.IsWindow(source)) return;
        try
        {
            var root = AutomationElement.FromHandle(source);
            var panes = root.FindAll(TreeScope.Descendants, new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Pane),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Custom),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Group)));
            var hostRole = new Regex(@"\((?:Anfitrião|Host)(?:,|\))", RegexOptions.IgnoreCase);
            Rectangle bounds = DesktopWindows.Bounds(source), best = Rectangle.Empty;
            string identity = null;
            var diagnostic = new StringBuilder("Zoom bounds: " + bounds + "; panes=" + panes.Count + Environment.NewLine);
            foreach (AutomationElement pane in panes)
            {
                string name = pane.Current.Name ?? "";
                if (!(name.StartsWith("Conteúdo de vídeo", StringComparison.OrdinalIgnoreCase) || name.StartsWith("Video Content", StringComparison.OrdinalIgnoreCase))) continue;
                if (!hostRole.IsMatch(name)) continue;
                if (name.IndexOf("Vídeo desligado", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("Video off", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                string owner = name.Substring(0, name.IndexOf(')') + 1);
                if (identity != null && identity != owner) { message = "Câmera do anfitrião ambígua"; return; }
                identity = owner;
                var r = pane.Current.BoundingRectangle;
                var rect = Rectangle.FromLTRB((int)r.Left, (int)r.Top, (int)r.Right, (int)r.Bottom);
                diagnostic.AppendLine("Host candidate bounds: " + rect);
                int nativeHandle = pane.Current.NativeWindowHandle;
                if (nativeHandle != 0)
                {
                    uint sourcePid, childPid;
                    DesktopWindows.GetWindowThreadProcessId(source, out sourcePid);
                    DesktopWindows.GetWindowThreadProcessId(new IntPtr(nativeHandle), out childPid);
                    if (sourcePid == childPid) rect = DesktopWindows.Bounds(new IntPtr(nativeHandle));
                }
                rect = DesktopGeometry.HostCrop(bounds, rect);
                if (rect.IsEmpty) continue;
                if (rect.Width * rect.Height > best.Width * best.Height) best = rect;
            }
            crop = best;
            if (Environment.GetEnvironmentVariable("KMC_DESKTOP_DIAGNOSTICS") == "1")
                try { System.IO.File.WriteAllText(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-desktop.log"), diagnostic.ToString() + "Crop: " + crop); } catch { }
            message = best.IsEmpty ? "Câmera do anfitrião fora da área visível do Zoom" : "Câmera do anfitrião";
        }
        catch { message = "Prévia do anfitrião temporariamente indisponível"; }
    }
    void PositionPreview()
    {
        if (disposed) return;
        status.Text = hostStatus;
        if (!previewButton.Checked || !previewArea.Visible || form.WindowState == FormWindowState.Minimized || !form.Visible || hostSource == IntPtr.Zero || DateTime.UtcNow - hostObservedAt > TimeSpan.FromSeconds(2))
        { preview.ClearVideo(); status.Text = hostStatus; return; }
        try
        {
            Rectangle rect = previewArea.RectangleToScreen(previewArea.ClientRectangle);
            preview.UpdateVideo(form, rect, hostSource, hostCrop);
        }
        catch { preview.ClearVideo(); status.Text = "Prévia indisponível; use Mostrar Zoom"; }
    }
    void AttachJw(IntPtr target)
    {
        RestoreJw(); jw = target; jwOriginal = DesktopWindows.Save(jw);
        var work = Screen.FromHandle(jw).WorkingArea; var r = DesktopWindows.Bounds(jw);
        int width = Math.Min(500, Math.Max(380, work.Width / 3));
        form.WindowState = FormWindowState.Normal; form.Width = width;
        if (r.Width + width + 8 > work.Width)
        {
            var normal = jwOriginal; normal.ShowCmd = 1;
            normal.Normal = new DesktopWindows.Rect { Left = work.Left, Top = work.Top, Right = work.Right - width - 8, Bottom = work.Bottom };
            if (DesktopWindows.SetWindowPlacement(jw, ref normal)) jwResized = true;
        }
        FollowJw();
    }
    void FollowJw()
    {
        if (DesktopWindows.IsIconic(jw)) { preview.ClearVideo(); return; }
        var r = DesktopWindows.Bounds(jw); var work = Screen.FromHandle(jw).WorkingArea;
        var docked = DesktopGeometry.DockBounds(r, work, form.Width);
        if (!docked.IsEmpty && form.Bounds != docked)
            DesktopWindows.SetWindowPos(form.Handle, IntPtr.Zero, docked.X, docked.Y, docked.Width, docked.Height, 0x14);
    }
    void HideNativeZoom()
    {
        if (!DesktopWindows.IsZoom(zoom)) return;
        zoomOriginal = DesktopWindows.Save(zoom); zoomStyle = DesktopWindows.GetWindowLongPtr(zoom, -20);
        long style = (zoomStyle.ToInt64() | 0x80) & ~0x40000L;
        DesktopWindows.SetWindowLongPtr(zoom, -20, new IntPtr(style));
        var bounds = DesktopWindows.Bounds(zoom); var desktop = SystemInformation.VirtualScreen;
        // Keep rendering for the preview. SW_HIDE/minimize can stop composition.
        zoomHidden = DesktopWindows.SetWindowPos(zoom, IntPtr.Zero, desktop.Right + 128, desktop.Top,
            bounds.Width, bounds.Height, 0x34);
        if (!zoomHidden) DesktopWindows.SetWindowLongPtr(zoom, -20, zoomStyle);
        zoomButton.Text = zoomHidden ? "Mostrar Zoom" : "Ocultar Zoom";
    }
    void RestoreZoom(bool activate = true)
    {
        if (zoom == IntPtr.Zero || !DesktopWindows.IsWindow(zoom) || !DesktopWindows.IsZoom(zoom)) zoom = DesktopWindows.Zoom();
        if (zoomHidden && DesktopWindows.IsWindow(zoom) && DesktopWindows.IsZoom(zoom))
        {
            DesktopWindows.SetWindowLongPtr(zoom, -20, zoomStyle);
            DesktopWindows.SetWindowPlacement(zoom, ref zoomOriginal);
            DesktopWindows.SetWindowPos(zoom, IntPtr.Zero, 0, 0, 0, 0, 0x37);
        }
        zoomHidden = false; zoomButton.Text = "Ocultar Zoom";
        if (activate && zoom != IntPtr.Zero && DesktopWindows.IsZoom(zoom)) {
            var state = DesktopWindows.Save(zoom);
            bool maximized = state.ShowCmd == 3;
            if (DesktopWindows.IsIconic(zoom) || maximized) DesktopWindows.ShowWindow(zoom, 9);
            var work = Screen.FromControl(form).WorkingArea;
            var bounds = DesktopWindows.Bounds(zoom);
            int width = Math.Max(1, Math.Min(bounds.Width, work.Width));
            int height = Math.Max(1, Math.Min(bounds.Height, work.Height));
            DesktopWindows.SetWindowPos(zoom, IntPtr.Zero, work.Left + (work.Width-width)/2,
                work.Top + (work.Height-height)/2, width, height, 0x14);
            DesktopWindows.ShowWindow(zoom, maximized ? 3 : 5);
            DesktopWindows.SetForegroundWindow(zoom);
        }
    }
    void KeepOutsideDesktop(IntPtr handle)
    {
        var bounds = DesktopWindows.Bounds(handle); var screen = SystemInformation.VirtualScreen;
        if (!bounds.IsEmpty && screen.IntersectsWith(bounds))
            DesktopWindows.SetWindowPos(handle, IntPtr.Zero, screen.Right + 128, screen.Top, bounds.Width, bounds.Height, 0x14);
    }
    void RestoreJw()
    {
        if (jwResized && DesktopWindows.IsWindow(jw)) DesktopWindows.SetWindowPlacement(jw, ref jwOriginal);
        jw = IntPtr.Zero; jwResized = false;
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true; timer.Stop(); timer.Dispose(); preview.Dispose(); RestoreZoom(false); RestoreJw();
    }
}
