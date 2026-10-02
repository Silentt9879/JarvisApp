# Swap dist-next\win-unpacked in for dist\win-unpacked and restart JARVIS.
# Run detached: it closes the JARVIS that started it.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\User\Downloads\JARVIS_App'
$live = Join-Path $root 'dist\win-unpacked'
$next = Join-Path $root 'dist-next\win-unpacked'
$old  = Join-Path $root 'dist\win-unpacked.old'
$logf = Join-Path $root 'swap-update.log'
function Log($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 $logf }

try {
  Start-Sleep -Seconds 4
  Log 'closing JARVIS'
  Get-Process JARVIS -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$live*" } | Stop-Process -Force
  for ($i = 0; $i -lt 30 -and (Get-Process JARVIS -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$live*" }); $i++) { Start-Sleep -Milliseconds 500 }
  Start-Sleep -Seconds 2
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
  Move-Item $live $old
  Move-Item $next $live
  Log 'swapped; old copy kept at dist\win-unpacked.old'
} catch {
  Log "swap failed: $($_.Exception.Message)"
  if (-not (Test-Path $live) -and (Test-Path $old)) { Move-Item $old $live; Log 'restored old copy' }
}
Start-Process (Join-Path $live 'JARVIS.exe')
Log 'JARVIS started'
