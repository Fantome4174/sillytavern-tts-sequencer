$extensionPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$edgePaths = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)

$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) {
  Write-Host "Microsoft Edge was not found."
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host "Please close all Microsoft Edge windows."
Write-Host "This window will reopen Edge with the extension loaded after Edge is fully closed."

while (Get-Process msedge -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds 1
}

Start-Process -FilePath $edge -ArgumentList @(
  "--profile-directory=Profile 1",
  "--load-extension=$extensionPath",
  "--new-window",
  "about:blank"
)
