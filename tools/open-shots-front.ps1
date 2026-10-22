$sig = @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[DllImport("user32.dll")] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder sb, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
'@
Add-Type -MemberDefinition $sig -Name W -Namespace U -ErrorAction SilentlyContinue

$path = $args[0]
if (-not $path) { 'NO_PATH'; exit 1 }
Start-Process explorer.exe -ArgumentList ('"' + $path + '"')
Start-Sleep -Milliseconds 1500

$script:top = [System.IntPtr]::Zero
$cb = [U.W+EnumProc]{
  param([System.IntPtr]$h, [System.IntPtr]$l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][U.W]::GetClassName($h, $sb, 256)
  if ($sb.ToString() -eq 'CabinetWClass' -and [U.W]::IsWindowVisible($h)) { $script:top = $h; return $false }
  return $true
}
[void][U.W]::EnumWindows($cb, [System.IntPtr]::Zero)
if ($script:top -ne [System.IntPtr]::Zero) {
  $TOPMOST = [System.IntPtr]::New(-1); $NOTOPMOST = [System.IntPtr]::New(-2)
  $flags = 0x0001 -bor 0x0002 -bor 0x0040   # NOSIZE | NOMOVE | SHOWWINDOW
  [void][U.W]::SetWindowPos($script:top, $TOPMOST, 0,0,0,0, $flags)
  [void][U.W]::SetWindowPos($script:top, $NOTOPMOST, 0,0,0,0, $flags)
  'FRONT_OK'
} else { 'NOT_FOUND' }
