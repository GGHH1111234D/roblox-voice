"""
Discord Bot Fleet Manager & Round-Robin Load Balancer.

Responsibilities:
- Manage N concurrent Discord Bot connections in FastAPI's asyncio loop
- Automatic SSL truststore injection (Windows native TLS support)
- Automatic Privileged Intents graceful fallback
- Round-Robin API distribution across all healthy nodes with automatic failover
- 4-Digit PIN linking via Slash Command (/link), DM ("1234"), or Mention/Prefix ("!link 1234")
- Per-Roblox-Server (JobId) Hidden Category isolation
- Dynamic Micro-Bubble temporary voice channel creation, member routing, lobby return, and cleanup
"""

from __future__ import annotations

import truststore

truststore.inject_into_ssl()

import asyncio
import logging
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Dict, List, Optional, Set, Tuple

import discord
from discord import app_commands

from config import AppSettings, BotNodeConfig
from pin_store import LinkedAccount, PinVerificationStore

logger = logging.getLogger("aura.fleet")

PIN_REGEX = re.compile(r"^(?:[!/.]?(?:link|pin|verify)\s+)?(\d{4})$", re.IGNORECASE)
CATEGORY_PREFIX = "🌐 Server ["


@dataclass
class BubbleSpec:
    """Incoming bubble state from a Roblox game server."""

    bubble_id: str
    bubble_type: str  # "aura" | "whisper"
    locked: bool
    owner_id: Optional[str]
    member_ids: List[str]


@dataclass
class BubbleChannelRecord:
    """Tracked Discord Voice Channel for a specific in-game Bubble."""

    bubble_id: str
    channel_id: int
    channel_name: str
    bubble_type: str
    locked: bool
    granted_discord_ids: Set[int] = field(default_factory=set)


@dataclass
class JobServerState:
    """Tracked Discord state for one isolated Roblox Server (JobId)."""

    job_id: str
    guild_id: int
    category_id: Optional[int] = None
    bubbles: Dict[str, BubbleChannelRecord] = field(default_factory=dict)
    # discord_id -> last bubble channel_id assigned by this JobId
    assigned_member_channel: Dict[int, int] = field(default_factory=dict)
    last_heartbeat: float = field(default_factory=time.time)


class FleetBotNode:
    """Single Discord Bot worker inside the Round-Robin Bot Fleet."""

    def __init__(
        self,
        index: int,
        config: BotNodeConfig,
        fleet: "BotFleetManager",
        is_coordinator: bool,
    ) -> None:
        self.index = index
        self.config = config
        self.fleet = fleet
        self.is_coordinator = is_coordinator

        self.client: Optional[discord.Client] = None
        self.tree: Optional[app_commands.CommandTree] = None
        self._runner_task: Optional[asyncio.Task[None]] = None

        self.ready: bool = False
        self.privileged_intents: bool = True
        self.requests_dispatched: int = 0
        self.rate_limits_hit: int = 0
        self.errors_hit: int = 0
        self.cooldown_until: float = 0.0
        self.synced_guilds: Set[int] = set()

    @property
    def name(self) -> str:
        return self.config.name

    @property
    def user_id(self) -> Optional[int]:
        if self.client and self.client.user:
            return self.client.user.id
        if self.config.application_id and self.config.application_id.isdigit():
            return int(self.config.application_id)
        return None

    def is_available(self, guild_id: Optional[int] = None) -> bool:
        if not self.ready or not self.client or self.client.is_closed():
            return False
        if time.time() < self.cooldown_until:
            return False
        if guild_id is not None and self.client.get_guild(guild_id) is None:
            return False
        return True

    def _build_client(self, privileged: bool) -> discord.Client:
        intents = discord.Intents(
            guilds=True,
            voice_states=True,
            guild_messages=True,
            dm_messages=True,
            members=privileged,
            message_content=privileged,
        )
        client = discord.Client(intents=intents)

        if self.is_coordinator:
            tree = app_commands.CommandTree(client)
            self._register_slash_commands(tree)
            self.tree = tree
        else:
            self.tree = None

        @client.event
        async def on_ready() -> None:
            self.ready = True
            guild_names = [f"{g.name} ({g.id})" for g in client.guilds]
            logger.info(
                "[%s] Ready as %s (ID: %s) | Intents(privileged=%s) | Guilds: %s",
                self.name,
                client.user,
                client.user.id if client.user else "?",
                privileged,
                guild_names or "NONE — Invite this bot to your Discord server!",
            )
            for guild in client.guilds:
                self.fleet.seed_guild_voice_states(guild)
            await self.fleet.on_node_ready(self)

        @client.event
        async def on_guild_join(guild: discord.Guild) -> None:
            logger.info("[%s] Joined Discord Guild: %s (%d)", self.name, guild.name, guild.id)
            self.fleet.seed_guild_voice_states(guild)
            await self.fleet.on_node_ready(self)

        @client.event
        async def on_voice_state_update(
            member: discord.Member,
            before: discord.VoiceState,
            after: discord.VoiceState,
        ) -> None:
            self.fleet.update_voice_location(
                guild_id=member.guild.id,
                discord_id=member.id,
                channel_id=after.channel.id if after.channel else None,
            )

        @client.event
        async def on_message(message: discord.Message) -> None:
            if message.author.bot:
                return
            await self._handle_pin_message(message)

        return client

    def _register_slash_commands(self, tree: app_commands.CommandTree) -> None:
        @tree.command(
            name="link",
            description="Link your Roblox character using your 4-digit in-game Aura PIN",
        )
        @app_commands.describe(pin="The 4-digit PIN shown on your Roblox screen")
        async def link_cmd(interaction: discord.Interaction, pin: str) -> None:
            cleaned = pin.strip()
            if not (len(cleaned) == 4 and cleaned.isdigit()):
                await interaction.response.send_message(
                    "❌ Please enter a valid **4-digit numeric PIN** (example: `/link pin:4829`).",
                    ephemeral=True,
                )
                return

            account = await self.fleet.pin_store.redeem_pin(
                pin=cleaned,
                discord_id=interaction.user.id,
                discord_tag=str(interaction.user),
            )
            if not account:
                await interaction.response.send_message(
                    "❌ Invalid or expired PIN. Check the **Aura Voice** panel in Roblox for your active 4-digit PIN.",
                    ephemeral=True,
                )
                return

            lobby_mention = self.fleet.get_lobby_mention()
            embed = discord.Embed(
                title="🎙️ Aura Voice Linked!",
                description=(
                    f"Connected **{interaction.user.mention}** ↔ Roblox **@{account.roblox_username}**\n\n"
                    f"**Next Step:** Join {lobby_mention} and stay connected! "
                    "Our Bot Fleet will automatically move you into dynamic voice bubbles as you walk near players or press **[E]** to whisper."
                ),
                color=0x5865F2,
            )
            await interaction.response.send_message(embed=embed, ephemeral=True)

        @tree.command(
            name="unlink",
            description="Unlink your Discord account from your Roblox Aura Voice profile",
        )
        async def unlink_cmd(interaction: discord.Interaction) -> None:
            removed = await self.fleet.pin_store.unlink_by_discord(interaction.user.id)
            if not removed:
                await interaction.response.send_message(
                    "ℹ️ Your Discord account is not currently linked to any Roblox account.",
                    ephemeral=True,
                )
                return
            await interaction.response.send_message(
                f"✅ Unlinked from Roblox **@{removed.roblox_username}**.",
                ephemeral=True,
            )

        @tree.command(
            name="aura_status",
            description="Check your Roblox link status and Bot Fleet health",
        )
        async def status_cmd(interaction: discord.Interaction) -> None:
            link = self.fleet.pin_store.get_link_by_discord(interaction.user.id)
            in_voice = self.fleet.get_member_voice_channel(interaction.user.id) is not None
            ready_count = sum(1 for n in self.fleet.nodes if n.ready)
            desc = (
                f"**Linked Roblox:** {f'`@{link.roblox_username}` (`{link.roblox_user_id}`)' if link else '❌ Not Linked'}\n"
                f"**In Voice Channel:** {'🟢 Yes' if in_voice else f'🟡 No (Join {self.fleet.get_lobby_mention()})'}\n"
                f"**Bot Fleet Online:** `{ready_count}/{len(self.fleet.nodes)}` nodes\n"
                f"**Active Game Servers:** `{len(self.fleet.jobs)}`"
            )
            embed = discord.Embed(title="🫧 Aura Voice Status", description=desc, color=0x22C55E)
            await interaction.response.send_message(embed=embed, ephemeral=True)

    async def _handle_pin_message(self, message: discord.Message) -> None:
        is_dm = message.guild is None
        bot_user = self.client.user if self.client else None

        # Prevent 5x duplicate responses in guild channels:
        # - If a specific bot was @mentioned, ONLY that mentioned bot handles it.
        # - Otherwise in guild channels, ONLY the primary coordinator handles `!link 1234` / `1234`.
        if not is_dm:
            mentioned_ids = {u.id for u in message.mentions}
            if mentioned_ids:
                if not bot_user or bot_user.id not in mentioned_ids:
                    return
            elif not self.is_coordinator:
                return

        content = message.content.strip()
        if bot_user:
            content = re.sub(rf"<@!?{bot_user.id}>", "", content).strip()

        if content.lower() in {"!unlink", "/unlink"}:
            removed = await self.fleet.pin_store.unlink_by_discord(message.author.id)
            reply = (
                f"✅ Unlinked from Roblox **@{removed.roblox_username}**."
                if removed
                else "ℹ️ Your Discord account is not currently linked."
            )
            await message.reply(reply, mention_author=False)
            return

        match = PIN_REGEX.match(content)
        if not match:
            if is_dm and content:
                await message.reply(
                    "👋 Send me your **4-digit PIN** from Roblox (for example: `4829`) to link your Aura Voice!",
                    mention_author=False,
                )
            return

        # In public guild channels, only treat bare 4-digit numbers as PINs if prefixed or @mentioned,
        # OR if that exact 4-digit PIN actually exists in pending PINs!
        pin = match.group(1)
        account = await self.fleet.pin_store.redeem_pin(
            pin=pin,
            discord_id=message.author.id,
            discord_tag=str(message.author),
        )
        if not account:
            # Only reply with error if DM, @mentioned, or explicit !link/!pin command
            explicit_cmd = is_dm or bool(message.mentions) or content.lower().startswith(("!", "/", "link", "pin", "verify"))
            if explicit_cmd:
                await message.reply(
                    "❌ Invalid or expired **4-digit PIN**. Check the **Aura Voice** box in Roblox and try again!",
                    mention_author=False,
                )
            return

        lobby_mention = self.fleet.get_lobby_mention()
        embed = discord.Embed(
            title="🎙️ Aura Voice Linked!",
            description=(
                f"Linked **{message.author.mention}** ↔ Roblox **@{account.roblox_username}**!\n"
                f"Join {lobby_mention} — we'll move you into voice bubbles automatically as you play."
            ),
            color=0x22C55E,
        )
        await message.reply(embed=embed, mention_author=False)
        # Clean up PIN message in guild channels if allowed for tidiness
        if not is_dm:
            try:
                await message.delete(delay=5.0)
            except Exception:
                pass

    def start_background(self) -> None:
        self._runner_task = asyncio.create_task(self._run_forever(), name=f"bot-{self.name}")

    async def _run_forever(self) -> None:
        """Start the Discord client, falling back cleanly if Privileged Intents aren't enabled."""
        for attempt_privileged in (True, False):
            self.privileged_intents = attempt_privileged
            self.client = self._build_client(privileged=attempt_privileged)
            try:
                await self.client.start(self.config.token)
                return
            except discord.PrivilegedIntentsRequired:
                await self.client.close()
                if attempt_privileged:
                    logger.warning(
                        "[%s] Privileged Intents not enabled in Discord Dev Portal — "
                        "seamlessly reconnecting with Standard Intents (Voice + Slash + DM work 100%%!).",
                        self.name,
                    )
                    continue
                logger.error("[%s] Failed even with standard intents.", self.name)
                return
            except discord.LoginFailure:
                await self.client.close()
                logger.error("[%s] Invalid Discord Bot Token! Check .env.", self.name)
                return
            except asyncio.CancelledError:
                await self.client.close()
                return
            except Exception as exc:
                await self.client.close()
                logger.exception("[%s] Unexpected bot loop error: %s", self.name, exc)
                await asyncio.sleep(5.0)

    async def stop(self) -> None:
        self.ready = False
        if self.client and not self.client.is_closed():
            await self.client.close()
        if self._runner_task and not self._runner_task.done():
            self._runner_task.cancel()
            try:
                await self._runner_task
            except asyncio.CancelledError:
                pass


class BotFleetManager:
    """
    Coordinates the Discord Bot Fleet:
    - Round-Robin Load Balancing across all online bots
    - JobId Server Category isolation
    - Dynamic Micro-Bubbles & Silent Lobby routing
    """

    def __init__(self, settings: AppSettings, pin_store: PinVerificationStore) -> None:
        self.settings = settings
        self.pin_store = pin_store

        self.nodes: List[FleetBotNode] = [
            FleetBotNode(
                index=i,
                config=cfg,
                fleet=self,
                is_coordinator=(i == 0),
            )
            for i, cfg in enumerate(settings.bot_nodes)
        ]

        self._rr_cursor: int = 0
        self._guild_setup_lock = asyncio.Lock()

        self.target_guild_id: Optional[int] = settings.discord_guild_id
        self.lobby_channel_id: Optional[int] = None

        # guild_id -> {discord_user_id: current_voice_channel_id}
        self._voice_locations: Dict[int, Dict[int, int]] = {}

        # job_id -> JobServerState & per-job lock
        self.jobs: Dict[str, JobServerState] = {}
        self._job_locks: Dict[str, asyncio.Lock] = {}

        self._sweeper_task: Optional[asyncio.Task[None]] = None

    # -------------------------------------------------------------------------
    # Lifecycle
    # -------------------------------------------------------------------------
    async def start(self) -> None:
        if not self.nodes:
            logger.warning("No Discord Bot tokens configured in .env!")
            return

        logger.info("Starting Discord Bot Fleet (%d nodes)...", len(self.nodes))
        for node in self.nodes:
            if node.config.application_id:
                invite_url = (
                    f"https://discord.com/oauth2/authorize?client_id={node.config.application_id}"
                    "&permissions=285214736&scope=bot%20applications.commands"
                )
                logger.info("[%s] Invite URL (if needed): %s", node.name, invite_url)
            node.start_background()

        self._sweeper_task = asyncio.create_task(self._stale_job_sweeper(), name="aura-stale-sweeper")

    async def stop(self) -> None:
        if self._sweeper_task and not self._sweeper_task.done():
            self._sweeper_task.cancel()
            try:
                await self._sweeper_task
            except asyncio.CancelledError:
                pass

        # Clean up any active JobId categories before shutting down
        active_job_ids = list(self.jobs.keys())
        for jid in active_job_ids:
            try:
                await self.cleanup_job(jid)
            except Exception as exc:
                logger.warning("Cleanup error during shutdown for job %s: %s", jid, exc)

        await asyncio.gather(*(n.stop() for n in self.nodes), return_exceptions=True)

    # -------------------------------------------------------------------------
    # Voice State Tracking (Zero Extra REST Calls)
    # -------------------------------------------------------------------------
    def seed_guild_voice_states(self, guild: discord.Guild) -> None:
        guild_map = self._voice_locations.setdefault(guild.id, {})
        # Clear and rebuild from authoritative voice_states across guild voice channels
        active_now: Dict[int, int] = {}
        for vc in guild.voice_channels:
            for member_id in vc.voice_states.keys():
                active_now[int(member_id)] = vc.id
        for sc in guild.stage_channels:
            for member_id in sc.voice_states.keys():
                active_now[int(member_id)] = sc.id
        guild_map.clear()
        guild_map.update(active_now)

    def update_voice_location(self, guild_id: int, discord_id: int, channel_id: Optional[int]) -> None:
        guild_map = self._voice_locations.setdefault(guild_id, {})
        if channel_id is None:
            guild_map.pop(discord_id, None)
        else:
            guild_map[discord_id] = channel_id

    def get_member_voice_channel(self, discord_id: int, guild_id: Optional[int] = None) -> Optional[int]:
        gid = guild_id or self.target_guild_id
        if not gid:
            return None
        return self._voice_locations.get(gid, {}).get(discord_id)

    def get_lobby_mention(self) -> str:
        if self.lobby_channel_id:
            return f"<#{self.lobby_channel_id}>"
        return f"**{self.settings.lobby_channel_name}**"

    # -------------------------------------------------------------------------
    # Guild Auto-Detection & Lobby Bootstrap
    # -------------------------------------------------------------------------
    async def on_node_ready(self, node: FleetBotNode) -> None:
        async with self._guild_setup_lock:
            if self.target_guild_id is None:
                self.target_guild_id = self._detect_shared_guild_id()
                if self.target_guild_id:
                    logger.info("Auto-selected target Discord Guild ID: %d", self.target_guild_id)

            if not self.target_guild_id:
                return

            # Sync slash commands onto target guild on the coordinator node (instant!)
            if (
                node.is_coordinator
                and node.tree
                and node.client
                and self.target_guild_id not in node.synced_guilds
                and node.client.get_guild(self.target_guild_id) is not None
            ):
                try:
                    guild_obj = discord.Object(id=self.target_guild_id)
                    node.tree.copy_global_to(guild=guild_obj)
                    await node.tree.sync(guild=guild_obj)
                    node.synced_guilds.add(self.target_guild_id)
                    logger.info("[%s] Synced /link, /unlink, /aura_status slash commands to guild %d", node.name, self.target_guild_id)
                except Exception as exc:
                    logger.warning("[%s] Slash command guild sync warning: %s", node.name, exc)

            await self._ensure_lobby_channel(self.target_guild_id)

    def _detect_shared_guild_id(self) -> Optional[int]:
        counts: Counter[int] = Counter()
        for n in self.nodes:
            if n.ready and n.client:
                for g in n.client.guilds:
                    counts[g.id] += 1
        if not counts:
            return None
        best_guild_id, count = counts.most_common(1)[0]
        logger.info("Detected primary guild %d present across %d/%d ready bots.", best_guild_id, count, sum(1 for n in self.nodes if n.ready))
        return best_guild_id

    async def _ensure_lobby_channel(self, guild_id: int) -> Optional[int]:
        if self.lobby_channel_id:
            # Verify it still exists in cache
            for n in self.nodes:
                if n.ready and n.client:
                    g = n.client.get_guild(guild_id)
                    if g and g.get_channel(self.lobby_channel_id):
                        return self.lobby_channel_id

        # Search existing voice channels for matching lobby name
        for n in self.nodes:
            if n.ready and n.client:
                g = n.client.get_guild(guild_id)
                if g:
                    for vc in g.voice_channels:
                        if vc.name == self.settings.lobby_channel_name or "aura lobby" in vc.name.lower():
                            self.lobby_channel_id = vc.id
                            logger.info("Found existing Aura Lobby voice channel: %s (%d)", vc.name, vc.id)
                            return self.lobby_channel_id

        # Create the silent waiting lobby voice channel (@everyone can join, speak=False)
        everyone_allow = discord.Permissions(view_channel=True, connect=True)
        everyone_deny = discord.Permissions(speak=True)
        overwrites = [
            {
                "id": guild_id,
                "type": 0,  # Role (@everyone)
                "allow": everyone_allow.value,
                "deny": everyone_deny.value,
            },
            *self._build_bot_overwrites(),
        ]
        try:
            payload = await self._execute_round_robin(
                guild_id,
                "create_lobby",
                lambda node: node.client.http.create_channel(  # type: ignore[union-attr]
                    guild_id,
                    discord.ChannelType.voice.value,
                    name=self.settings.lobby_channel_name,
                    permission_overwrites=overwrites,
                    reason="Aura Voice System: Silent Waiting Lobby",
                ),
            )
            self.lobby_channel_id = int(payload["id"])
            logger.info("Created silent Aura Lobby channel '%s' (%d)", self.settings.lobby_channel_name, self.lobby_channel_id)
            return self.lobby_channel_id
        except Exception as exc:
            logger.warning("Could not auto-create Aura Lobby channel in guild %d: %s", guild_id, exc)
            return None

    # -------------------------------------------------------------------------
    # Round-Robin Load Balancer & Failover Dispatcher
    # -------------------------------------------------------------------------
    def _select_round_robin_candidates(self, guild_id: Optional[int]) -> List[FleetBotNode]:
        total = len(self.nodes)
        if total == 0:
            return []

        start = self._rr_cursor % total
        self._rr_cursor = (self._rr_cursor + 1) % total

        ordered: List[FleetBotNode] = []
        for offset in range(total):
            candidate = self.nodes[(start + offset) % total]
            if candidate.is_available(guild_id):
                ordered.append(candidate)
        return ordered

    async def _execute_round_robin(
        self,
        guild_id: Optional[int],
        op_name: str,
        coro_factory: Callable[[FleetBotNode], Coroutine[Any, Any, Any]],
    ) -> Any:
        """
        Execute a Discord REST operation using strict Round-Robin across available fleet bots.
        Automatically fails over to the next bot node if a node hits HTTP 429 or transient error.
        """
        candidates = self._select_round_robin_candidates(guild_id)
        if not candidates:
            raise RuntimeError(
                f"No online Discord Bot nodes available in guild {guild_id}. "
                "Verify at least one bot is invited to your Discord server."
            )

        last_exc: Optional[Exception] = None
        for node in candidates:
            node.requests_dispatched += 1
            try:
                result = await coro_factory(node)
                logger.debug("[%s] %s succeeded (total=%d)", node.name, op_name, node.requests_dispatched)
                return result
            except discord.HTTPException as exc:
                last_exc = exc
                if exc.status == 429:
                    node.rate_limits_hit += 1
                    retry_after = getattr(exc, "retry_after", None) or 3.0
                    node.cooldown_until = time.time() + float(retry_after)
                    logger.warning(
                        "[%s] Hit HTTP 429 on %s (cooldown %.1fs) — failing over to next fleet node!",
                        node.name,
                        op_name,
                        retry_after,
                    )
                    continue
                if exc.status == 404 or exc.code in {40032, 10003, 10007}:
                    # 40032 = Target user is not connected to voice
                    # 10003 = Unknown Channel, 10007 = Unknown Member
                    # Deterministic state error — do not retry across other bots
                    raise
                if exc.status in {403, 500, 502, 503, 504}:
                    node.errors_hit += 1
                    logger.warning("[%s] HTTP %d on %s — trying next fleet node...", node.name, exc.status, op_name)
                    continue
                node.errors_hit += 1
                raise
            except Exception as exc:
                last_exc = exc
                node.errors_hit += 1
                logger.warning("[%s] Error on %s (%s) — trying next fleet node...", node.name, op_name, exc)
                continue

        assert last_exc is not None
        raise last_exc

    def _build_bot_overwrites(self) -> List[Dict[str, Any]]:
        """Grant every bot node explicit access on hidden categories & channels."""
        bot_allow = discord.Permissions(
            view_channel=True,
            manage_channels=True,
            manage_roles=True,
            connect=True,
            speak=True,
            move_members=True,
            mute_members=True,
        )
        overwrites: List[Dict[str, Any]] = []
        seen_ids: Set[int] = set()
        for n in self.nodes:
            uid = n.user_id
            if uid and uid not in seen_ids:
                seen_ids.add(uid)
                overwrites.append(
                    {
                        "id": uid,
                        "type": 1,  # Member (Bot)
                        "allow": bot_allow.value,
                        "deny": 0,
                    }
                )
        return overwrites

    # -------------------------------------------------------------------------
    # Server Isolation (JobId Hidden Category) & Dynamic Micro-Bubbles
    # -------------------------------------------------------------------------
    def _get_job_lock(self, job_id: str) -> asyncio.Lock:
        if job_id not in self._job_locks:
            self._job_locks[job_id] = asyncio.Lock()
        return self._job_locks[job_id]

    async def _ensure_job_category(self, job: JobServerState) -> int:
        if job.category_id is not None:
            return job.category_id

        short_job = job.job_id[:8]
        category_name = f"{CATEGORY_PREFIX}{short_job}]"

        # Hidden from @everyone; visible & manageable by all fleet bot nodes
        everyone_deny = discord.Permissions(view_channel=True, connect=True)
        overwrites = [
            {
                "id": job.guild_id,
                "type": 0,
                "allow": 0,
                "deny": everyone_deny.value,
            },
            *self._build_bot_overwrites(),
        ]

        payload = await self._execute_round_robin(
            job.guild_id,
            f"create_category({short_job})",
            lambda node: node.client.http.create_channel(  # type: ignore[union-attr]
                job.guild_id,
                discord.ChannelType.category.value,
                name=category_name,
                permission_overwrites=overwrites,
                reason=f"Roblox Server Isolation (JobId: {job.job_id})",
            ),
        )
        job.category_id = int(payload["id"])
        logger.info("Created isolated hidden Category '%s' (%d) for JobId %s", category_name, job.category_id, job.job_id)
        return job.category_id

    @staticmethod
    def _format_bubble_channel_name(spec: BubbleSpec) -> str:
        short_id = spec.bubble_id[-4:]
        if spec.bubble_type == "whisper":
            prefix = "🔒 Whisper" if spec.locked else "🤫 Whisper"
        else:
            prefix = "🔒 Locked Aura" if spec.locked else "🫧 Aura"
        return f"{prefix} • {short_id}"

    async def _create_bubble_channel(
        self,
        job: JobServerState,
        category_id: int,
        spec: BubbleSpec,
        member_discord_ids: Set[int],
    ) -> BubbleChannelRecord:
        channel_name = self._format_bubble_channel_name(spec)

        # @everyone cannot see or manually click-join the bubble;
        # Speak + VAD are enabled so anyone moved inside by the Bot Fleet can talk immediately.
        everyone_allow = discord.Permissions(speak=True, use_voice_activation=True)
        everyone_deny = discord.Permissions(view_channel=True, connect=True)

        member_allow = discord.Permissions(view_channel=True, speak=True, use_voice_activation=True)
        member_overwrites = [
            {
                "id": did,
                "type": 1,
                "allow": member_allow.value,
                "deny": discord.Permissions(connect=True).value,
            }
            for did in member_discord_ids
        ]

        overwrites = [
            {
                "id": job.guild_id,
                "type": 0,
                "allow": everyone_allow.value,
                "deny": everyone_deny.value,
            },
            *self._build_bot_overwrites(),
            *member_overwrites,
        ]

        user_limit = len(spec.member_ids) if spec.locked else 0

        payload = await self._execute_round_robin(
            job.guild_id,
            f"create_bubble({spec.bubble_id})",
            lambda node: node.client.http.create_channel(  # type: ignore[union-attr]
                job.guild_id,
                discord.ChannelType.voice.value,
                name=channel_name,
                parent_id=category_id,
                user_limit=user_limit,
                permission_overwrites=overwrites,
                reason=f"Dynamic Micro-Bubble {spec.bubble_id} (JobId: {job.job_id[:8]})",
            ),
        )
        channel_id = int(payload["id"])
        record = BubbleChannelRecord(
            bubble_id=spec.bubble_id,
            channel_id=channel_id,
            channel_name=channel_name,
            bubble_type=spec.bubble_type,
            locked=spec.locked,
            granted_discord_ids=set(member_discord_ids),
        )
        job.bubbles[spec.bubble_id] = record
        logger.info("Created Micro-Bubble channel '%s' (%d) in JobId %s", channel_name, channel_id, job.job_id[:8])
        return record

    async def _update_channel_lock_limit(self, guild_id: int, channel_id: int, user_limit: int) -> None:
        try:
            await self._execute_round_robin(
                guild_id,
                f"lock_limit({channel_id}->{user_limit})",
                lambda node: node.client.http.edit_channel(  # type: ignore[union-attr]
                    channel_id,
                    user_limit=user_limit,
                    reason="Aura Bubble lock state updated",
                ),
            )
        except Exception as exc:
            logger.debug("Non-fatal lock limit update skip on %d: %s", channel_id, exc)

    async def _grant_bubble_visibility(self, guild_id: int, channel_id: int, discord_id: int) -> None:
        allow_bits = str(discord.Permissions(view_channel=True, speak=True, use_voice_activation=True).value)
        deny_bits = str(discord.Permissions(connect=True).value)
        try:
            await self._execute_round_robin(
                guild_id,
                f"grant_view({discord_id}->{channel_id})",
                lambda node: node.client.http.edit_channel_permissions(  # type: ignore[union-attr]
                    channel_id,
                    discord_id,
                    allow_bits,
                    deny_bits,
                    1,  # Member overwrite
                    reason="Aura Bubble member visibility",
                ),
            )
        except Exception as exc:
            logger.debug("Non-fatal permission update skip on %d: %s", channel_id, exc)

    async def _move_member(self, guild_id: int, discord_id: int, target_channel_id: int, reason: str) -> bool:
        """Move a voice-connected Discord member using the next Round-Robin bot node."""
        current_vc = self.get_member_voice_channel(discord_id, guild_id)
        if current_vc == target_channel_id:
            return True
        if current_vc is None:
            # User is not connected to any Discord voice channel right now
            return False

        try:
            await self._execute_round_robin(
                guild_id,
                f"move_member({discord_id}->{target_channel_id})",
                lambda node: node.client.http.edit_member(  # type: ignore[union-attr]
                    guild_id,
                    discord_id,
                    channel_id=target_channel_id,
                    reason=reason,
                ),
            )
            # Optimistically update local voice tracker immediately
            self.update_voice_location(guild_id, discord_id, target_channel_id)
            return True
        except discord.HTTPException as exc:
            if exc.code == 40032:
                # Target user disconnected from voice right before the PATCH
                self.update_voice_location(guild_id, discord_id, None)
                return False
            logger.warning("Failed moving Discord user %d to channel %d: %s", discord_id, target_channel_id, exc)
            return False

    async def _delete_channel_safe(self, guild_id: int, channel_id: int, reason: str) -> None:
        try:
            await self._execute_round_robin(
                guild_id,
                f"delete_channel({channel_id})",
                lambda node: node.client.http.delete_channel(channel_id, reason=reason),  # type: ignore[union-attr]
            )
        except discord.HTTPException as exc:
            if exc.status == 404 or exc.code == 10003:
                return
            logger.warning("Failed deleting channel %d: %s", channel_id, exc)

    async def sync_job_bubbles(
        self,
        job_id: str,
        bubbles: List[BubbleSpec],
        active_roblox_ids: List[str],
    ) -> Dict[str, Any]:
        """
        Reconcile a Roblox server's active Aura & Whisper bubbles with Discord:
        1. Create hidden JobId Category on demand when bubbles exist
        2. Create new Micro-Bubble voice channels dynamically
        3. Move grouped Discord members into their Bubble voice channels (Round-Robin parallel)
        4. Move newly ungrouped Discord members back to silent Aura Lobby
        5. Delete empty / dissolved Micro-Bubble voice channels
        """
        if self.target_guild_id is None:
            self.target_guild_id = self._detect_shared_guild_id()

        guild_id = self.target_guild_id
        if not guild_id or not any(n.is_available(guild_id) for n in self.nodes):
            return {
                "fleet_ready": False,
                "guild_id": str(guild_id) if guild_id else None,
                "active_bubbles": 0,
                "moves_executed": 0,
            }

        await self._ensure_lobby_channel(guild_id)

        lock = self._get_job_lock(job_id)
        async with lock:
            job = self.jobs.get(job_id)
            if job is None:
                job = JobServerState(job_id=job_id, guild_id=guild_id)
                self.jobs[job_id] = job
            job.last_heartbeat = time.time()

            # Keep only valid bubbles with >= 2 Roblox players
            valid_bubbles = [b for b in bubbles if len(b.member_ids) >= 2]
            incoming_ids = {b.bubble_id for b in valid_bubbles}

            # Ensure hidden JobId category exists whenever at least one bubble is active
            if valid_bubbles and job.category_id is None:
                await self._ensure_job_category(job)

            # Map desired discord_id -> BubbleChannelRecord
            desired_member_bubble: Dict[int, BubbleChannelRecord] = {}
            perm_tasks: List[Coroutine[Any, Any, Any]] = []

            for spec in valid_bubbles:
                member_discord_ids: Set[int] = set()
                for rbx_uid in spec.member_ids:
                    link = self.pin_store.get_link_by_roblox(rbx_uid)
                    if link:
                        member_discord_ids.add(link.discord_id)

                record = job.bubbles.get(spec.bubble_id)
                if record is None:
                    assert job.category_id is not None
                    record = await self._create_bubble_channel(
                        job=job,
                        category_id=job.category_id,
                        spec=spec,
                        member_discord_ids=member_discord_ids,
                    )
                else:
                    if record.locked != spec.locked:
                        record.locked = spec.locked
                        new_limit = len(spec.member_ids) if spec.locked else 0
                        perm_tasks.append(
                            self._update_channel_lock_limit(guild_id, record.channel_id, new_limit)
                        )
                    record.bubble_type = spec.bubble_type
                    new_members = member_discord_ids - record.granted_discord_ids
                    for did in new_members:
                        record.granted_discord_ids.add(did)
                        perm_tasks.append(self._grant_bubble_visibility(guild_id, record.channel_id, did))

                for did in member_discord_ids:
                    desired_member_bubble[did] = record

            if perm_tasks:
                await asyncio.gather(*perm_tasks, return_exceptions=True)

            # 1. Dispatch parallel Round-Robin moves into active Bubble channels
            move_tasks: List[Coroutine[Any, Any, bool]] = []
            for did, record in desired_member_bubble.items():
                job.assigned_member_channel[did] = record.channel_id
                move_tasks.append(
                    self._move_member(
                        guild_id=guild_id,
                        discord_id=did,
                        target_channel_id=record.channel_id,
                        reason=f"Joined {record.bubble_type} bubble {record.bubble_id}",
                    )
                )

            # 2. Any player previously placed in a bubble on this JobId who is NO LONGER
            #    in any bubble gets moved back to the silent Aura Lobby BEFORE we delete empty bubbles!
            previously_assigned = list(job.assigned_member_channel.keys())
            lobby_return_tasks: List[Coroutine[Any, Any, bool]] = []
            for did in previously_assigned:
                if did not in desired_member_bubble:
                    old_bubble_channel_id = job.assigned_member_channel.pop(did, None)
                    current_vc = self.get_member_voice_channel(did, guild_id)
                    if (
                        self.lobby_channel_id
                        and current_vc is not None
                        and current_vc == old_bubble_channel_id
                    ):
                        lobby_return_tasks.append(
                            self._move_member(
                                guild_id=guild_id,
                                discord_id=did,
                                target_channel_id=self.lobby_channel_id,
                                reason="Left Aura Bubble (>30 studs) -> Returning to Lobby",
                            )
                        )

            move_results = await asyncio.gather(*move_tasks, *lobby_return_tasks, return_exceptions=True)
            moves_executed = sum(1 for r in move_results if r is True)

            # 3. Delete dissolved / empty Micro-Bubble channels in parallel via Round-Robin Fleet
            stale_bubble_ids = [bid for bid in list(job.bubbles.keys()) if bid not in incoming_ids]
            if stale_bubble_ids:
                delete_tasks = []
                for bid in stale_bubble_ids:
                    rec = job.bubbles.pop(bid)
                    delete_tasks.append(
                        self._delete_channel_safe(
                            guild_id=guild_id,
                            channel_id=rec.channel_id,
                            reason=f"Empty Micro-Bubble {bid} dissolved",
                        )
                    )
                await asyncio.gather(*delete_tasks, return_exceptions=True)
                logger.info("Deleted %d empty Micro-Bubble channel(s) in JobId %s", len(stale_bubble_ids), job_id[:8])

            return {
                "fleet_ready": True,
                "guild_id": str(guild_id),
                "category_id": str(job.category_id) if job.category_id else None,
                "lobby_channel_id": str(self.lobby_channel_id) if self.lobby_channel_id else None,
                "active_bubbles": len(job.bubbles),
                "moves_executed": moves_executed,
            }

    async def cleanup_job(self, job_id: str) -> Dict[str, Any]:
        """
        Full teardown when a Roblox server shuts down (`BindToClose` -> `/cleanup`):
        1. Return any voice-connected members inside this JobId's bubbles to the Aura Lobby
        2. Delete all temporary voice channels in parallel across the Bot Fleet
        3. Delete the isolated JobId Category
        """
        lock = self._get_job_lock(job_id)
        async with lock:
            job = self.jobs.pop(job_id, None)
            if not job:
                return {"cleaned": False, "job_id": job_id, "deleted_channels": 0}

            guild_id = job.guild_id
            bubble_channel_ids = {rec.channel_id for rec in job.bubbles.values()}

            # 1. Evacuate any players still inside this server's bubbles back to the Lobby
            if self.lobby_channel_id and bubble_channel_ids:
                evac_tasks = []
                for did, vc_id in list(self._voice_locations.get(guild_id, {}).items()):
                    if vc_id in bubble_channel_ids:
                        evac_tasks.append(
                            self._move_member(
                                guild_id=guild_id,
                                discord_id=did,
                                target_channel_id=self.lobby_channel_id,
                                reason=f"Roblox Server {job_id[:8]} shutting down",
                            )
                        )
                if evac_tasks:
                    await asyncio.gather(*evac_tasks, return_exceptions=True)

            # 2. Delete all bubble channels concurrently via Round-Robin Fleet
            deleted_count = 0
            if bubble_channel_ids:
                await asyncio.gather(
                    *(
                        self._delete_channel_safe(
                            guild_id=guild_id,
                            channel_id=cid,
                            reason=f"JobId {job_id[:8]} BindToClose cleanup",
                        )
                        for cid in bubble_channel_ids
                    ),
                    return_exceptions=True,
                )
                deleted_count += len(bubble_channel_ids)

            # 3. Delete the JobId Category itself
            if job.category_id is not None:
                await self._delete_channel_safe(
                    guild_id=guild_id,
                    channel_id=job.category_id,
                    reason=f"JobId {job_id[:8]} BindToClose category cleanup",
                )
                deleted_count += 1

            logger.info("Cleaned up JobId %s (%d Discord objects deleted).", job_id, deleted_count)
            return {"cleaned": True, "job_id": job_id, "deleted_channels": deleted_count}

    async def _stale_job_sweeper(self) -> None:
        """Background watchdog: cleans up crashed Roblox servers that missed BindToClose."""
        while True:
            await asyncio.sleep(30.0)
            now = time.time()
            stale_ids = [
                jid
                for jid, state in self.jobs.items()
                if (now - state.last_heartbeat) > self.settings.stale_job_timeout_seconds
            ]
            for jid in stale_ids:
                logger.info("Sweeping stale Roblox JobId %s (no heartbeat > %.0fs)", jid, self.settings.stale_job_timeout_seconds)
                try:
                    await self.cleanup_job(jid)
                except Exception as exc:
                    logger.warning("Failed sweeping stale job %s: %s", jid, exc)

    def get_fleet_telemetry(self) -> Dict[str, Any]:
        return {
            "target_guild_id": str(self.target_guild_id) if self.target_guild_id else None,
            "lobby_channel_id": str(self.lobby_channel_id) if self.lobby_channel_id else None,
            "active_jobs": len(self.jobs),
            "linked_accounts": self.pin_store.total_linked,
            "pending_pins": self.pin_store.active_pins_count,
            "nodes": [
                {
                    "name": n.name,
                    "ready": n.ready,
                    "user_id": str(n.user_id) if n.user_id else None,
                    "privileged_intents": n.privileged_intents,
                    "requests_dispatched": n.requests_dispatched,
                    "rate_limits_hit": n.rate_limits_hit,
                    "errors_hit": n.errors_hit,
                    "cooling_down": time.time() < n.cooldown_until,
                }
                for n in self.nodes
            ],
        }
