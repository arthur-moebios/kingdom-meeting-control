using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Native Windows app for the Kingdom Meeting Control operator panel. Starts the
// bundled Node server (hidden) and hosts the dashboard in a real native window
// via WebView2 (the Edge/Chromium control built into Windows) — no browser tabs
// or address bar. If WebView2 is unavailable it falls back to the default
// browser so the app always opens. Closing the window stops the server.
class Launcher
{
    const string Url = "http://127.0.0.1:4317/";

    [STAThread]
    static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string serverPath = Path.Combine(dir, "server.mjs");

        KillStaleServer(serverPath);
        Process server = StartServer(dir);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var form = new Form
        {
            Text = "Salão do Reino — Painel do Operador",
            Width = 1200,
            Height = 820,
            StartPosition = FormStartPosition.CenterScreen,
            WindowState = FormWindowState.Maximized,
        };
        try
        {
            string ico = Path.Combine(dir, "app.ico");
            if (File.Exists(ico)) form.Icon = new System.Drawing.Icon(ico);
        }
        catch { }

        var web = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(web);

        form.Load += async (s, e) =>
        {
            try
            {
                // Keep the WebView2 profile in LocalAppData (the install folder may
                // be read-only / protected).
                string udf = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "KingdomMeetingControl", "webview2");
                Directory.CreateDirectory(udf);
                var env = await CoreWebView2Environment.CreateAsync(null, udf);
                await web.EnsureCoreWebView2Async(env);
                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                WaitForServer();
                web.CoreWebView2.Navigate(Url);
            }
            catch
            {
                // WebView2 runtime missing or failed: fall back to the browser so
                // the operator still gets the panel.
                WaitForServer();
                try { Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true }); } catch { }
                form.Close();
            }
        };

        form.FormClosing += (s, e) => StopServer(server);

        Application.Run(form);
        StopServer(server);
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
    static void WaitForServer()
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(Url + "api/v1/health");
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
