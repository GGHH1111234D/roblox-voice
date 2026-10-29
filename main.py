"""
WebRTC 3D Spatial Audio Signaling & Coordinate Server (FastAPI)
===============================================================
Production-ready backend connecting Roblox Roleplay servers to WebRTC browser clients:
1. Receives 3D player coordinates every 0.5s from Roblox via `POST /update_locations`.
2. Stores the latest `{ UserId: { x, y, z, yaw } }` map in memory (`player_locations`).
3. Continuously broadcasts the 3D location dictionary over WebSockets to all connected
   WebRTC clients while handling peer discovery (`offer`, `answer`, `ice-candidate`).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ------------------------------------------------------------------------------
# Logging & Configuration
# ------------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
)
logger = logging.getLogger("roblox-spatial-voice")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

LOCATION_BROADCAST_INTERVAL = 0.5  # Seconds between WebSocket 3D coordinate broadcasts
ROBLOX_API_SECRET = os.environ.get("ROBLOX_API_SECRET", "").strip()


# ------------------------------------------------------------------------------
# In-Memory 3D Location Store & Schema
# ------------------------------------------------------------------------------
class PlayerPosition(BaseModel):
    """3D coordinates of a player's HumanoidRootPart in Roblox world space (studs)."""

    x: float
    y: float
    z: float
    yaw: float = Field(
        default=0.0,
        description="Optional horizontal facing angle in radians from HumanoidRootPart.CFrame.LookVector",
    )


# Global dictionary mapping Roblox `UserId` (str) -> {"x": float, "y": float, "z": float, "yaw": float}
player_locations: dict[str, dict[str, float]] = {}


# ------------------------------------------------------------------------------
# Global Room Signaling Manager
# ------------------------------------------------------------------------------
@dataclass
class PeerSession:
    peer_id: str
    roblox_user_id: str
    username: str
    websocket: WebSocket


class GlobalRoomManager:
    """
    Manages WebRTC signaling AND 3D coordinate broadcasts for the global voice room.

    Glare-Free Mesh Discovery Rule:
    - When a new peer connects, they receive `welcome` containing all currently online
      peers (including each peer's `robloxUserId`).
    - ONLY the newly joined peer initiates `createOffer()` toward existing peers.
    """

    def __init__(self) -> None:
        self.peers: dict[str, PeerSession] = {}

    @staticmethod
    def _sanitize_username(raw_name: str, fallback_id: str) -> str:
        cleaned = re.sub(r"[^\w\-. ]", "", (raw_name or "").strip())[:24].strip()
        return cleaned if cleaned else f"Player_{fallback_id[:4]}"

    @staticmethod
    def _sanitize_user_id(raw_uid: str) -> str:
        # Roblox UserIds are positive integers; keep digits only (up to 20 chars)
        return re.sub(r"\D", "", (raw_uid or "").strip())[:20]

    async def connect(
        self, websocket: WebSocket, raw_user_id: str, raw_username: str
    ) -> PeerSession:
        await websocket.accept()

        peer_id = uuid.uuid4().hex[:8]
        roblox_user_id = self._sanitize_user_id(raw_user_id)
        default_label = f"User_{roblox_user_id}" if roblox_user_id else f"Player_{peer_id[:4]}"
        username = self._sanitize_username(raw_username, peer_id) if raw_username.strip() else default_label

        # Snapshot existing peers BEFORE registering the newcomer
        existing_peers = [
            {
                "peerId": pid,
                "robloxUserId": session.roblox_user_id,
                "username": session.username,
            }
            for pid, session in self.peers.items()
        ]

        session = PeerSession(
            peer_id=peer_id,
            roblox_user_id=roblox_user_id,
            username=username,
            websocket=websocket,
        )
        self.peers[peer_id] = session

        logger.info(
            "Peer joined: %s | Roblox UserId=%s | PeerId=%s | Online=%d",
            username,
            roblox_user_id or "unset",
            peer_id,
            len(self.peers),
        )

        # 1. Send welcome + existing peer roster to newcomer
        await self._safe_send(
            session,
            {
                "type": "welcome",
                "peerId": peer_id,
                "robloxUserId": roblox_user_id,
                "username": username,
                "peers": existing_peers,
            },
        )

        # 2. Immediately push the latest 3D coordinate snapshot so they don't wait 0.5s
        if player_locations:
            await self._safe_send(
                session,
                {
                    "type": "locations",
                    "locations": player_locations,
                },
            )

        # 3. Broadcast newcomer's arrival (with their Roblox UserId) to existing peers
        await self.broadcast(
            {
                "type": "peer-joined",
                "peerId": peer_id,
                "robloxUserId": roblox_user_id,
                "username": username,
            },
            exclude_peer_id=peer_id,
        )

        return session

    async def disconnect(self, peer_id: str) -> None:
        removed = self.peers.pop(peer_id, None)
        if not removed:
            return

        logger.info(
            "Peer left: %s (UserId=%s, PeerId=%s) | Remaining=%d",
            removed.username,
            removed.roblox_user_id or "unset",
            peer_id,
            len(self.peers),
        )
        await self.broadcast({"type": "peer-left", "peerId": peer_id})

    async def relay_to_peer(
        self, sender: PeerSession, target_peer_id: str, payload: dict[str, Any]
    ) -> None:
        """Relays SDP offers/answers and ICE candidates with verified sender identity."""
        target = self.peers.get(target_peer_id)
        if not target:
            return

        outbound = {
            **payload,
            "sender": sender.peer_id,
            "robloxUserId": sender.roblox_user_id,
            "username": sender.username,
        }
        await self._safe_send(target, outbound)

    async def broadcast(
        self, payload: dict[str, Any], exclude_peer_id: str | None = None
    ) -> None:
        stale_ids: list[str] = []
        for pid, session in list(self.peers.items()):
            if pid == exclude_peer_id:
                continue
            if not await self._safe_send(session, payload):
                stale_ids.append(pid)

        for pid in stale_ids:
            self.peers.pop(pid, None)

    async def _safe_send(self, session: PeerSession, payload: dict[str, Any]) -> bool:
        try:
            await session.websocket.send_json(payload)
            return True
        except Exception as exc:
            logger.warning("WebSocket send failed for %s: %s", session.peer_id, exc)
            return False


room = GlobalRoomManager()


# ------------------------------------------------------------------------------
# Continuous Background Broadcast Task (Lifespan)
# ------------------------------------------------------------------------------
async def broadcast_locations_loop() -> None:
    """
    Continuously broadcasts the in-memory `player_locations` dictionary every 0.5s
    to all connected WebRTC web clients so browsers can update their 3D PannerNodes.
    """
    while True:
        await asyncio.sleep(LOCATION_BROADCAST_INTERVAL)
        if room.peers and player_locations:
            await room.broadcast(
                {
                    "type": "locations",
                    "locations": player_locations,
                }
            )


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    broadcaster_task = asyncio.create_task(broadcast_locations_loop())
    logger.info("Started 3D location WebSocket broadcast loop (%.1fs interval).", LOCATION_BROADCAST_INTERVAL)
    try:
        yield
    finally:
        broadcaster_task.cancel()
        try:
            await broadcaster_task
        except asyncio.CancelledError:
            pass


# ------------------------------------------------------------------------------
# FastAPI App & Middleware
# ------------------------------------------------------------------------------
app = FastAPI(
    title="Roblox WebRTC 3D Spatial Audio Server",
    version="2.0.0",
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
# HTTP Endpoints (`/update_locations`, `/health`, Static UI)
# ------------------------------------------------------------------------------
@app.post("/update_locations")
async def update_locations(
    locations: dict[str, PlayerPosition],
    x_server_secret: str | None = Header(default=None),
) -> JSONResponse:
    """
    Receives the JSON payload from Roblox's `HttpService:PostAsync` every 0.5s:
      {
        "12345678": { "x": 12.5, "y": 5.0, "z": -30.2, "yaw": 0.45 },
        "87654321": { "x": 18.0, "y": 5.0, "z": -28.0, "yaw": -1.20 }
      }
    Updates the global in-memory `player_locations` dictionary.
    """
    if ROBLOX_API_SECRET and x_server_secret != ROBLOX_API_SECRET:
        raise HTTPException(status_code=401, detail="Invalid X-Server-Secret header.")

    serialized = {
        str(user_id): {
            "x": coords.x,
            "y": coords.y,
            "z": coords.z,
            "yaw": coords.yaw,
        }
        for user_id, coords in locations.items()
    }

    # Replace in-memory snapshot atomically so disconnected Roblox players are pruned
    player_locations.clear()
    player_locations.update(serialized)

    return JSONResponse(
        {
            "status": "ok",
            "trackedPlayers": len(player_locations),
        }
    )


@app.get("/health")
async def health_check() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "room": "global",
            "onlinePeers": len(room.peers),
            "trackedRobloxPlayers": len(player_locations),
        }
    )


@app.get("/")
async def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ------------------------------------------------------------------------------
# WebSocket Signaling & Spatial Telemetry Endpoint
# ------------------------------------------------------------------------------
@app.websocket("/ws")
async def signaling_websocket(
    websocket: WebSocket,
    user_id: str = Query(default=""),
    username: str = Query(default=""),
) -> None:
    session = await room.connect(websocket, raw_user_id=user_id, raw_username=username)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            # Keepalive heartbeat for Render reverse proxy
            if msg_type == "ping":
                await room._safe_send(session, {"type": "pong"})
                continue

            # Relay WebRTC SDP & ICE messages peer-to-peer
            if msg_type in ("offer", "answer", "ice-candidate"):
                target_id = data.get("target")
                if isinstance(target_id, str) and target_id:
                    await room.relay_to_peer(session, target_id, data)
                continue

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WebSocket error for %s: %s", session.peer_id, exc)
    finally:
        await room.disconnect(session.peer_id)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
