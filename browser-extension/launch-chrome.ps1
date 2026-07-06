$extensionPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$profilePath = Join-Path $extensionPath "chrome-profile"
$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  Write-Host "Google Chrome was not found."
  Read-Host "Press Enter to exit"
  exit 1
}

New-Item -ItemType Directory -Force -Path $profilePath | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profilePath",
  "--load-extension=$extensionPath",
  "--new-window",
  "about:blank"
)
