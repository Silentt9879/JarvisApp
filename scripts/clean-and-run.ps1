# Removes every installed/leftover copy of JARVIS on this PC, then (optionally) launches one exe.
#
#   npm run clean           just clean - kill running copies, uninstall, clear old installers
#   npm run clean -- -Run "C:\Users\User\Downloads\JARVIS-Setup-1.12.0.exe"
#                            clean, then launch the installer/exe you just downloaded
#
# Safe to re-run: every step no-ops if there's nothing left to do.

param(
    [string]$Run
)

$ErrorActionPreference = 'Continue'
$installDir = "$env:LOCALAPPDATA\Programs\JARVIS"
$distDir = Join-Path $PSScriptRoot '..\dist-installer' | Resolve-Path -ErrorAction SilentlyContinue

Write-Host "== Stopping running JARVIS instances =="
$procs = Get-Process -Name JARVIS -ErrorAction SilentlyContinue
if ($procs) {
    $procs | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    Write-Host "  stopped $($procs.Count) process(es)"
} else {
    Write-Host "  none running"
}

Write-Host "== Uninstalling the installed copy =="
$uninstaller = Join-Path $installDir 'Uninstall JARVIS.exe'
if (Test-Path $uninstaller) {
    Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
    Start-Sleep -Milliseconds 500
}
if (Test-Path $installDir) {
    Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
    Write-Host "  removed $installDir"
} else {
    Write-Host "  nothing installed"
}

Write-Host "== Clearing old local installer builds =="
if ($distDir -and (Test-Path $distDir)) {
    Get-ChildItem $distDir -Filter 'JARVIS-Setup-*.exe*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $distDir 'win-unpacked') -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  cleared $distDir"
} else {
    Write-Host "  no dist-installer folder"
}

if ($Run) {
    if (Test-Path $Run) {
        Write-Host "== Launching $Run =="
        Start-Process -FilePath $Run
    } else {
        Write-Error "Not found: $Run"
        exit 1
    }
} else {
    Write-Host "== Done. Nothing old left - install or launch the new build whenever you are ready. =="
}
