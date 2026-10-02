# Start Menu and desktop shortcuts for the packaged JARVIS, carrying its app id.
#   npm run shortcuts      (after npm run pack)
#
# Windows groups taskbar buttons and notifications by app id (AppUserModelID), and finds the
# name and icon for an id through a Start Menu shortcut that carries it. Without one, it
# makes do with whatever it saw first - which, on a machine where the app was also run in
# development as electron.exe, was Electron's atom. A shortcut with the id settles it: the
# taskbar button, the notifications and Start all say JARVIS, with the J.
#
# WScript.Shell cannot write an app id, so this goes through IShellLink and IPropertyStore.
# Safe to run again: both shortcuts are simply rewritten.

$ErrorActionPreference = 'Stop'
# Both must match IDENTITY in src/main.mjs (the packaged values). The activator is the COM
# class a notification click starts; a Start Menu shortcut carrying the id AND the activator
# is what Electron looks for before it writes a shortcut of its own - which, from a
# development run, is how "Electron.lnk" once took over JARVIS's name and icon.
$AppId = 'com.bantuapps.jarvis'
$ToastActivator = '{445FDA2C-DFA5-4369-88E1-B275092CB054}'
$Exe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\win-unpacked\JARVIS.exe'))
if (-not (Test-Path $Exe)) { throw "JARVIS.exe not found at $Exe - run 'npm run pack' first." }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace JarvisShortcut {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink { }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int cch, IntPtr fd, int flags);
    void GetIDList(out IntPtr pidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetHotkey(out short k);
    void SetHotkey(short k);
    void GetShowCmd(out int c);
    void SetShowCmd(int c);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int cch, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, int r);
    void Resolve(IntPtr hwnd, int flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  // VT_LPWSTR only; 24 bytes, the x64 size of a PROPVARIANT.
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    void GetCount(out uint n);
    void GetAt(uint i, out PROPERTYKEY k);
    void GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    void SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
    void Commit();
  }

  public static class Link {
    // PKEY_AppUserModel_ID and PKEY_AppUserModel_ToastActivatorCLSID
    static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    static PROPERTYKEY AppIdKey() { return new PROPERTYKEY { fmtid = AppUserModel, pid = 5 }; }
    static PROPERTYKEY ActivatorKey() { return new PROPERTYKEY { fmtid = AppUserModel, pid = 26 }; }
    const ushort VT_LPWSTR = 31, VT_CLSID = 72;
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);

    public static void Write(string lnk, string target, string description, string appId, string activator) {
      var link = (IShellLinkW)new CShellLink();
      link.SetPath(target);
      link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(target));
      link.SetIconLocation(target, 0);
      link.SetDescription(description);
      var store = (IPropertyStore)link;
      var idKey = AppIdKey();
      var id = new PROPVARIANT { vt = VT_LPWSTR, p = Marshal.StringToCoTaskMemUni(appId) };
      var clsKey = ActivatorKey();
      var cls = new PROPVARIANT { vt = VT_CLSID, p = Marshal.AllocCoTaskMem(16) };
      try {
        Marshal.Copy(new Guid(activator).ToByteArray(), 0, cls.p, 16);
        store.SetValue(ref idKey, ref id);
        store.SetValue(ref clsKey, ref cls);
        store.Commit();
      } finally { Marshal.FreeCoTaskMem(id.p); Marshal.FreeCoTaskMem(cls.p); }
      ((IPersistFile)link).Save(lnk, true);
    }

    /** Read both values back, so the script reports what Windows will actually see. */
    public static string Read(string lnk) {
      var link = (IShellLinkW)new CShellLink();
      ((IPersistFile)link).Load(lnk, 0);
      var store = (IPropertyStore)link;
      string appId = null, activator = null;
      PROPVARIANT v;
      var k1 = AppIdKey();
      store.GetValue(ref k1, out v);
      try { if (v.vt == VT_LPWSTR) appId = Marshal.PtrToStringUni(v.p); } finally { PropVariantClear(ref v); }
      var k2 = ActivatorKey();
      store.GetValue(ref k2, out v);
      try {
        if (v.vt == VT_CLSID) { var b = new byte[16]; Marshal.Copy(v.p, b, 0, 16); activator = new Guid(b).ToString("B").ToUpperInvariant(); }
      } finally { PropVariantClear(ref v); }
      return appId + "|" + activator;
    }
  }
}
'@

$places = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'JARVIS.lnk'),   # Start Menu
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'JARVIS.lnk')
)
foreach ($lnk in $places) {
  [JarvisShortcut.Link]::Write($lnk, $Exe, 'JARVIS - a desktop app for Claude Code', $AppId, $ToastActivator)
  $id, $act = ([JarvisShortcut.Link]::Read($lnk)) -split '\|'
  if ($id -ne $AppId -or $act -ne $ToastActivator.ToUpperInvariant()) { throw "Wrote $lnk but it reads back as '$id' / '$act'." }
  "ok   $lnk  (app id $id, activator $act)"
}

# A shortcut Electron wrote for itself from a development run - electron.exe under a JARVIS
# app id - is what put the atom on the real app. Remove any such leftover, but only one that
# points at this repository's electron.exe; anything else in Start is not ours to touch.
$devExe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\node_modules\electron\dist\electron.exe'))
$sh = New-Object -ComObject WScript.Shell
Get-ChildItem -Path ([Environment]::GetFolderPath('Programs')) -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
  if ($sh.CreateShortcut($_.FullName).TargetPath -ieq $devExe) {
    Remove-Item $_.FullName -Force
    "ok   removed $($_.Name) - a development run's shortcut for electron.exe"
  }
}

# Ask Explorer to drop its cached icons, so the J replaces the atom without a sign-out.
# The taskbar itself may hold on to an old icon until JARVIS is next started.
Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList '-show' -Wait -WindowStyle Hidden
'ok   icon cache refreshed'
