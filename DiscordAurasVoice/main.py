"""
FastAPI Load Balancer & Discord Channel Manager Entrypoint.
Runs FastAPI + the 5-Node Discord Bot Fleet concurrently on Python 3.12's asyncio loop.
"""

from __future__ import annotations

import truststore

truststore.inject_into_ssl()

import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from bot_fleet import BotFleetManager, BubbleSpec
from config import load_settings
from pin_store import PinVerificationStore

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)-14s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("aura.api")

settings = load_settings()
pin_store = PinVerificationStore(settings.data_file)
fleet_manager = BotFleetManager(settings=settings, pin_store=pin_store)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("============================================================")
    logger.info(" Discord Interactive Auras Voice System — Starting Fleet")
    logger.info(" Configured Bot Nodes: %d | Port: %d", len(settings.bot_nodes), settings.port)
    logger.info("============================================================")
    await fleet_manager.start()
    try:
        yield
    finally:
        logger.info("Shutting down Discord Bot Fleet and cleaning up active JobIds...")
        await fleet_manager.stop()


app = FastAPI(
    title="Discord Interactive Auras Voice System",
    version="1.0.0",
    description="Round-Robin Multi-Bot Discord Voice Channel Manager & Load Balancer for Roblox.",
    lifespan=lifespan,
)


async def verify_api_secret(x_aura_secret: Optional[str] = Header(default=None)) -> None:
    """Optional shared-secret check if AURA_API_SECRET is configured in .env."""
    if settings.api_secret and x_aura_secret != settings.api_secret:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Aura-Secret header.",
        )


# ==============================================================================
# Pydantic Request / Response Models
# ==============================================================================
class PinGenerateRequest(BaseModel):
    roblox_user_id: str
    roblox_username: str = ""
    display_name: str = ""
    force_new: bool = False
    unlink_existing: bool = False


class PlayerHeartbeatItem(BaseModel):
    user_id: str
    username: str = ""
    display_name: str = ""
    pin: Optional[str] = None


class BubblePayloadItem(BaseModel):
    bubble_id: str
    bubble_type: str = Field(default="aura", pattern="^(aura|whisper)$")
    locked: bool = False
    owner_id: Optional[str] = None
    member_ids: List[str] = Field(default_factory=list)


class SyncBubblesRequest(BaseModel):
    job_id: str = Field(..., min_length=1)
    place_id: int = 0
    bubbles: List[BubblePayloadItem] = Field(default_factory=list)
    players: List[PlayerHeartbeatItem] = Field(default_factory=list)


class CleanupJobRequest(BaseModel):
    job_id: str = Field(..., min_length=1)


# ==============================================================================
# Endpoints
# ==============================================================================
@app.get("/")
@app.get("/health")
async def health_check() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "Discord Interactive Auras Voice System",
        "fleet": fleet_manager.get_fleet_telemetry(),
    }


@app.get("/fleet/status", dependencies=[Depends(verify_api_secret)])
async def fleet_status() -> Dict[str, Any]:
    return fleet_manager.get_fleet_telemetry()


@app.post("/pin/generate", dependencies=[Depends(verify_api_secret)])
@app.post("/api/v1/pin/generate", dependencies=[Depends(verify_api_secret)])
async def generate_pin_endpoint(req: PinGenerateRequest) -> Dict[str, Any]:
    pin, existing_link = await pin_store.generate_pin(
        roblox_user_id=req.roblox_user_id,
        roblox_username=req.roblox_username,
        display_name=req.display_name,
        force_new=req.force_new,
        unlink_existing=req.unlink_existing,
    )
    in_voice = False
    discord_tag: Optional[str] = None
    if existing_link:
        discord_tag = existing_link.discord_tag
        in_voice = fleet_manager.get_member_voice_channel(existing_link.discord_id) is not None

    return {
        "ok": True,
        "roblox_user_id": req.roblox_user_id,
        "pin": pin,
        "linked": existing_link is not None,
        "discord_tag": discord_tag,
        "in_voice": in_voice,
    }


@app.post("/sync", dependencies=[Depends(verify_api_secret)])
@app.post("/api/v1/sync-bubbles", dependencies=[Depends(verify_api_secret)])
async def sync_bubbles_endpoint(req: SyncBubblesRequest) -> Dict[str, Any]:
    # 1. Ensure player PINs & linked statuses are up to date
    player_states: Dict[str, Dict[str, Any]] = {}
    active_roblox_ids: List[str] = []

    for p in req.players:
        uid = str(p.user_id)
        active_roblox_ids.append(uid)
        link = pin_store.get_link_by_roblox(uid)
        if link:
            in_vc = fleet_manager.get_member_voice_channel(link.discord_id) is not None
            player_states[uid] = {
                "pin": p.pin or "",
                "linked": True,
                "discord_tag": link.discord_tag,
                "in_voice": in_vc,
            }
        else:
            auth_pin = await pin_store.sync_player_pin_from_roblox(
                roblox_user_id=uid,
                pin=p.pin,
                roblox_username=p.username,
                display_name=p.display_name,
            )
            player_states[uid] = {
                "pin": auth_pin,
                "linked": False,
                "discord_tag": None,
                "in_voice": False,
            }

    # 2. Reconcile JobId category & Micro-Bubbles across the Round-Robin Bot Fleet
    bubble_specs = [
        BubbleSpec(
            bubble_id=b.bubble_id,
            bubble_type=b.bubble_type,
            locked=b.locked,
            owner_id=b.owner_id,
            member_ids=[str(mid) for mid in b.member_ids],
        )
        for b in req.bubbles
    ]
    fleet_result = await fleet_manager.sync_job_bubbles(
        job_id=req.job_id,
        bubbles=bubble_specs,
        active_roblox_ids=active_roblox_ids,
    )

    return {
        "ok": True,
        "job_id": req.job_id,
        "fleet": fleet_result,
        "player_states": player_states,
    }


@app.post("/cleanup", dependencies=[Depends(verify_api_secret)])
@app.post("/api/v1/cleanup", dependencies=[Depends(verify_api_secret)])
async def cleanup_job_endpoint(req: CleanupJobRequest) -> Dict[str, Any]:
    result = await fleet_manager.cleanup_job(req.job_id)
    return {"ok": True, **result}


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level="info",
    )
