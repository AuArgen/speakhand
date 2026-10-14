$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path ".venv\Scripts\python.exe")) { python -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -c "from transformers import VitsModel, AutoTokenizer; AutoTokenizer.from_pretrained('facebook/mms-tts-kir'); VitsModel.from_pretrained('facebook/mms-tts-kir'); print('model ready')"
