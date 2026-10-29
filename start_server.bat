@echo off
title Roblox WebRTC Spatial Voice Server
cd /d "%~dp0"
echo ========================================================
echo  Roblox WebRTC Spatial Voice Server (Local Dev)
echo  Open http://localhost:8000 in Chrome / Edge / Safari
echo ========================================================
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
pause
