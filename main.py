"""
WebRTC Spatial Audio Signaling Server (FastAPI)
===============================================
Production-ready WebSocket signaling server for Roblox Roleplay 3D Proximity Chat.
Designed for single-instance deployment on Render (provides automatic HTTPS & WSS).

Features:
- Serves the mobile-friendly WebRTC + iOS PiP Hack frontend directly at `/`.
- Manages a single Global Room (`GLOBAL_ROOM`) for glare-free WebRTC mesh discovery.
- Relays WebRTC SDP `offer`, `answer`, and trickled `ice-candidate` payloads peer-to-peer.
- Built-in JSON `ping`/`pong` heartbeat so Render's reverse proxy never drops idle sockets
  while players have Safari backgrounded and are actively playing Roblox.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ------------------------------------------------------------------------------
# Logging & Paths
# ------------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
)
logger = logging.getLogger("roblox-spatial-voice")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# ------------------------------------------------------------------------------
# FastAPI App Initialization
# ------------------------------------------------------------------------------
app = FastAPI(
    title="Roblox WebRTC Spatial Voice Signaling Server",
    version="1.0.0",
)

# Enable CORS in case you ever host the frontend separately (e.g., Cloudflare Pages)
# while pointing WebSockets to your Render backend URL.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------------------------
# Global Room Signaling Manager
# ------------------------------------------------------------------------------
@dataclass
class PeerSession:
    peer_id: str
    username: str
    websocket: WebSocket


class GlobalRoomManager:
    """
    Manages active WebSocket peers inside a single global voice room.

    Glare-Free Mesh Discovery Rule:
    - When a new peer connects, the server sends them a `welcome` message containing
      a snapshot of all *currently connected* peers.
    - ONLY the newly joined peer initiates `RTCPeerConnection.createOffer()` toward
      each existing peer. Existing peers wait for the newcomer's offer.
    - Because dictionary registration happens synchronously before yielding to the
      event loop, simultaneous joins are strictly ordered and SDP "offer glare"
      cannot occur.
    """

    def __init__(self) -> None:
        self.peers: dict[str, PeerSession] = {}

    @staticmethod
    def _sanitize_username(raw_name: str, fallback_id: str) -> str:
        cleaned = re.sub(r"[^\w\-. ]", "", (raw_name or "").strip())[:24].strip()
        return cleaned if cleaned else f"Player_{fallback_id[:4]}"

    async def connect(self, websocket: WebSocket, raw_username: str) -> PeerSession:
        await websocket.accept()

        peer_id = uuid.uuid4().hex[:8]
        username = self._sanitize_username(raw_username, peer_id)

        # Snapshot existing peers BEFORE adding the newcomer
        existing_peers = [
            {"peerId": pid, "username": session.username}
            for pid, session in self.peers.items()
        ]

        session = PeerSession(peer_id=peer_id, username=username, websocket=websocket)
        self.peers[peer_id] = session

        logger.info(
            "Peer joined: %s (%s) | Total online: %d",
            username,
            peer_id,
            len(self.peers),
        )

        # 1. Send welcome + existing peer list to the newcomer (triggers their SDP offers)
        await self._safe_send(
            session,
            {
                "type": "welcome",
                "peerId": peer_id,
                "username": username,
                "peers": existing_peers,
            },
        )

        # 2. Notify existing peers so they can display the newcomer & prepare to answer
        await self.broadcast(
            {
                "type": "peer-joined",
                "peerId": peer_id,
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
            "Peer left: %s (%s) | Remaining online: %d",
            removed.username,
            peer_id,
            len(self.peers),
        )

        await self.broadcast(
            {
                "type": "peer-left",
                "peerId": peer_id,
            }
        )

    async def relay_to_peer(
        self, sender: PeerSession, target_peer_id: str, payload: dict[str, Any]
    ) -> None:
        """
        Relays SDP offers/answers and ICE candidates directly to a specific peer.
        Stamps server-verified `sender` ID and `username` to prevent spoofing.
        """
        target = self.peers.get(target_peer_id)
        if not target:
            logger.debug(
                "Relay skipped: target %s no longer online (from %s)",
                target_peer_id,
                sender.peer_id,
            )
            return

        outbound = {
            **payload,
            "sender": sender.peer_id,
            "username": sender.username,
        }
        await self._safe_send(target, outbound)

    async def broadcast(
        self, payload: dict[str, Any], exclude_peer_id: str | None = None
    ) -> None:
        """Broadcasts a JSON payload to all peers in the global room."""
        stale_ids: list[str] = []

        # Iterate over a shallow copy so concurrent disconnects never mutate during iteration
        for pid, session in list(self.peers.items()):
            if pid == exclude_peer_id:
                continue
            ok = await self._safe_send(session, payload)
            if not ok:
                stale_ids.append(pid)

        for pid in stale_ids:
            self.peers.pop(pid, None)

    async def _safe_send(
        self, session: PeerSession, payload: dict[str, Any]
    ) -> bool:
        try:
            await session.websocket.send_json(payload)
            return True
        except Exception as exc:
            logger.warning("Failed sending to %s: %s", session.peer_id, exc)
            return False


room = GlobalRoomManager()


# ------------------------------------------------------------------------------
# HTTP Routes (Health Check & Frontend Static Serving)
# ------------------------------------------------------------------------------
@app.get("/health")
async def health_check() -> JSONResponse:
    """Used by Render for zero-downtime health checks and monitoring."""
    return JSONResponse(
        {
            "status": "ok",
            "room": "global",
            "onlinePeers": len(room.peers),
        }
    )


@app.get("/")
async def serve_index() -> FileResponse:
    """Serves the mobile WebRTC Spatial Voice UI."""
    return FileResponse(STATIC_DIR / "index.html")


# Mount `/static` for CSS and JS assets
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ------------------------------------------------------------------------------
# WebSocket Signaling Endpoint
# ------------------------------------------------------------------------------
@app.websocket("/ws")
async def signaling_websocket(
    websocket: WebSocket,
    username: str = Query(default="Player"),
) -> None:
    """
    WebSocket signaling loop for WebRTC peer discovery & negotiation.

    Supported client -> server JSON messages:
    - { "type": "ping" }
    - { "type": "offer",         "target": "<peerId>", "sdp": { ... } }
    - { "type": "answer",        "target": "<peerId>", "sdp": { ... } }
    - { "type": "ice-candidate", "target": "<peerId>", "candidate": { ... } }
    """
    session = await room.connect(websocket, username)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            # Render proxy keepalive heartbeat (prevents ~60s idle socket timeout)
            if msg_type == "ping":
                await room._safe_send(session, {"type": "pong"})
                continue

            # Point-to-point WebRTC signaling messages
            if msg_type in ("offer", "answer", "ice-candidate"):
                target_id = data.get("target")
                if isinstance(target_id, str) and target_id:
                    await room.relay_to_peer(session, target_id, data)
                continue

            logger.debug("Ignored unknown message type '%s' from %s", msg_type, session.peer_id)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WebSocket error for %s: %s", session.peer_id, exc)
    finally:
        await room.disconnect(session.peer_id)


# ------------------------------------------------------------------------------
# Local / Render Entrypoint
# ------------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
