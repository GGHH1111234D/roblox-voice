"""
Async-safe 4-Digit PIN Verification & Roblox <-> Discord Identity Store.
Persists verified account links to `linked_accounts.json` so returning players
stay linked across game sessions while supporting instant PIN re-linking.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Tuple

logger = logging.getLogger("aura.pinstore")


@dataclass
class PendingPinEntry:
    pin: str
    roblox_user_id: str
    roblox_username: str
    display_name: str
    created_at: float


@dataclass
class LinkedAccount:
    roblox_user_id: str
    roblox_username: str
    discord_id: int
    discord_tag: str
    linked_at: float


class PinVerificationStore:
    """Manages ephemeral 4-digit PINs and persistent Roblox <-> Discord links."""

    PIN_TTL_SECONDS = 3600.0  # 1 hour expiry for unused PINs

    def __init__(self, storage_path: Path) -> None:
        self._storage_path = storage_path
        self._lock = asyncio.Lock()

        # pin ("4829") -> PendingPinEntry
        self._pin_to_entry: Dict[str, PendingPinEntry] = {}
        # roblox_user_id ("123456") -> pin ("4829")
        self._user_to_pin: Dict[str, str] = {}

        # Persistent mappings
        self._roblox_to_link: Dict[str, LinkedAccount] = {}
        self._discord_to_roblox: Dict[int, str] = {}

        self._load_from_disk()

    def _load_from_disk(self) -> None:
        if not self._storage_path.exists():
            return
        try:
            raw = json.loads(self._storage_path.read_text(encoding="utf-8"))
            for item in raw.get("links", []):
                acc = LinkedAccount(
                    roblox_user_id=str(item["roblox_user_id"]),
                    roblox_username=str(item.get("roblox_username", "")),
                    discord_id=int(item["discord_id"]),
                    discord_tag=str(item.get("discord_tag", "")),
                    linked_at=float(item.get("linked_at", time.time())),
                )
                self._roblox_to_link[acc.roblox_user_id] = acc
                self._discord_to_roblox[acc.discord_id] = acc.roblox_user_id
            logger.info("Loaded %d persistent Discord<->Roblox links.", len(self._roblox_to_link))
        except Exception as exc:
            logger.warning("Failed to load %s: %s", self._storage_path, exc)

    def _save_to_disk(self) -> None:
        try:
            payload = {
                "updated_at": time.time(),
                "links": [
                    {
                        "roblox_user_id": acc.roblox_user_id,
                        "roblox_username": acc.roblox_username,
                        "discord_id": acc.discord_id,
                        "discord_tag": acc.discord_tag,
                        "linked_at": acc.linked_at,
                    }
                    for acc in self._roblox_to_link.values()
                ],
            }
            self._storage_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except Exception as exc:
            logger.error("Failed to persist linked accounts: %s", exc)

    def _purge_expired_unlocked(self) -> None:
        now = time.time()
        expired_pins = [
            pin
            for pin, entry in self._pin_to_entry.items()
            if (now - entry.created_at) > self.PIN_TTL_SECONDS
        ]
        for pin in expired_pins:
            entry = self._pin_to_entry.pop(pin, None)
            if entry and self._user_to_pin.get(entry.roblox_user_id) == pin:
                self._user_to_pin.pop(entry.roblox_user_id, None)

    async def generate_pin(
        self,
        roblox_user_id: str,
        roblox_username: str = "",
        display_name: str = "",
        force_new: bool = False,
        unlink_existing: bool = False,
    ) -> Tuple[str, Optional[LinkedAccount]]:
        """
        Issue or return an active collision-free 4-digit PIN (1000..9999) for a Roblox player.
        Also returns any existing LinkedAccount unless `unlink_existing=True`.
        """
        uid = str(roblox_user_id)
        async with self._lock:
            self._purge_expired_unlocked()

            if unlink_existing and uid in self._roblox_to_link:
                old_link = self._roblox_to_link.pop(uid)
                self._discord_to_roblox.pop(old_link.discord_id, None)
                self._save_to_disk()

            existing_link = self._roblox_to_link.get(uid)

            if not force_new and uid in self._user_to_pin:
                existing_pin = self._user_to_pin[uid]
                if existing_pin in self._pin_to_entry:
                    entry = self._pin_to_entry[existing_pin]
                    if roblox_username:
                        entry.roblox_username = roblox_username
                    if display_name:
                        entry.display_name = display_name
                    return existing_pin, existing_link

            # Revoke previous pending PIN for this player if any
            old_pin = self._user_to_pin.pop(uid, None)
            if old_pin:
                self._pin_to_entry.pop(old_pin, None)

            # Generate a unique 4-digit PIN (1000-9999)
            pin = ""
            for _ in range(9500):
                candidate = f"{secrets.randbelow(9000) + 1000:04d}"
                if candidate not in self._pin_to_entry:
                    pin = candidate
                    break
            if not pin:
                raise RuntimeError("All 9000 4-digit PIN slots are currently exhausted.")

            entry = PendingPinEntry(
                pin=pin,
                roblox_user_id=uid,
                roblox_username=roblox_username or f"Player_{uid}",
                display_name=display_name or roblox_username or f"Player_{uid}",
                created_at=time.time(),
            )
            self._pin_to_entry[pin] = entry
            self._user_to_pin[uid] = pin
            return pin, existing_link

    async def sync_player_pin_from_roblox(
        self,
        roblox_user_id: str,
        pin: Optional[str],
        roblox_username: str = "",
        display_name: str = "",
    ) -> str:
        """
        Ensure a Roblox player's in-game PIN is registered in backend memory
        (handles backend restarts gracefully without forcing players to rejoin).
        Returns the authoritative PIN for that player.
        """
        uid = str(roblox_user_id)
        async with self._lock:
            self._purge_expired_unlocked()

            # Already has a valid backend PIN
            if uid in self._user_to_pin and self._user_to_pin[uid] in self._pin_to_entry:
                current_pin = self._user_to_pin[uid]
                entry = self._pin_to_entry[current_pin]
                if roblox_username:
                    entry.roblox_username = roblox_username
                if display_name:
                    entry.display_name = display_name
                return current_pin

            # Adopt the Roblox-suggested 4-digit PIN if free
            if pin and len(pin) == 4 and pin.isdigit() and pin not in self._pin_to_entry:
                entry = PendingPinEntry(
                    pin=pin,
                    roblox_user_id=uid,
                    roblox_username=roblox_username or f"Player_{uid}",
                    display_name=display_name or roblox_username or f"Player_{uid}",
                    created_at=time.time(),
                )
                self._pin_to_entry[pin] = entry
                self._user_to_pin[uid] = pin
                return pin

        # Otherwise generate a fresh collision-free PIN
        new_pin, _ = await self.generate_pin(uid, roblox_username, display_name, force_new=True)
        return new_pin

    async def redeem_pin(self, pin: str, discord_id: int, discord_tag: str) -> Optional[LinkedAccount]:
        """
        Verify a 4-digit PIN submitted by a Discord user and bind their Discord ID
        to the corresponding Roblox UserId.
        """
        cleaned_pin = pin.strip()
        async with self._lock:
            self._purge_expired_unlocked()
            entry = self._pin_to_entry.get(cleaned_pin)
            if not entry:
                return None

            # Consume the one-time PIN
            self._pin_to_entry.pop(cleaned_pin, None)
            self._user_to_pin.pop(entry.roblox_user_id, None)

            # Remove any stale link previously attached to this Discord ID
            prev_roblox_uid = self._discord_to_roblox.pop(discord_id, None)
            if prev_roblox_uid and prev_roblox_uid != entry.roblox_user_id:
                self._roblox_to_link.pop(prev_roblox_uid, None)

            # Remove any stale Discord ID previously attached to this Roblox UserId
            prev_link = self._roblox_to_link.pop(entry.roblox_user_id, None)
            if prev_link and prev_link.discord_id != discord_id:
                self._discord_to_roblox.pop(prev_link.discord_id, None)

            account = LinkedAccount(
                roblox_user_id=entry.roblox_user_id,
                roblox_username=entry.roblox_username,
                discord_id=discord_id,
                discord_tag=discord_tag,
                linked_at=time.time(),
            )
            self._roblox_to_link[account.roblox_user_id] = account
            self._discord_to_roblox[discord_id] = account.roblox_user_id
            self._save_to_disk()
            logger.info(
                "PIN %s redeemed: Roblox %s (%s) <-> Discord %s (%d)",
                cleaned_pin,
                account.roblox_username,
                account.roblox_user_id,
                account.discord_tag,
                account.discord_id,
            )
            return account

    async def unlink_by_discord(self, discord_id: int) -> Optional[LinkedAccount]:
        async with self._lock:
            uid = self._discord_to_roblox.pop(discord_id, None)
            if not uid:
                return None
            removed = self._roblox_to_link.pop(uid, None)
            self._save_to_disk()
            return removed

    def get_link_by_roblox(self, roblox_user_id: str) -> Optional[LinkedAccount]:
        return self._roblox_to_link.get(str(roblox_user_id))

    def get_link_by_discord(self, discord_id: int) -> Optional[LinkedAccount]:
        uid = self._discord_to_roblox.get(discord_id)
        return self._roblox_to_link.get(uid) if uid else None

    @property
    def total_linked(self) -> int:
        return len(self._roblox_to_link)

    @property
    def active_pins_count(self) -> int:
        return len(self._pin_to_entry)
