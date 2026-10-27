using System;
using System.Diagnostics;
using System.IO;
using System.Management;

// Tiny launcher for the packaged Windows app. Sets the packaged layout via env
// vars and starts the bundled Node server, then opens the operator dashboard.
class Launcher
{
    static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string serverPath = Path.Combine(dir, "server.mjs");

        // Replace any previous instance first. With the console hidden the user
        // can't Ctrl+C an old run, so a stale Node could hold port 4317 and make
        // the new instance fail to bind (dashboard then shows a broken/blank
        // page). Kill node processes running OUR server.mjs before starting.
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

        var psi = new ProcessStartInfo
        {
            FileName = Path.Combine(dir, "node.exe"),
            Arguments = "\"" + Path.Combine(dir, "server.mjs") + "\"",
            WorkingDirectory = dir,
            UseShellExecute = false,
            // Run the Node server without a visible console window (no terminal).
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        psi.EnvironmentVariables["KMC_BASE_DIR"] = dir;
        psi.EnvironmentVariables["KMC_PUBLIC_DIR"] = Path.Combine(dir, "public");
        psi.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"] = Path.Combine(dir, "ms-playwright");
        // Bind to the LAN so the tribune tablet can reach it (protected by tokens).
        psi.EnvironmentVariables["KMC_HOST"] = "0.0.0.0";

        var server = Process.Start(psi);

        // Open the operator dashboard (controls) in the default browser.
        try
        {
            Process.Start(new ProcessStartInfo("http://127.0.0.1:4317/") { UseShellExecute = true });
        }
        catch { /* ignore */ }

        server.WaitForExit();
    }
}
