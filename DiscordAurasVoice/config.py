"""
Configuration loader for the Discord Interactive Auras Voice System.
Loads fleet bot tokens, guild settings, and server parameters from .env.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


@dataclass(frozen=True)
class BotNodeConfig:
    """Configuration for an individual Discord Bot node in the fleet."""

    name: str
    token: str
    application_id: Optional[str]


def _extract_app_id_from_token(token: str) -> Optional[str]:
    """Decode the Discord Application/Bot ID from the first segment of a bot token."""
    try:
        first_part = token.split(".")[0].strip()
        padding = "=" * (-len(first_part) % 4)
        decoded = base64.urlsafe_b64decode(first_part + padding).decode("utf-8")
        if decoded.isdigit():
            return decoded
    except Exception:
        pass
    return None


@dataclass(frozen=True)
class AppSettings:
    """Global backend settings."""

    bot_nodes: List[BotNodeConfig]
    discord_guild_id: Optional[int]
    lobby_channel_name: str
    api_secret: str
    host: str
    port: int
    data_file: Path
    stale_job_timeout_seconds: float = 120.0


def load_settings() -> AppSettings:
    """Parse environment variables and assemble fleet node configurations."""
    nodes: List[BotNodeConfig] = []
    seen_tokens: set[str] = set()

    # 1. Support numbered DISCORD_BOT_TOKEN_1 .. DISCORD_BOT_TOKEN_50
    numbered_keys = sorted(
        (
            k
            for k in os.environ.keys()
            if k.startswith("DISCORD_BOT_TOKEN_")
            and k.removeprefix("DISCORD_BOT_TOKEN_").isdigit()
        ),
        key=lambda k: int(k.removeprefix("DISCORD_BOT_TOKEN_")),
    )
    for key in numbered_keys:
        idx = int(key.removeprefix("DISCORD_BOT_TOKEN_"))
        raw = os.getenv(key, "").strip()
        if raw and not raw.startswith("YOUR_") and raw not in seen_tokens:
            seen_tokens.add(raw)
            nodes.append(
                BotNodeConfig(
                    name=f"NODE-{idx}",
                    token=raw,
                    application_id=_extract_app_id_from_token(raw),
                )
            )

    # 2. Also support comma-separated DISCORD_BOT_TOKENS array
    csv_tokens = os.getenv("DISCORD_BOT_TOKENS", "").strip()
    if csv_tokens:
        for tok in csv_tokens.split(","):
            cleaned = tok.strip()
            if cleaned and cleaned not in seen_tokens:
                seen_tokens.add(cleaned)
                node_num = len(nodes) + 1
                nodes.append(
                    BotNodeConfig(
                        name=f"NODE-{node_num}",
                        token=cleaned,
                        application_id=_extract_app_id_from_token(cleaned),
                    )
                )

    raw_guild_id = os.getenv("DISCORD_GUILD_ID", "").strip()
    guild_id: Optional[int] = int(raw_guild_id) if raw_guild_id.isdigit() else None

    lobby_name = os.getenv("DISCORD_LOBBY_CHANNEL_NAME", "🔊 Aura Lobby").strip() or "🔊 Aura Lobby"
    api_secret = os.getenv("AURA_API_SECRET", "").strip()
    host = os.getenv("HOST", "0.0.0.0").strip() or "0.0.0.0"
    port = int(os.getenv("PORT", "8000").strip() or "8000")

    return AppSettings(
        bot_nodes=nodes,
        discord_guild_id=guild_id,
        lobby_channel_name=lobby_name,
        api_secret=api_secret,
        host=host,
        port=port,
        data_file=BASE_DIR / "linked_accounts.json",
    )
