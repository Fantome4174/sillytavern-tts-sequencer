$extensionPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$profilePath = Join-Path $extensionPath "chrome-profile"
$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  Write-Host "没有找到 Google Chrome。请安装 Chrome，或手动在 Chrome/Edge 扩展页加载此文件夹。"
  Read-Host "按回车退出"
  exit 1
}

New-Item -ItemType Directory -Force -Path $profilePath | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profilePath",
  "--load-extension=$extensionPath",
  "--new-window",
  "about:blank"
)
