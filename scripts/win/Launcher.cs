using System;
using System.Diagnostics;
using System.IO;

// Tiny launcher for the packaged Windows app. Sets the packaged layout via env
// vars and starts the bundled Node server, then opens the operator dashboard.
class Launcher
{
    static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

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
