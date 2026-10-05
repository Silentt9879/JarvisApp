# Swap dist-next\win-unpacked in for dist\win-unpacked and restart JARVIS.
# Run detached: it closes the JARVIS that started it.
$ErrorActionPreference = 'Stop'
# The project folder this script lives in, wherever it was cloned - it once named the
# original machine's path, and swapped nothing anywhere else.
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$live = Join-Path $root 'dist\win-unpacked'
$next = Join-Path $root 'dist-next\win-unpacked'
$old  = Join-Path $root 'dist\win-unpacked.old'
$logf = Join-Path $root 'swap-update.log'
function Log($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 $logf }

try {
  Start-Sleep -Seconds 4
  Log 'closing JARVIS'
  # Everything running from the live folder - JARVIS and the claude.exe sessions it started,
  # which outlive a forced close and keep the folder locked.
  $inLive = { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$live*" } }
  & $inLive | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30 -and (& $inLive); $i++) { Start-Sleep -Milliseconds 500; & $inLive | Stop-Process -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  # A closed process's files can stay locked for a few seconds (handles closing, a virus
  # scan), so each step is retried for up to 30 s, naming anything still running from the folder.
  function Retry($what, $step) {
    for ($n = 1; ; $n++) {
      try { & $step; return } catch {
        if ($n -ge 30) { throw "$what - $($_.Exception.Message)" }
        if ($n -eq 1 -or $n % 10 -eq 0) { Log "$what blocked (try $n): $($_.Exception.Message); still running: $((& $inLive | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join ', ')" }
        & $inLive | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
      }
    }
  }
  # Copied, not renamed: Windows refuses to rename a folder while anything (Search, a virus
  # scan) has it open, but the files themselves are free once JARVIS is closed.
  # robocopy: exit codes below 8 mean success.
  function Mirror($from, $to, $what) {
    Retry $what { robocopy $from $to /MIR /R:5 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null; if ($LASTEXITCODE -ge 8) { throw "robocopy exit $LASTEXITCODE" } }
  }
  Mirror $live $old 'backing up the live copy'
  Mirror $next $live 'copying the new build in'
  Remove-Item -Recurse -Force $next -ErrorAction SilentlyContinue
  Log 'swapped; old copy kept at dist\win-unpacked.old'
} catch {
  Log "swap failed: $($_.Exception.Message)"
  # Failed partway through copying the new build in: put the backup back, so JARVIS is never half one version and half the other.
  if ("$_" -like 'copying the new build in*' -and (Test-Path $old)) { robocopy $old $live /MIR /R:5 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null; Log 'restored old copy' }
}
Start-Process (Join-Path $live 'JARVIS.exe')
Log 'JARVIS started'
