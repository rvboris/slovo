# Captures a PNG of the recording-overlay area: bottom-center strip of the
# primary screen, generously padded so any window border would be visible.
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$sw = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$dpi = 1
# Use primary screen bounds (physical px as .NET reports them).
$w = $sw.Width; $h = $sw.Height
$regionW = 400; $regionH = 160
$x = [int](($w - $regionW) / 2)
$y = $h - $regionH - 10
$bmp = New-Object System.Drawing.Bitmap($regionW, $regionH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save("C:\Users\user\mygit\slovo\overlay-after.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "saved overlay-after.png region ${regionW}x${regionH} at ($x,$y), screen ${w}x${h}"
