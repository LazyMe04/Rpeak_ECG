# Capture the Rpeak window as the desktop actually shows it.
#
# `smoke-app.ts` drives the page over CDP, so it proves the DOM is right. It
# cannot see whether the *window* fits the screen: a window whose bottom 58 px
# hang below the taskbar still has a perfectly correct 1400x880 page inside it.
# This script is the other half of that check.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File app/scripts/shot-window.ps1 -Out logs/window.png
#   ... -ProcessName rpeak     # default
#
# SetProcessDPIAware is not optional. Without it Windows virtualises every
# coordinate a process asks for: on a 1920x1080 screen at 125% this shell is told
# the screen is 1536x864, GetWindowRect returns physical/1.25, and CopyFromScreen
# grabs a downscaled region. That is exactly how a window that fits looked like
# it was clipped at the bottom during G6.

param(
    [string]$ProcessName = "rpeak",
    [string]$Out = "window.png"
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RpeakWindow {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[RpeakWindow]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing

$p = Get-Process -Name $ProcessName -ErrorAction Stop |
     Where-Object { $_.MainWindowHandle -ne 0 } |
     Select-Object -First 1
if (-not $p) { Write-Error "no window for process '$ProcessName'"; exit 1 }

$h = $p.MainWindowHandle
[RpeakWindow]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
[RpeakWindow]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700

$r = New-Object RpeakWindow+RECT
[RpeakWindow]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { Write-Error "bad window rect ${w}x${ht}"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

$dpi = [RpeakWindow]::GetDpiForWindow($h)
Write-Output ("{0}  {1}x{2} px at {3},{4}  dpi {5} (scale {6:0.##})  title='{7}'" -f `
    $Out, $w, $ht, $r.Left, $r.Top, $dpi, ($dpi / 96.0), $p.MainWindowTitle)
