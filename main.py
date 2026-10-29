"""
WebRTC 3D Spatial Audio — Signaling + Location Relay Server (FastAPI)
=====================================================================
نظام صوت مكاني ثلاثي الأبعاد يربط متصفح اللاعب بشخصيته في روبلوكس عبر الـ UserId.

Data flow:
  Roblox server  --(POST /update_locations every 0.5s)-->  this server (in-memory dict)
  this server    --(WebSocket "locations" every 0.5s)--->  every browser
  browser        --(Web Audio PannerNode per remote peer)-> 3D voice

Responsibilities:
  1. `POST /update_locations` receives `{ "<UserId>": {x, y, z, yaw?, username?}, ... }`
     from one or more Roblox servers (each tagged by the `X-Job-Id` header).
  2. Keeps the latest position of every player in a global in-memory dictionary, merging
     batches from multiple Roblox servers and expiring players that stop reporting.
  3. Relays WebRTC signaling (offer / answer / ICE) between browsers over `/ws`.
  4. Broadcasts the full location dictionary + a peerId -> UserId map to every connected
     browser every 0.5s, so each browser can place every remote voice in 3D space.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Union

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
)
logger = logging.getLogger("roblox-spatial-voice")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# How often browsers receive the location snapshot. Matches Roblox's 0.5s send rate.
LOCATION_BROADCAST_INTERVAL = 0.5
# A player whose Roblox server hasn't reported them for this long is dropped
# (Increased to 15s so minor network spikes or player respawns don't drop coordinates).
LOCATION_TTL_SECONDS = 15.0
# Optional shared secret; when set, Roblox must send a matching `X-Server-Secret` header.
ROBLOX_API_SECRET = os.environ.get("ROBLOX_API_SECRET", "").strip()


# ------------------------------------------------------------------------------
# In-Memory Location Store
# ------------------------------------------------------------------------------
class PlayerPosition(BaseModel):
    """One player's position as reported by Roblox (studs, Roblox world space)."""

    x: float
    y: float
    z: float
    yaw: float = Field(default=0.0, description="Heading in radians; 0 = facing -Z")
    username: str = Field(default="", description="Roblox display name")
    # Legacy field kept for older Roblox scripts that still send a 4-digit PIN.
    pin: str = Field(default="")
    muted: bool = Field(default=False, description="In-game mic mute status")


# Global dictionary: UserId -> { userId, username, x, y, z, yaw, jobId, pin, ts }
player_locations: dict[str, dict[str, Any]] = {}
# Legacy lookup: PIN -> UserId (only populated if an old Roblox script sends PINs)
pin_to_user: dict[str, str] = {}


def _rebuild_pin_index() -> None:
    pin_to_user.clear()
    for uid, rec in player_locations.items():
        if rec.get("pin"):
            pin_to_user[rec["pin"]] = uid


def prune_stale_locations() -> int:
    """Remove players whose server stopped reporting them. Returns how many were removed."""
    cutoff = time.monotonic() - LOCATION_TTL_SECONDS
    stale = [uid for uid, rec in player_locations.items() if rec["ts"] < cutoff]
    for uid in stale:
        old_rec = player_locations.pop(uid, None)
        if old_rec:
            old_pin = old_rec.get("pin", "")
            for s in list(room.peers.values()):
                if s.roblox_user_id == uid or (old_pin and s.pin == old_pin):
                    logger.info("Player %s timed out from Roblox -> sending roblox-disconnected", s.username)
                    asyncio.create_task(
                        room._safe_send(
                            s,
                            {
                                "type": "roblox-disconnected",
                                "reason": "timeout",
                                "message": "تم إنهاء المكالمة لانقطاع الاتصال بروبلوكس",
                            },
                        )
                    )
    if stale:
        _rebuild_pin_index()
    return len(stale)


def public_locations_snapshot() -> dict[str, dict[str, Any]]:
    return {
        uid: {
            "userId": uid,
            "pin": rec.get("pin", ""),
            "username": rec["username"],
            "x": rec["x"],
            "y": rec["y"],
            "z": rec["z"],
            "yaw": rec["yaw"],
            "muted": bool(rec.get("muted", False)),
            # Browsers only spatialize peers that share their jobId (same Roblox server).
            "jobId": rec["jobId"],
        }
        for uid, rec in player_locations.items()
    }


# ------------------------------------------------------------------------------
# Global Room Signaling Manager
# ------------------------------------------------------------------------------
@dataclass
class PeerSession:
    peer_id: str
    pin: str
    roblox_user_id: str
    username: str
    websocket: WebSocket
    is_speaking: bool = False
    is_muted: bool = False
    last_speaking_ts: float = 0.0


class GlobalRoomManager:
    def __init__(self) -> None:
        self.peers: dict[str, PeerSession] = {}

    @staticmethod
    def _digits(raw: str, max_len: int) -> str:
        return re.sub(r"\D", "", (raw or "").strip())[:max_len]

    @staticmethod
    def _sanitize_username(raw_name: str, fallback_id: str) -> str:
        cleaned = re.sub(r"[^\w\-. ]", "", (raw_name or "").strip())[:24].strip()
        return cleaned if cleaned else f"Player_{fallback_id[:4]}"

    def peer_user_map(self) -> dict[str, str]:
        """peerId -> Roblox UserId for every connected browser (empty string if unknown)."""
        return {pid: s.roblox_user_id for pid, s in self.peers.items()}

    async def connect(
        self,
        websocket: WebSocket,
        raw_user_id: str,
        raw_pin: str,
        raw_username: str,
    ) -> PeerSession:
        await websocket.accept()

        peer_id = uuid.uuid4().hex[:8]
        # Roblox UserIds are positive integers (currently up to ~10-11 digits; allow 19).
        user_id = self._digits(raw_user_id, 19)
        pin = self._digits(raw_pin, 6)

        # Primary identity = UserId typed by the player. Legacy fallback = PIN lookup.
        matched_user_id = user_id or pin_to_user.get(pin, "")
        if not matched_user_id and raw_username:
            for uid, rec in player_locations.items():
                if rec.get("username", "").strip().lower() == raw_username.strip().lower():
                    matched_user_id = uid
                    break
        matched_data = player_locations.get(matched_user_id, {})
        roblox_username = matched_data.get("username", "")

        username = roblox_username or self._sanitize_username(
            raw_username, fallback_id=matched_user_id or peer_id
        )

        existing_peers = [
            {
                "peerId": pid,
                "pin": "",
                "robloxUserId": session.roblox_user_id,
                "username": session.username,
            }
            for pid, session in self.peers.items()
        ]

        session = PeerSession(
            peer_id=peer_id,
            pin=pin,
            roblox_user_id=matched_user_id,
            username=username,
            websocket=websocket,
        )
        self.peers[peer_id] = session

        logger.info(
            "Peer connected: %s | UserId=%s | Online=%d",
            username,
            matched_user_id or "unknown",
            len(self.peers),
        )

        # 1. Welcome message with room snapshot (who to send WebRTC offers to)
        await self._safe_send(
            session,
            {
                "type": "welcome",
                "peerId": peer_id,
                "pin": pin,
                "robloxUserId": matched_user_id,
                "username": username,
                "peers": existing_peers,
            },
        )

        # 2. Push current locations immediately so audio is positioned without waiting 0.5s
        await self._safe_send(session, self._locations_message())

        # 3. Notify other peers (they will wait for this peer's offer)
        await self.broadcast(
            {
                "type": "peer-joined",
                "peerId": peer_id,
                "pin": pin,
                "robloxUserId": matched_user_id,
                "username": username,
            },
            exclude_peer_id=peer_id,
        )

        return session

    def _locations_message(self) -> dict[str, Any]:
        return {
            "type": "locations",
            "locations": public_locations_snapshot(),
            "peerMap": self.peer_user_map(),
            "pinMap": pin_to_user,
            "serverTime": time.time(),
        }

    async def disconnect(self, peer_id: str) -> None:
        removed = self.peers.pop(peer_id, None)
        if not removed:
            return

        logger.info(
            "Peer left: %s (UserId=%s, PeerId=%s) | Remaining=%d",
            removed.username,
            removed.roblox_user_id or "unknown",
            peer_id,
            len(self.peers),
        )
        await self.broadcast({"type": "peer-left", "peerId": peer_id})

    async def relay_to_peer(
        self, sender: PeerSession, target_peer_id: str, payload: dict[str, Any]
    ) -> None:
        target = self.peers.get(target_peer_id)
        if not target:
            return

        outbound = {
            **payload,
            "sender": sender.peer_id,
            "pin": "",
            "robloxUserId": sender.roblox_user_id,
            "username": sender.username,
        }
        await self._safe_send(target, outbound)

    async def broadcast(
        self, payload: dict[str, Any], exclude_peer_id: str | None = None
    ) -> None:
        targets = [
            s for pid, s in list(self.peers.items()) if pid != exclude_peer_id
        ]
        if not targets:
            return
        # Send concurrently so one slow mobile client can't delay everyone else's audio update.
        results = await asyncio.gather(*(self._safe_send(s, payload) for s in targets))
        for session, ok in zip(targets, results):
            if not ok:
                self.peers.pop(session.peer_id, None)

    async def _safe_send(self, session: PeerSession, payload: dict[str, Any]) -> bool:
        try:
            await session.websocket.send_json(payload)
            return True
        except Exception:
            return False


room = GlobalRoomManager()


# ------------------------------------------------------------------------------
# Continuous Background Location Broadcast Loop
# ------------------------------------------------------------------------------
async def broadcast_locations_loop() -> None:
    while True:
        await asyncio.sleep(LOCATION_BROADCAST_INTERVAL)
        try:
            prune_stale_locations()
            if not room.peers:
                continue

            for session in room.peers.values():
                # Legacy: a browser that joined by PIN before Roblox reported it gets linked now.
                if not session.roblox_user_id and session.pin:
                    session.roblox_user_id = pin_to_user.get(session.pin, "")
                # Keep display names in sync with Roblox.
                rec = player_locations.get(session.roblox_user_id)
                if rec and rec.get("username"):
                    session.username = rec["username"]

            # Broadcast even when the dict is empty so browsers learn that players left
            # (otherwise they'd keep spatializing the last known, now stale, positions).
            await room.broadcast(room._locations_message())
        except Exception:
            logger.exception("Location broadcast tick failed")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    task = asyncio.create_task(broadcast_locations_loop())
    logger.info("Continuous 3D location broadcast loop started (%.1fs).", LOCATION_BROADCAST_INTERVAL)
    try:
        yield
    finally:
        task.cancel()


# ------------------------------------------------------------------------------
# FastAPI App
# ------------------------------------------------------------------------------

# ------------------------------------------------------------------------------
# Persistent User Accounts & Preferences Manager
# ------------------------------------------------------------------------------
USERS_DB_FILE = BASE_DIR / "users_db.json"

class UserManager:
    def __init__(self, file_path: Path) -> None:
        self.file_path = file_path
        self.users: dict[str, dict[str, Any]] = {}
        self.tokens: dict[str, str] = {}
        self._load()

    def _load(self) -> None:
        if self.file_path.exists():
            try:
                with open(self.file_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.users = data.get("users", {})
            except Exception:
                self.users = {}

    def _save(self) -> None:
        try:
            with open(self.file_path, "w", encoding="utf-8") as f:
                json.dump({"users": self.users}, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    @staticmethod
    def hash_password(password: str) -> str:
        return hashlib.sha256(password.encode("utf-8")).hexdigest()

    def register(self, username: str, password: str) -> tuple[bool, str, dict[str, Any]]:
        uname = username.strip()
        if len(uname) < 2 or len(password) < 3:
            return False, "اسم المستخدم يجب أن يتكون من حرفين على الأقل وكلمة المرور من 3 خانات", {}
        if uname in self.users:
            return False, "اسم المستخدم مسجل مسبقاً، يرجى تسجيل الدخول", {}

        default_settings = {
            "preferredMicId": "",
            "mutedUsers": [],
            "blockedUsers": [],
            "micSensitivity": 4,
            "noiseSuppression": True,
        }
        self.users[uname] = {
            "username": uname,
            "password_hash": self.hash_password(password),
            "created_at": time.time(),
            "settings": default_settings,
        }
        self._save()
        token = secrets.token_hex(20)
        self.tokens[token] = uname
        return True, token, default_settings

    def login(self, username: str, password: str) -> tuple[bool, str, dict[str, Any]]:
        uname = username.strip()
        if uname not in self.users:
            return False, "اسم المستخدم غير موجود", {}
        if self.users[uname].get("password_hash") != self.hash_password(password):
            return False, "كلمة المرور غير صحيحة", {}

        token = secrets.token_hex(20)
        self.tokens[token] = uname
        return True, token, self.users[uname].get("settings", {})

    def get_user_by_token(self, token: str) -> dict[str, Any] | None:
        uname = self.tokens.get(token)
        if uname and uname in self.users:
            return self.users[uname]
        return None

    def update_settings(self, token: str, settings: dict[str, Any]) -> bool:
        user = self.get_user_by_token(token)
        if not user:
            return False
        user.setdefault("settings", {}).update(settings)
        self._save()
        return True

user_mgr = UserManager(USERS_DB_FILE)


class AuthPayload(BaseModel):
    username: str
    password: str

class SettingsPayload(BaseModel):
    token: str
    settings: dict[str, Any]

app = FastAPI(
    title="Roblox WebRTC 3D Spatial Voice",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------------------------
# HTTP Endpoints
# ------------------------------------------------------------------------------
@app.post("/update_locations")
async def update_locations(
    # `list` is accepted too because Roblox's JSONEncode({}) produces "[]".
    locations: Union[dict[str, PlayerPosition], list[Any]],
    x_server_secret: str | None = Header(default=None),
    x_job_id: str | None = Header(default=None),
) -> JSONResponse:
    """
    Receives one batch of player positions from a Roblox server:
    {
      "12345678": { "x": 10.5, "y": 5.0, "z": -20.0, "yaw": 0.5, "username": "Officer_Alex" }
    }
    The batch is authoritative for its Roblox server (X-Job-Id): players from that server
    missing from the batch are removed; players from other servers are untouched.
    """
    if ROBLOX_API_SECRET and x_server_secret != ROBLOX_API_SECRET:
        raise HTTPException(status_code=401, detail="Invalid X-Server-Secret header.")

    job_id = (x_job_id or "default").strip()[:64] or "default"
    batch: dict[str, PlayerPosition] = locations if isinstance(locations, dict) else {}
    now = time.monotonic()

    # 1. Drop players that this server previously reported but no longer includes
    #    (left the game, died, or teleported away).
    reported_ids = {str(uid) for uid in batch.keys()}
    for uid in [u for u, rec in player_locations.items() if rec["jobId"] == job_id]:
        if uid not in reported_ids:
            old_rec = player_locations.pop(uid, None)
            if old_rec:
                old_pin = old_rec.get("pin", "")
                for s in list(room.peers.values()):
                    if s.roblox_user_id == uid or (old_pin and s.pin == old_pin):
                        logger.info("Player %s left Roblox -> notifying web client to disconnect", s.username)
                        asyncio.create_task(
                            room._safe_send(
                                s,
                                {
                                    "type": "roblox-disconnected",
                                    "reason": "left_game",
                                    "message": "تم إنهاء المكالمة تلقائياً لمغادرتك ماب روبلوكس",
                                },
                            )
                        )

    # 2. Upsert everyone in the batch.
    for uid, pos in batch.items():
        uid_str = re.sub(r"\D", "", str(uid))[:19]
        if not uid_str:
            continue
        player_locations[uid_str] = {
            "userId": uid_str,
            "username": pos.username or f"Player_{uid_str[:4]}",
            "x": pos.x,
            "y": pos.y,
            "z": pos.z,
            "yaw": pos.yaw,
            "muted": bool(pos.muted),
            "jobId": job_id,
            "pin": pos.pin.strip(),
            "ts": now,
        }

    _rebuild_pin_index()

    active_connected_pins = sorted({s.pin for s in room.peers.values() if s.pin})
    connected_user_ids = sorted(
        {s.roblox_user_id for s in room.peers.values() if s.roblox_user_id}
    )
    # Bidirectional Mute Sync: if player muted in-game, notify their connected web app
    for s in list(room.peers.values()):
        rec = player_locations.get(s.roblox_user_id) or (player_locations.get(pin_to_user.get(s.pin, "")) if s.pin else None)
        if rec and "muted" in rec:
            is_game_muted = bool(rec["muted"])
            if s.is_muted != is_game_muted:
                s.is_muted = is_game_muted
                asyncio.create_task(room._safe_send(s, {"type": "sync-mute", "muted": is_game_muted}))

    speaking_pins = sorted(
        {s.pin for s in room.peers.values() if s.pin and (s.is_speaking or (now - s.last_speaking_ts < 1.0))}
    )
    speaking_user_ids = sorted(
        {s.roblox_user_id for s in room.peers.values() if s.roblox_user_id and (s.is_speaking or (now - s.last_speaking_ts < 1.0))}
    )
    muted_pins = sorted({s.pin for s in room.peers.values() if s.pin and s.is_muted})
    muted_user_ids = sorted({s.roblox_user_id for s in room.peers.values() if s.roblox_user_id and s.is_muted})

    return JSONResponse(
        {
            "status": "ok",
            "jobId": job_id,
            "trackedPlayers": len(player_locations),
            "connectedVoiceUserIds": connected_user_ids,
            "activeVoicePins": active_connected_pins,
            "speakingVoicePins": speaking_pins,
            "speakingUserIds": speaking_user_ids,
            "mutedVoicePins": muted_pins,
            "mutedUserIds": muted_user_ids,
        }
    )



# ------------------------------------------------------------------------------
# Auth & User Profile Endpoints
# ------------------------------------------------------------------------------
@app.post("/api/register")
async def api_register(req: AuthPayload) -> JSONResponse:
    ok, token_or_err, settings = user_mgr.register(req.username, req.password)
    if not ok:
        raise HTTPException(status_code=400, detail=token_or_err)
    return JSONResponse({"status": "ok", "token": token_or_err, "username": req.username, "settings": settings})

@app.post("/api/login")
async def api_login(req: AuthPayload) -> JSONResponse:
    ok, token_or_err, settings = user_mgr.login(req.username, req.password)
    if not ok:
        raise HTTPException(status_code=400, detail=token_or_err)
    return JSONResponse({"status": "ok", "token": token_or_err, "username": req.username, "settings": settings})

@app.get("/api/me")
async def api_me(token: str = Query(default="")) -> JSONResponse:
    user = user_mgr.get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="الجلسة منتهية أو غير صالحة")
    return JSONResponse({"status": "ok", "username": user["username"], "settings": user.get("settings", {})})

@app.post("/api/save-settings")
async def api_save_settings(req: SettingsPayload) -> JSONResponse:
    ok = user_mgr.update_settings(req.token, req.settings)
    if not ok:
        raise HTTPException(status_code=401, detail="فشل حفظ الإعدادات، يرجى تسجيل الدخول")
    return JSONResponse({"status": "ok"})

@app.get("/health")
async def health_check() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "onlinePeers": len(room.peers),
            "trackedPlayers": len(player_locations),
            "robloxServers": len({rec["jobId"] for rec in player_locations.values()}),
        }
    )


@app.get("/locations")
async def get_locations() -> JSONResponse:
    """Returns the current 3D locations and PIN mappings for debugging."""
    return JSONResponse(
        {
            "trackedPlayers": len(player_locations),
            "locations": public_locations_snapshot(),
            "pinMap": pin_to_user,
            "connectedVoicePins": [s.pin for s in room.peers.values() if s.pin],
        }
    )


@app.get("/")
async def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ------------------------------------------------------------------------------
# WebSocket Signaling Endpoint
# ------------------------------------------------------------------------------
@app.websocket("/ws")
async def signaling_websocket(
    websocket: WebSocket,
    user_id: str = Query(default=""),
    pin: str = Query(default=""),  # legacy
    username: str = Query(default=""),
) -> None:
    session = await room.connect(
        websocket, raw_user_id=user_id, raw_pin=pin, raw_username=username
    )

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "ping":
                await room._safe_send(session, {"type": "pong"})
                continue

            if msg_type == "speaking":
                is_spk = bool(data.get("speaking", False))
                session.is_speaking = is_spk
                if is_spk:
                    session.last_speaking_ts = time.monotonic()
                continue

            if msg_type == "set-mute":
                session.is_muted = bool(data.get("muted", False))
                continue

            if msg_type == "peer-block":
                target_id = data.get("target")
                if isinstance(target_id, str) and target_id:
                    await room.relay_to_peer(session, target_id, data)
                continue

            if msg_type in ("offer", "answer", "ice-candidate"):
                target_id = data.get("target")
                if isinstance(target_id, str) and target_id:
                    await room.relay_to_peer(session, target_id, data)
                continue

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WebSocket error for peer %s", session.peer_id)
    finally:
        await room.disconnect(session.peer_id)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
