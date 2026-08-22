# Sends Ctrl+Shift+Space (default Slovo hotkey) via SendInput for smoke tests.
# Usage: powershell -NoProfile -File send-hotkey.ps1
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class K {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  public static void Key(ushort vk, ushort scan, bool up) {
    var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = up ? 2u : 0u;
    SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[K]::Key(0x11, 0x1D, $false); [K]::Key(0x31, 0x02, $false)
Start-Sleep -Milliseconds 600
[K]::Key(0x31, 0x02, $true); [K]::Key(0x11, 0x1D, $true)
Write-Host "hotkey sent"
