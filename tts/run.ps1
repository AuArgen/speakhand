Set-Location $PSScriptRoot
if (-not (Test-Path ".venv\Scripts\python.exe")) { Write-Host "Алгач ./setup.ps1 иштетиңиз"; exit 1 }
.\.venv\Scripts\python.exe server.py --preload
