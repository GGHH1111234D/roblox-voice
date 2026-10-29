@echo off
title Roblox WebRTC Spatial Voice + ngrok Tunnel
cd /d "%~dp0"

echo ===================================================================
echo   Roblox WebRTC 3D Spatial Voice (FastAPI + ngrok)
echo ===================================================================
echo.
echo 1. Starting FastAPI Server on port 8000...
start "FastAPI Server" cmd /k "python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

timeout /t 2 >nul

echo 2. Starting ngrok public tunnel for Roblox and Mobile Phone...
start "ngrok Tunnel" cmd /k "ngrok http 8000"

echo.
echo ===================================================================
echo [SUCCESS] Both servers are running!
echo - Local Web Page: http://localhost:8000
echo - Check ngrok window for your public HTTPS link (e.g. https://xxxx.ngrok-free.app)
echo - Put that public link into SpatialVoiceServer in Roblox if playing live!
echo ===================================================================
pause
