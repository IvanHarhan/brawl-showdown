# Запасной вариант: сервер на этом ПК + публичная ссылка через cloudflared quick tunnel.
# Запуск:  powershell -ExecutionPolicy Bypass -File start-local.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

if (-not (Test-Path node_modules)) { npm install }
# клиент без VITE_SERVER_URL ходит на тот же адрес, с которого открыт
Remove-Item Env:VITE_SERVER_URL -ErrorAction SilentlyContinue
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$env:PORT = '2567'
$server = Start-Process node -ArgumentList 'server/dist/index.js' -PassThru -NoNewWindow
Start-Sleep 2

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host 'cloudflared не найден, ставлю...'
  winget install --id Cloudflare.cloudflared -e --silent --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host ''
Write-Host 'Локально: http://localhost:2567'
Write-Host 'Публичная ссылка появится ниже (строка с trycloudflare.com). Ctrl+C — остановить.'
Write-Host ''
try {
  cloudflared tunnel --no-autoupdate --url http://localhost:2567 2>&1 | ForEach-Object {
    $line = "$_"
    if ($line -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
      Write-Host ''
      Write-Host "ССЫЛКА ДЛЯ ДРУЗЕЙ: $($Matches[0])" -ForegroundColor Green
      Start-Process $Matches[0]
    }
  }
} finally {
  Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
}
