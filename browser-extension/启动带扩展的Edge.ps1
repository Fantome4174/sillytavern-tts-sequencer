$extensionPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$profilePath = Join-Path $extensionPath "edge-profile"
$edgePaths = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)

$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) {
  Write-Host "没有找到 Microsoft Edge。请安装 Edge，或手动在 Chrome/Edge 扩展页加载此文件夹。"
  Read-Host "按回车退出"
  exit 1
}

New-Item -ItemType Directory -Force -Path $profilePath | Out-Null

Start-Process -FilePath $edge -ArgumentList @(
  "--user-data-dir=$profilePath",
  "--load-extension=$extensionPath",
  "--new-window",
  "about:blank"
)
