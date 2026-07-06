$extensionPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$profilePath = Join-Path $extensionPath "edge-profile"
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

New-Item -ItemType Directory -Force -Path $profilePath | Out-Null

Start-Process -FilePath $edge -ArgumentList @(
  "--user-data-dir=$profilePath",
  "--load-extension=$extensionPath",
  "--new-window",
  "about:blank"
)
