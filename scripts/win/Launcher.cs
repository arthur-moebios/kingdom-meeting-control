using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System.Runtime.InteropServices;

// Native Windows app for the Kingdom Meeting Control operator panel. Starts the
// bundled Node server (hidden) and hosts the dashboard in a real native window
// via WebView2 (the Edge/Chromium control built into Windows) — no browser tabs
// or address bar. If WebView2 is unavailable it falls back to the default
// browser so the app always opens. Closing the window stops the server.
class Launcher
{
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    const string WebUrl = "http://127.0.0.1:4317/";

    [STAThread]
    static void Main(string[] args)
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        if (Array.IndexOf(args, "--install-startup") >= 0) { NativeStartup.Set(true); return; }
        if (Array.IndexOf(args, "--remove-startup") >= 0) { NativeStartup.Set(false); return; }
        bool native = Array.IndexOf(args, "--native-research") >= 0 ||
            (File.Exists(Path.Combine(dir, "app-server.mjs")) && File.Exists(Path.Combine(dir, "native-server.mjs")));
        bool attach = Array.IndexOf(args, "--attach-server") >= 0;
        bool fullNative = native && File.Exists(Path.Combine(dir, "app-server.mjs"));
        string url = native ? fullNative ? "http://127.0.0.1:4319/" : "http://127.0.0.1:4318/?native=1" : WebUrl;
        string serverPath = Path.Combine(dir, "server.mjs");
        System.Threading.Mutex singleton = null;
        if (native)
        {
            bool created;
            singleton = new System.Threading.Mutex(true, "Local\\KMC.NativeOperatorPanel", out created);
            if (!created) { singleton.Dispose(); MessageBox.Show("O painel nativo já está aberto."); return; }
        }
        if (!native && !attach) KillStaleServer(serverPath);
        Process server = attach ? null : native ? StartNativeServer(dir) : StartServer(dir);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var form = new Form
        {
            Text = native ? "Salão do Reino — Zoom nativo (experimental)" : "Salão do Reino — Painel do Operador",
            Width = fullNative ? 1280 : native ? 500 : 1200,
            Height = 820,
            StartPosition = FormStartPosition.CenterScreen,
            WindowState = fullNative || !native ? FormWindowState.Maximized : FormWindowState.Normal,
        };
        try
        {
            string ico = Path.Combine(dir, "app.ico");
            if (File.Exists(ico)) form.Icon = new System.Drawing.Icon(ico);
        }
        catch { }

        var web = new WebView2 { Dock = DockStyle.Fill };
        if (fullNative) NativeWindowLayout.Restore(form,dir);
        SplitContainer split = null;
        JwWorkspace workspace = null;
        Control surface = form;
        if (fullNative) {
            form.MinimumSize = new System.Drawing.Size(760, 500);
            split = new SplitContainer { Size = form.ClientSize, Dock = DockStyle.Fill, Panel1MinSize = 420, Panel2MinSize = 300, SplitterDistance = Math.Max(420, form.ClientSize.Width - 380) };
            split.Panel1Collapsed = true; surface = split.Panel2; form.Controls.Add(split);
            workspace = new JwWorkspace(form, split);
        }
        surface.Controls.Add(web);
        var desktop = native || Array.IndexOf(args, "--desktop-tools") >= 0 || Array.IndexOf(args, "--dock-jw") >= 0
            ? new OperatorDesktop(form, surface) : null;
        if (desktop != null && workspace != null) desktop.WorkspaceChanged += enabled => workspace.SetEnabled(enabled);
        form.Shown += (s, e) =>
        {
            if (desktop == null) return;
            if ((!fullNative && native || Array.IndexOf(args, "--dock-jw") >= 0) && Array.IndexOf(args, "--no-dock") < 0) desktop.EnableDock();
            if (native && Array.IndexOf(args, "--keep-zoom") < 0) desktop.HideZoom();
        };

        form.Load += async (s, e) =>
        {
            try
            {
                // Keep the WebView2 profile in LocalAppData (the install folder may
                // be read-only / protected).
                string udf = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "KingdomMeetingControl", native ? "webview2-native-research" : "webview2");
                Directory.CreateDirectory(udf);
                var env = await CoreWebView2Environment.CreateAsync(null, udf);
                await web.EnsureCoreWebView2Async(env);
                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                if (fullNative && desktop != null) desktop.EmbedCamera(web);
                WaitForServer(url);
                web.CoreWebView2.Navigate(url);
            }
            catch
            {
                // WebView2 runtime missing or failed: fall back to the browser so
                // the operator still gets the panel.
                WaitForServer(url);
                try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
                form.Close();
            }
        };

        form.FormClosing += (s, e) => { if (fullNative) NativeWindowLayout.Save(form,dir); if (workspace != null) workspace.Dispose(); if (desktop != null) desktop.Dispose(); if (native && !attach) StopNativeServer(server, fullNative); else StopServer(server); };

        Application.Run(form);
        StopServer(server);
        if (singleton != null) { singleton.ReleaseMutex(); singleton.Dispose(); }
    }

    static Process StartNativeServer(string dir)
    {
        var start = new ProcessStartInfo
        {
            FileName = Path.Combine(dir, "node.exe"),
            Arguments = "\"" + Path.Combine(dir, File.Exists(Path.Combine(dir, "app-server.mjs")) ? "app-server.mjs" : "native-server.mjs") + "\"",
            WorkingDirectory = dir, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        start.EnvironmentVariables["KMC_PARENT_PROCESS_MANAGED"] = "1";
        if (File.Exists(Path.Combine(dir, "app-server.mjs"))) {
            start.EnvironmentVariables["KMC_ZOOM_BACKEND"] = "native";
            start.EnvironmentVariables["KMC_BASE_DIR"] = dir;
            start.EnvironmentVariables["KMC_DATA_DIR"] = Path.Combine(dir, "data-native");
            start.EnvironmentVariables["KMC_PUBLIC_DIR"] = Path.Combine(dir, "public");
            start.EnvironmentVariables["KMC_PORT"] = "4319";
            start.EnvironmentVariables["KMC_HOST"] = "0.0.0.0";
        }
        return Process.Start(start);
    }

    static void StopNativeChildren(Process server)
    {
        try
        {
            if (server == null || server.HasExited) return;
            using (var searcher = new ManagementObjectSearcher("SELECT ProcessId FROM Win32_Process WHERE ParentProcessId = " + server.Id))
                foreach (ManagementObject item in searcher.Get())
                    try { Process.GetProcessById(Convert.ToInt32(item["ProcessId"])).Kill(); } catch { }
        }
        catch { }
    }

    static void StopNativeServer(Process server, bool fullNative)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(fullNative ? "http://127.0.0.1:4319/api/v1/system/shutdown" : "http://127.0.0.1:4318/api/v1/native/shutdown");
            request.Method = "POST"; request.ContentType = "application/json";
            request.Headers["Origin"] = "http://127.0.0.1:4318";
            request.ContentLength = 2; request.Timeout = 10000;
            using (var output = request.GetRequestStream()) { var bytes = System.Text.Encoding.UTF8.GetBytes("{}"); output.Write(bytes, 0, bytes.Length); }
            using (var response = request.GetResponse()) { }
            if (server != null && !server.HasExited) server.WaitForExit(2000);
        }
        catch { }
        StopNativeChildren(server); StopServer(server);
    }

    static void KillStaleServer(string serverPath)
    {
        // With the console hidden the user can't Ctrl+C an old run, so a stale
        // Node could hold port 4317. Kill node processes running OUR server.mjs.
        try
        {
            using (var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
            {
                foreach (ManagementObject mo in searcher.Get())
                {
                    var cmd = mo["CommandLine"] as string;
                    if (cmd != null && cmd.IndexOf(serverPath, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        try { Process.GetProcessById(Convert.ToInt32(mo["ProcessId"])).Kill(); }
                        catch { }
                    }
                }
            }
            System.Threading.Thread.Sleep(600);
        }
        catch { }
    }

    static Process StartServer(string dir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = Path.Combine(dir, "node.exe"),
            Arguments = "\"" + Path.Combine(dir, "server.mjs") + "\"",
            WorkingDirectory = dir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        psi.EnvironmentVariables["KMC_BASE_DIR"] = dir;
        psi.EnvironmentVariables["KMC_PUBLIC_DIR"] = Path.Combine(dir, "public");
        psi.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"] = Path.Combine(dir, "ms-playwright");
        // Bind to the LAN so the tribune tablet can reach it.
        psi.EnvironmentVariables["KMC_HOST"] = "0.0.0.0";
        return Process.Start(psi);
    }

    static void StopServer(Process server)
    {
        try { if (server != null && !server.HasExited) server.Kill(); }
        catch { }
    }

    // Poll the health endpoint so we navigate only once the server is listening.
    static void WaitForServer(string url)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(new Uri(url).GetLeftPart(UriPartial.Authority) + "/api/v1/health");
                req.Timeout = 1500;
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    if (resp.StatusCode == HttpStatusCode.OK) return;
                }
            }
            catch { }
            System.Threading.Thread.Sleep(500);
        }
    }
}
