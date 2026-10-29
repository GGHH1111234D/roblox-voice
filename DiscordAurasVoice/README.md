# Discord Interactive Auras Voice System (Roblox + 5-Node Bot Fleet)

A 100% free, rate-limit-resistant proximity & private-whisper voice architecture connecting **Roblox** to **Discord** via a **Round-Robin Python 3.12 Bot Fleet**.

## Quick Start

### 1. Start the Python FastAPI + 5-Node Bot Fleet Server
Open PowerShell and run:
```powershell
cd "c:\Users\GHASSAN\Documents\DiscordAurasVoice"
.\.venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000
```
*(Or double-click `start_server.bat`.)*

### 2. Expose to Live Roblox Servers (Cloudflare Tunnel or ngrok)
> **Note:** In **Roblox Studio Playtest**, `http://127.0.0.1:8000` works out of the box with zero tunnel needed! You only need a tunnel when publishing to **Live Roblox Servers**.

- **Option A — Cloudflare Quick Tunnel (100% Free, No Account Required):**
  ```powershell
  winget install --id Cloudflare.cloudflared --accept-package-agreements --accept-source-agreements
  cloudflared tunnel --url http://localhost:8000
  ```
- **Option B — ngrok (Already installed on your PC):**
  ```powershell
  ngrok http 8000
  ```

Copy the generated `https://...` URL and paste it into the **`BackendUrl`** Attribute on `ServerScriptService > AuraVoiceServer` in Roblox Studio!
