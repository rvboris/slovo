# Standalone check: does SendInput-injected Ctrl+Shift+Space trigger RegisterHotKey?
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class HotkeyProbe : NativeWindow {
  public const int WM_HOTKEY = 0x0312;
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);

  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  public static bool Fired;

  public HotkeyProbe() {
    CreateHandle(new CreateParams());
    // MOD_CONTROL=2 | MOD_SHIFT=4, VK_SPACE=0x20
    bool ok = RegisterHotKey(Handle, 1, 2 | 4, 0x20);
    Console.WriteLine("RegisterHotKey ok=" + ok);
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY) {
      Console.WriteLine("WM_HOTKEY received, id=" + m.WParam);
      Fired = true;
      Application.ExitThread();
      return;
    }
    base.WndProc(ref m);
  }

  public static void Key(ushort vk, ushort scan, bool up) {
    var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = up ? 2u : 0u;
    SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void StartInject() { new Thread(Inject).Start(); }
  public static void Inject() {
    Thread.Sleep(800);
    // With scan codes this time (Ctrl=0x1D, Shift=0x2A, Space=0x39)
    Key(0x11, 0x1D, false); Key(0x10, 0x2A, false); Key(0x20, 0x39, false);
    Thread.Sleep(400);
    Key(0x20, 0x39, true); Key(0x10, 0x2A, true); Key(0x11, 0x1D, true);
    Console.WriteLine("input injected");
  }
}
'@ -ReferencedAssemblies System.Windows.Forms.dll, System.dll
$probe = New-Object HotkeyProbe
[HotkeyProbe]::StartInject()
$exitAt = [DateTime]::UtcNow.AddSeconds(6)
while (-not [HotkeyProbe]::Fired -and [DateTime]::UtcNow -lt $exitAt) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 50
}
Write-Host ("Result: " + $(if ([HotkeyProbe]::Fired) { "HOTKEY FIRED" } else { "NO HOTKEY" }))
