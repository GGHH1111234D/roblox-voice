@echo off
title Discord Interactive Auras Voice System — Bot Fleet Server
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo [Setup] Creating Python 3.12 virtual environment...
    py -3.12 -m venv .venv
    .venv\Scripts\pip.exe install --trusted-host pypi.org --trusted-host files.pythonhosted.org -r requirements.txt
)
echo [Starting] Launching FastAPI + 5-Node Discord Bot Fleet on http://localhost:8000 ...
.venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000
pause
