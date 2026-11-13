# Reports which Windows processes hold an open handle on a file.
#
# node cannot query the Restart Manager API directly, and `release\win-unpacked\resources\app.asar`
# is exactly the kind of file that stays open after an editor previewed it or a packaged app was
# left running. `scripts/prepare-release.mjs` calls this script with the path from the failed
# delete, and prints the owner instead of electron-builder's bare EBUSY.

param([Parameter(Mandatory = $true)][string]$Path)

$signature = @"
using System;
using System.Runtime.InteropServices;
public static class ReleaseLockReport {
  [StructLayout(LayoutKind.Sequential)] public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, System.Text.StringBuilder strSessionKey);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In,Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

  // Returns one "pid|image|app" line per owning process, or "NO_LOCKERS" when Windows reports none.
  public static string Find(string path) {
    uint handle;
    var key = new System.Text.StringBuilder(256);
    if (RmStartSession(out handle, 0, key) != 0) return "RM_ERROR|session";
    try {
      string[] files = new string[] { path };
      if (RmRegisterResources(handle, 1, files, 0, null, 0, null) != 0) return "RM_ERROR|register";
      uint needed = 0, count = 0, reasons = 0;
      RmGetList(handle, out needed, ref count, null, ref reasons);
      if (needed == 0) return "NO_LOCKERS";
      count = needed;
      var infos = new RM_PROCESS_INFO[count];
      if (RmGetList(handle, out needed, ref count, infos, ref reasons) != 0) return "RM_ERROR|list";
      var lines = new System.Text.StringBuilder();
      for (int i = 0; i < count; i++) {
        string image = "";
        try { image = System.Diagnostics.Process.GetProcessById(infos[i].Process.dwProcessId).ProcessName + ".exe"; } catch { }
        lines.Append(infos[i].Process.dwProcessId + "|" + image + "|" + infos[i].strAppName + "\n");
      }
      return lines.ToString();
    }
    finally { RmEndSession(handle); }
  }
}
"@

Add-Type -TypeDefinition $signature -Language CSharp
Write-Output "target=$((Resolve-Path -LiteralPath $Path).Path)"
Write-Output ([ReleaseLockReport]::Find((Resolve-Path -LiteralPath $Path).Path))
