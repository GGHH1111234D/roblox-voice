/**
 * Roblox Aura Voice — Discord-Style Floating PiP Overlay + 3D WebRTC Engine
 * =========================================================================
 * مظهر وتقنيات اتصال ديسكورد الرسمية:
 * 1. محرك شاشة ديسكورد العائمة (Discord Overlay Engine) على كانفاس 480x240.
 * 2. نافذة Picture-in-Picture تطفو فوق روبلوكس مع دوائر التحدث الخضراء المشعة وعداد المكالمة.
 * 3. صوت محيطي 3D حقيقي (HRTF Panner) بمقاييس روبلوكس (Studs).
 * 4. ربط فوري برمز الـ PIN المكون من 4 أرقام فقط (بدون ديسكورد خارجي ولا بوتات).
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // 3D audio tuning. All distances are in Roblox STUDS: we feed Roblox world
  // coordinates straight into the Web Audio API, so 1 Web Audio unit = 1 stud.
  // ---------------------------------------------------------------------------
  const SPATIAL_CONFIG = {
    // PannerNode distance model ("inverse"):
    //   gain = REF / (REF + ROLLOFF * (max(d, REF) - REF))
    //   d = 6 -> 1.00 | d = 15 -> 0.36 | d = 30 -> 0.17 | d = 55 -> 0.09
    REF_DISTANCE: 6,           // full volume within 6 studs
    ROLLOFF_FACTOR: 1.2,       // how fast volume drops past REF_DISTANCE
    // The inverse model never reaches true silence (and simply stops attenuating
    // past `maxDistance`), so we add our own linear fade-to-zero on a GainNode:
    FADE_START_DISTANCE: 55,   // start fading out at 55 studs...
    MAX_HEARING_DISTANCE: 80,  // ...completely silent at 80 studs

    // Positions arrive every 0.5s. Instead of jumping (which causes audible clicks
    // and "teleporting" voices) every AudioParam glides toward its new target with
    // setTargetAtTime(). τ = 0.15s reaches ~95% of the target after 3τ ≈ 0.45s,
    // i.e. just before the next update arrives -> continuous, smooth motion.
    SMOOTHING_TIME_CONSTANT: 0.15,

    // Directional voices: a speaker facing AWAY from you sounds quieter, like real
    // life. Implemented with the PannerNode's sound cone + the speaker's yaw.
    DIRECTIONAL_VOICE: true,
    CONE_INNER_ANGLE: 140,     // full volume inside this cone (degrees) in front of the speaker
    CONE_OUTER_ANGLE: 320,     // outside this cone the volume is CONE_OUTER_GAIN
    CONE_OUTER_GAIN: 0.45,     // 45% volume when they talk with their back to you
  };

  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ],
  };

  function buildSignalingUrl(pin) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ pin: pin || "" });
    return `${protocol}//${window.location.host}/ws?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // عناصر الواجهة (DOM Elements)
  // ---------------------------------------------------------------------------
  const connectBtn = document.getElementById("connect-btn");
  const connectBtnText = document.getElementById("connect-btn-text");
  const fallbackForegroundBtn = document.getElementById("fallback-foreground-btn");
  const sessionControls = document.getElementById("session-controls");
  const muteBtn = document.getElementById("mute-btn");
  const muteBtnText = document.getElementById("mute-btn-text");
  const reopenPipBtn = document.getElementById("reopen-pip-btn");
  const disconnectBtn = document.getElementById("disconnect-btn");

  const pinInput = document.getElementById("pin-input");
  const identityGroup = document.getElementById("identity-group");
  const togglePinMaskBtn = document.getElementById("toggle-pin-mask");

  if (togglePinMaskBtn && pinInput) {
    let isMasked = false;
    togglePinMaskBtn.addEventListener("click", () => {
      isMasked = !isMasked;
      pinInput.type = isMasked ? "password" : "text";
      togglePinMaskBtn.textContent = isMasked ? "🔒" : "👁️";
    });
  }

  const alertBanner = document.getElementById("alert-banner");
  const globalStatusDot = document.getElementById("global-status-dot");
  const globalStatusLabel = document.getElementById("global-status-label");
  const pipStatusVal = document.getElementById("pip-status-val");
  const wsStatusVal = document.getElementById("ws-status-val");
  const spatialStatusVal = document.getElementById("spatial-status-val");
  const micStateText = document.getElementById("mic-state-text");
  const micMeterBar = document.getElementById("mic-meter-bar");

  const discordGrid = document.getElementById("discord-grid");
  const peerCountBadge = document.getElementById("peer-count-badge");
  const remoteAudioContainer = document.getElementById("remote-audio-container");
  const debugLogEl = document.getElementById("debug-log");

  const pipCanvas = document.getElementById("pipCanvas");
  const pipCtx = pipCanvas.getContext("2d", { alpha: false });
  const pipVideo = document.getElementById("pip-video");

  try {
    pinInput.value = localStorage.getItem("rbx_aura_pin") || "";
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // حالة التطبيق (Runtime State)
  // ---------------------------------------------------------------------------
  let myPin = ""; // 4-digit PIN entered by player
  let myRobloxUserId = ""; // resolved automatically from myPin via pinMap
  let latestPinMap = {};
  let myUsername = "أنا";
  let myPeerId = null;

  let localAudioStream = null;
  let canvasVideoStream = null;
  let combinedPipStream = null;

  let isOverlayRunning = false;
  let overlayRafId = null;
  let overlayIntervalId = null;
  let callStartTime = 0;

  let audioContext = null;
  let localAnalyser = null;
  let micLevelPct = 0;
  let isSelfSpeaking = false;
  let meterRafId = null;

  let ws = null;
  let wsHeartbeatInterval = null;
  let isMicMuted = false;
  let isPipActive = false;
  let awaitingSecondTapForPiP = false;
  let isIntentionalDisconnect = false;

  let latestLocations = {}; // { [userId]: { userId, username, x, y, z, yaw, jobId } }
  let isListenerPlaced = false; // first listener placement snaps instead of gliding

  /**
   * الأقران المتصلون في الغرفة
   */
  const peers = new Map();

  // ---------------------------------------------------------------------------
  // دوال مساعدة
  // ---------------------------------------------------------------------------
  function log(tag, message) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const line = `[${time}] [${tag}] ${message}`;
    console.log(line);
    if (debugLogEl) {
      debugLogEl.textContent += line + "\n";
      debugLogEl.scrollTop = debugLogEl.scrollHeight;
    }
  }

  function showAlert(message, isError = false) {
    alertBanner.textContent = message;
    alertBanner.classList.toggle("error", isError);
    alertBanner.classList.remove("hidden");
  }

  function clearAlert() {
    alertBanner.textContent = "";
    alertBanner.classList.add("hidden");
  }

  function updateGlobalStatus(label, dotState = "") {
    globalStatusLabel.textContent = label;
    globalStatusDot.className = "pulse-dot" + (dotState ? ` ${dotState}` : "");
  }

  function updatePipUiState(active) {
    isPipActive = active;
    if (active) {
      pipStatusVal.textContent = "نافذة ديسكورد نشطة";
      pipStatusVal.className = "pill-value ok";
      reopenPipBtn.classList.add("hidden");
      if (ws && ws.readyState === WebSocket.OPEN) {
        updateGlobalStatus("نافذة ديسكورد عائمة فوق روبلوكس", "online");
      }
    } else {
      pipStatusVal.textContent = localAudioStream ? "متوقف مؤقتاً" : "معطل";
      pipStatusVal.className = localAudioStream ? "pill-value warn" : "pill-value";
      if (localAudioStream && ws) {
        reopenPipBtn.classList.remove("hidden");
        updateGlobalStatus("أغلقت نافذة ديسكورد العائمة", "warning");
      }
    }
  }

  function formatCallDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const secs = String(totalSec % 60).padStart(2, "0");
    return `${mins}:${secs}`;
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y + w, x, y, rad);
    ctx.closePath();
  }

  // ---------------------------------------------------------------------------
  // محرك رسم كرت ديسكورد العائم على الكانفاس (Discord PiP Overlay Engine)
  // ---------------------------------------------------------------------------
  function renderFloatingDiscordOverlay() {
    if (!isOverlayRunning) return;

    const W = pipCanvas.width;
    const H = pipCanvas.height;
    const now = Date.now();

    // 1. خلفية كرت ديسكورد المتدرجة الداكنة
    const bgGrad = pipCtx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, "#141a29");
    bgGrad.addColorStop(1, "#090d16");
    pipCtx.fillStyle = bgGrad;
    pipCtx.fillRect(0, 0, W, H);

    // الشريط المضيء العلوي المتفاعل (أخضر عند التحدث، أحمر عند الكتم، بلوربل عند الاتصال)
    pipCtx.fillStyle = isMicMuted
      ? "#ef4444"
      : isSelfSpeaking
      ? "#22c55e"
      : "#5865f2";
    pipCtx.fillRect(0, 0, W, 5);

    // 2. الشريط العلوي (اسم المكالمة + عداد الوقت + نقطة الحالة)
    drawRoundedRect(pipCtx, 14, 14, W - 28, 38, 11);
    pipCtx.fillStyle = "rgba(15, 23, 42, 0.9)";
    pipCtx.fill();
    pipCtx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    pipCtx.lineWidth = 1;
    pipCtx.stroke();

    // نقطة الحالة
    pipCtx.beginPath();
    pipCtx.arc(W - 32, 33, 6, 0, Math.PI * 2);
    pipCtx.fillStyle = isMicMuted ? "#ef4444" : "#22c55e";
    pipCtx.fill();

    // عنوان المكالمة
    pipCtx.font = "bold 14px system-ui, -apple-system, Segoe UI, sans-serif";
    pipCtx.textAlign = "right";
    pipCtx.textBaseline = "middle";
    pipCtx.fillStyle = "#f8fafc";
    const headerTitle = isMicMuted
      ? "المايك مكتوم 🔇"
      : isSelfSpeaking
      ? "أنت تتحدث الآن 🎙️"
      : "AURA VOICE (صوت مكاني 3D)";
    pipCtx.fillText(headerTitle, W - 46, 33);

    // عداد المكالمة في اليسار
    pipCtx.textAlign = "left";
    pipCtx.font = "bold 14px ui-monospace, SFMono-Regular, Consolas, monospace";
    pipCtx.fillStyle = "#a5b4fc";
    const elapsed = callStartTime > 0 ? formatCallDuration(now - callStartTime) : "00:00";
    pipCtx.fillText(elapsed, 28, 33);

    // 3. جمع اللاعبين (أنت + الأقران المقربين) لعرض الأفاتارات بأسلوب ديسكورد
    const slots = [
      {
        name: myUsername || "أنا",
        sub: isMicMuted ? "مكتوم" : isSelfSpeaking ? "يتحدث..." : "متصل",
        speaking: isSelfSpeaking,
        muted: isMicMuted,
        isSelf: true,
      },
    ];

    for (const [peerId, info] of peers.entries()) {
      if (slots.length >= 4) break;
      slots.push({
        name: info.username || `لاعب ${info.pin || peerId.slice(0, 4)}`,
        sub: info.spatialSummary || "متصل",
        speaking: Boolean(info.isSpeaking),
        muted: false,
        isSelf: false,
      });
    }

    // رسم خانات الأفاتارات
    const count = slots.length;
    const slotWidth = Math.min(108, (W - 28) / count);
    const startX = (W - slotWidth * count) / 2;
    const centerY = 126;

    slots.forEach((slot, idx) => {
      const cx = startX + slotWidth * idx + slotWidth / 2;

      // تأثير التوهج الأخضر المشع الخاص بديسكورد عند التحدث (Speaking Glow Ring)
      if (slot.speaking) {
        const pulse = slot.isSelf
          ? Math.max(3, (micLevelPct / 100) * 8)
          : 4 + (Math.sin(now / 120) + 1) * 2;

        pipCtx.beginPath();
        pipCtx.arc(cx, centerY, 30 + pulse * 0.45, 0, Math.PI * 2);
        pipCtx.fillStyle = "rgba(34, 197, 94, 0.28)";
        pipCtx.fill();

        pipCtx.beginPath();
        pipCtx.arc(cx, centerY, 29, 0, Math.PI * 2);
        pipCtx.lineWidth = 3.5;
        pipCtx.strokeStyle = "#22c55e";
        pipCtx.stroke();
      } else if (slot.muted) {
        pipCtx.beginPath();
        pipCtx.arc(cx, centerY, 28, 0, Math.PI * 2);
        pipCtx.lineWidth = 2;
        pipCtx.strokeStyle = "rgba(239, 68, 68, 0.7)";
        pipCtx.stroke();
      }

      // دائرة الأفاتار
      pipCtx.beginPath();
      pipCtx.arc(cx, centerY, 24, 0, Math.PI * 2);
      pipCtx.fillStyle = slot.isSelf ? "#1e293b" : "#172033";
      pipCtx.fill();

      // الحروف الأولى من الاسم (Initials)
      const initials = slot.name.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, "").slice(0, 2).toUpperCase() || "🎙️";
      pipCtx.font = "bold 15px system-ui, -apple-system, sans-serif";
      pipCtx.textAlign = "center";
      pipCtx.textBaseline = "middle";
      pipCtx.fillStyle = slot.speaking ? "#86efac" : "#e2e8f0";
      pipCtx.fillText(initials, cx, centerY);

      // أيقونة الكتم الصغيرة الحمراء أسفل الأفاتار
      if (slot.muted) {
        pipCtx.beginPath();
        pipCtx.arc(cx + 17, centerY + 17, 7, 0, Math.PI * 2);
        pipCtx.fillStyle = "#ef4444";
        pipCtx.fill();
        pipCtx.strokeStyle = "#0f172a";
        pipCtx.lineWidth = 2;
        pipCtx.stroke();
      }

      // اسم اللاعب أسفل الأفاتار
      pipCtx.font = "bold 12px system-ui, -apple-system, sans-serif";
      pipCtx.textAlign = "center";
      pipCtx.textBaseline = "top";
      pipCtx.fillStyle = slot.speaking ? "#86efac" : "#cbd5e1";
      const shortName = slot.name.length > 9 ? slot.name.slice(0, 8) + ".." : slot.name;
      pipCtx.fillText(shortName, cx, centerY + 34);

      // المسافة أو الحالة أسفل الاسم
      pipCtx.font = "10px ui-monospace, SFMono-Regular, monospace";
      pipCtx.fillStyle = slot.speaking ? "#4ade80" : "#94a3b8";
      const shortSub = slot.sub.length > 13 ? slot.sub.slice(0, 12) + ".." : slot.sub;
      pipCtx.fillText(shortSub, cx, centerY + 49);
    });

    // 4. مؤشر الحالة السفلي الدقيق
    pipCtx.font = "11px system-ui, -apple-system, sans-serif";
    pipCtx.textAlign = "center";
    pipCtx.fillStyle = "#64748b";
    pipCtx.fillText(`PIN: ${myPin || "----"} • Aura 3D Voice Engine`, W / 2, H - 14);
  }

  function startFloatingDiscordOverlayLoop() {
    isOverlayRunning = true;
    callStartTime = Date.now();

    const loop = () => {
      if (!isOverlayRunning) return;
      renderFloatingDiscordOverlay();
      overlayRafId = requestAnimationFrame(loop);
    };
    overlayRafId = requestAnimationFrame(loop);

    // إبقاء الرسوم مستمرة بمعدل 14 إطار بالثانية حتى عندما يكون المتصفح بالخلفية
    overlayIntervalId = setInterval(renderFloatingDiscordOverlay, 70);
  }

  function stopFloatingDiscordOverlayLoop() {
    isOverlayRunning = false;
    cancelAnimationFrame(overlayRafId);
    clearInterval(overlayIntervalId);
    callStartTime = 0;
  }

  // ---------------------------------------------------------------------------
  // واجهة كروت ديسكورد في صفحة الويب
  // ---------------------------------------------------------------------------
  function renderDiscordPeersGrid() {
    peerCountBadge.textContent = `${peers.size} ${peers.size === 1 ? "لاعب" : "لاعبين"}`;
    discordGrid.innerHTML = "";

    // بطاقة اللاعب نفسه
    const selfCard = document.createElement("div");
    selfCard.className = `discord-user-card${isSelfSpeaking ? " speaking" : ""}${isMicMuted ? " muted" : ""}`;

    const selfWrap = document.createElement("div");
    selfWrap.className = "discord-avatar-wrap";

    const selfAvatar = document.createElement("div");
    selfAvatar.className = "discord-avatar";
    selfAvatar.textContent = myUsername.slice(0, 2).toUpperCase() || "أنا";
    selfWrap.appendChild(selfAvatar);

    if (isMicMuted) {
      const muteDot = document.createElement("span");
      muteDot.className = "mute-badge-icon";
      muteDot.textContent = "✕";
      selfWrap.appendChild(muteDot);
    }
    selfCard.appendChild(selfWrap);

    const selfName = document.createElement("span");
    selfName.className = "discord-username";
    selfName.textContent = myUsername + " (أنت)";
    selfCard.appendChild(selfName);

    const selfSub = document.createElement("span");
    selfSub.className = "discord-status-sub";
    selfSub.textContent = isMicMuted ? "مكتوم" : isSelfSpeaking ? "يتحدث..." : `PIN: ${myPin || "—"}`;
    selfCard.appendChild(selfSub);

    discordGrid.appendChild(selfCard);

    // بطاقات باقي اللاعبين
    if (peers.size === 0) {
      return;
    }

    for (const [peerId, info] of peers.entries()) {
      const card = document.createElement("div");
      card.className = `discord-user-card${info.isSpeaking ? " speaking" : ""}`;

      const avatarWrap = document.createElement("div");
      avatarWrap.className = "discord-avatar-wrap";

      const avatar = document.createElement("div");
      avatar.className = "discord-avatar";
      avatar.textContent = info.username.slice(0, 2).toUpperCase() || "🎙️";
      avatarWrap.appendChild(avatar);

      card.appendChild(avatarWrap);

      const nameSpan = document.createElement("span");
      nameSpan.className = "discord-username";
      nameSpan.textContent = info.username;
      card.appendChild(nameSpan);

      const spatialSpan = document.createElement("span");
      spatialSpan.className = "discord-spatial-sub";
      spatialSpan.textContent = info.spatialSummary || "بانتظار الإحداثيات";
      card.appendChild(spatialSpan);

      discordGrid.appendChild(card);
    }
  }

  // ===========================================================================
  // 3D SPATIAL AUDIO ENGINE  (Web Audio API: AudioContext + AudioListener + PannerNode)
  // ===========================================================================
  //
  // HOW THE 3D PANNING WORKS
  // ------------------------
  // An AudioContext renders a graph of audio nodes on a dedicated real-time audio
  // thread. Every remote WebRTC peer gets its own little chain:
  //
  //   MediaStreamSource ──► PannerNode ──► GainNode ──► AudioContext.destination
  //   (their mic, via WebRTC)  (3D placement)  (hearing-range cutoff)   (your speakers)
  //          └──────────────► AnalyserNode  (green "speaking" ring in the UI only)
  //
  // * The AudioContext owns exactly ONE AudioListener = "my ears". We move it to MY
  //   character's Roblox position and rotate it to MY character's facing direction.
  // * Each PannerNode = "a mouth" in that same 3D space. We move it to that PEER's
  //   Roblox position and rotate it to THEIR facing direction.
  // * For every audio block (128 samples, ~3ms) the browser itself computes the vector
  //   listener -> panner, converts it into the listener's local frame, and derives:
  //     - Distance  -> volume, from distanceModel / refDistance / rolloffFactor
  //                    (they walk away -> quieter).
  //     - Azimuth   -> left/right: a voice on my right is louder AND arrives slightly
  //                    earlier in my right ear (inter-aural level + time difference).
  //     - Elevation -> above/below cue (someone on a balcony sounds "up there").
  //     - Cone      -> a speaker facing away from me is quieter (coneInner/Outer/OuterGain).
  // * panningModel = "HRTF" convolves each voice with Head-Related Transfer Functions
  //   (measured filters of how a real head and outer ear colour sound arriving from each
  //   direction). On headphones this even separates front from back. "equalpower" would be
  //   a cheaper plain stereo pan with no front/back or elevation cues.
  //
  // Roblox and Web Audio use the SAME right-handed axes (+X = right, +Y = up, default
  // forward = -Z), so raw Roblox coordinates go straight into the listener/panners.
  // We never compute "relative" positions for the audio ourselves — the listener/panner
  // pair does that natively, per audio block, which keeps the math in one place and
  // lets both sides glide smoothly between our 0.5s updates.
  // ===========================================================================

  // A jump bigger than this between two 0.5s updates is a teleport/respawn, not walking
  // (default WalkSpeed 16 = 8 studs per update): snap instead of "flying" the voice across the map.
  const TELEPORT_SNAP_DISTANCE = 40;
  // If my heading changes by more than this between updates, snap the listener orientation.
  // Gliding each forward-vector component independently through a ~180° turn would pass
  // through a near-zero (degenerate) forward vector and glitch the panning for an instant.
  const LISTENER_YAW_SNAP_RADIANS = (2 * Math.PI) / 3; // 120°

  let lastListenerTarget = null; // { x, y, z, yaw } last values sent to the AudioListener

  function initAndUnlockSpatialAudioContextSync() {
    // MUST run synchronously inside the user's tap/click: iOS Safari & Chrome only allow an
    // AudioContext to start ("running" state) from a user gesture.
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!audioContext) {
        audioContext = new AudioCtx({ latencyHint: "interactive" });

        // Start with the listener at the origin facing -Z (Roblox's default "forward").
        resetListenerToOrigin();

        // iOS suspends/interrupts the context on calls, Siri, lock screen, etc. Resume it.
        audioContext.addEventListener("statechange", () => {
          if (
            localAudioStream &&
            (audioContext.state === "suspended" || audioContext.state === "interrupted")
          ) {
            audioContext.resume().catch(() => {});
          }
        });
      }

      if (audioContext.state !== "running") {
        audioContext.resume();
      }

      // Play one silent sample: fully "unlocks" audio output on older iOS versions.
      const silentBuf = audioContext.createBuffer(1, 1, 22050);
      const src = audioContext.createBufferSource();
      src.buffer = silentBuf;
      src.connect(audioContext.destination);
      src.start(0);
    } catch (err) {
      log("AudioCtx", `تنبيه فك القفل: ${err.message}`);
    }
  }

  /** Roblox yaw (radians; 0 = facing -Z, +π/2 = facing +X) -> unit forward vector on the XZ plane. */
  function yawToForward(yaw) {
    const a = Number.isFinite(yaw) ? yaw : 0;
    return { x: Math.sin(a), y: 0, z: -Math.cos(a) };
  }

  /** Smallest absolute difference between two angles, in radians (0..π). */
  function angleDelta(a, b) {
    let d = (a - b) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  }

  /**
   * Drive an AudioParam toward `value`.
   *  - immediate: jump right now (first placement / teleport), so a voice never
   *    "flies in" from the origin.
   *  - otherwise: exponential glide via setTargetAtTime(). cancelScheduledValues(now)
   *    drops events that haven't started yet (so automation never piles up), while the
   *    glide already in progress keeps its current value — the new glide therefore starts
   *    exactly where the parameter is right now: no clicks, no jumps.
   */
  function setParam(param, value, immediate = false) {
    if (!param || !audioContext || !Number.isFinite(value)) return;
    const now = audioContext.currentTime;
    param.cancelScheduledValues(now);
    if (immediate) {
      param.setValueAtTime(value, now);
    } else {
      param.setTargetAtTime(value, now, SPATIAL_CONFIG.SMOOTHING_TIME_CONSTANT);
    }
  }

  /**
   * Place the AudioListener ("my ears") at my Roblox position, facing my heading.
   * Chrome/Edge/Safari expose positionX/forwardX/... as AudioParams (smoothable);
   * Firefox only has the legacy setPosition()/setOrientation() methods (instant).
   */
  function placeListener(x, y, z, yaw, forceSnap = false) {
    if (!audioContext) return;
    const L = audioContext.listener;
    const f = yawToForward(yaw);

    const prev = lastListenerTarget;
    const snapPosition =
      forceSnap || !prev || Math.hypot(x - prev.x, y - prev.y, z - prev.z) > TELEPORT_SNAP_DISTANCE;
    const snapOrientation =
      snapPosition || angleDelta(yaw, prev.yaw) > LISTENER_YAW_SNAP_RADIANS;
    lastListenerTarget = { x, y, z, yaw };

    if (L.positionX) {
      setParam(L.positionX, x, snapPosition);
      setParam(L.positionY, y, snapPosition);
      setParam(L.positionZ, z, snapPosition);
      // forward = where my nose points, up = top of my head. The browser derives
      // "right" = forward × up, which decides which ear a sound lands in.
      setParam(L.forwardX, f.x, snapOrientation);
      setParam(L.forwardY, 0, snapOrientation);
      setParam(L.forwardZ, f.z, snapOrientation);
      setParam(L.upX, 0, snapOrientation);
      setParam(L.upY, 1, snapOrientation);
      setParam(L.upZ, 0, snapOrientation);
    } else if (typeof L.setPosition === "function") {
      L.setPosition(x, y, z);
      L.setOrientation(f.x, 0, f.z, 0, 1, 0);
    }
  }

  function resetListenerToOrigin() {
    lastListenerTarget = null;
    placeListener(0, 0, 0, 0, true);
    isListenerPlaced = false;
  }

  /** Build a PannerNode configured for human voices measured in Roblox studs. */
  function createSpatialPanner() {
    const panner = audioContext.createPanner();
    panner.panningModel = "HRTF";       // true binaural 3D (best on headphones)
    panner.distanceModel = "inverse";   // natural 1/distance fall-off, like real sound
    panner.refDistance = SPATIAL_CONFIG.REF_DISTANCE;
    panner.rolloffFactor = SPATIAL_CONFIG.ROLLOFF_FACTOR;
    // With "inverse", distances beyond maxDistance are clamped (volume stops dropping);
    // the GainNode after the panner performs the real cut to silence.
    panner.maxDistance = SPATIAL_CONFIG.MAX_HEARING_DISTANCE;

    if (SPATIAL_CONFIG.DIRECTIONAL_VOICE) {
      panner.coneInnerAngle = SPATIAL_CONFIG.CONE_INNER_ANGLE;
      panner.coneOuterAngle = SPATIAL_CONFIG.CONE_OUTER_ANGLE;
      panner.coneOuterGain = SPATIAL_CONFIG.CONE_OUTER_GAIN;
    } else {
      panner.coneInnerAngle = 360; // omnidirectional
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 1;
    }
    return panner;
  }

  /** Place a peer's PannerNode ("their mouth") at their Roblox position, facing their heading. */
  function placePanner(peerInfo, x, y, z, yaw) {
    const panner = peerInfo.pannerNode;
    if (!panner) return;

    const prev = peerInfo.lastTarget;
    const snap = !prev || Math.hypot(x - prev.x, y - prev.y, z - prev.z) > TELEPORT_SNAP_DISTANCE;
    peerInfo.lastTarget = { x, y, z };

    const f = yawToForward(yaw);
    if (panner.positionX) {
      setParam(panner.positionX, x, snap);
      setParam(panner.positionY, y, snap);
      setParam(panner.positionZ, z, snap);
      // Orientation only matters for the sound cone (directional voice). A momentary
      // near-zero vector mid-turn is harmless here: the spec treats a zero orientation
      // as omnidirectional.
      setParam(panner.orientationX, f.x, snap);
      setParam(panner.orientationY, 0, snap);
      setParam(panner.orientationZ, f.z, snap);
    } else if (typeof panner.setPosition === "function") {
      panner.setPosition(x, y, z);
      panner.setOrientation(f.x, 0, f.z);
    }
  }

  function attachSpatialAudioPipeline(peerId, remoteStream) {
    const peerInfo = peers.get(peerId);
    if (!peerInfo) return;

    // Chrome quirk (crbug.com/933677): a remote WebRTC stream fed ONLY into
    // createMediaStreamSource() outputs silence unless the same stream is also attached
    // to a playing <audio>/<video> element. The element is kept MUTED so we don't hear
    // the dry, non-spatial copy on top of the 3D one.
    let audioEl = peerInfo.audioEl;
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.muted = true;
      audioEl.playsInline = true;
      audioEl.setAttribute("playsinline", "");
      remoteAudioContainer.appendChild(audioEl);
      peerInfo.audioEl = audioEl;
    }
    audioEl.srcObject = remoteStream;
    audioEl.play().catch(() => {});

    // No Web Audio support at all -> plain (non-spatial) playback through the element.
    if (!audioContext) {
      audioEl.muted = false;
      return;
    }

    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }

    teardownPeerAudioNodes(peerInfo);

    const sourceNode = audioContext.createMediaStreamSource(remoteStream);
    const pannerNode = createSpatialPanner();

    // Start silent when Roblox data exists: applySpatialLocationsToPeer() fades the voice
    // in only once we know where this peer is (no full-volume blip from a far-away player).
    const hasRobloxData = Object.keys(latestLocations).length > 0;
    const gainNode = audioContext.createGain();
    gainNode.gain.value = hasRobloxData ? 0.0 : 1.0;

    // Voice Activity Detector tap (pre-spatial, UI only)
    const peerAnalyser = audioContext.createAnalyser();
    peerAnalyser.fftSize = 128;
    sourceNode.connect(peerAnalyser);

    // The actual 3D chain: source -> panner -> gain -> speakers
    sourceNode.connect(pannerNode);
    pannerNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    peerInfo.sourceNode = sourceNode;
    peerInfo.pannerNode = pannerNode;
    peerInfo.gainNode = gainNode;
    peerInfo.analyser = peerAnalyser;
    peerInfo.lastTarget = null; // force the first placement to snap, not glide

    applySpatialLocationsToPeer(peerInfo);
    renderDiscordPeersGrid();
  }

  /**
   * Apply the latest Roblox coordinates to ONE remote peer's audio chain.
   * Called for every peer each time a "locations" broadcast arrives (every 0.5s).
   */
  function applySpatialLocationsToPeer(peerInfo) {
    const gainParam = peerInfo.gainNode ? peerInfo.gainNode.gain : null;
    const hasRobloxData = Object.keys(latestLocations).length > 0;

    // (A) Roblox isn't reporting anyone (backend just started / game not running):
    //     fall back to plain voice 1 stud in front of the (origin) listener so testing
    //     without the game still works.
    if (!hasRobloxData) {
      peerInfo.spatialSummary = "وضع عادي (بانتظار روبلوكس)";
      peerInfo.lastTarget = null;
      if (peerInfo.pannerNode) {
        placePanner(peerInfo, 0, 0, -1, 0);
      }
      setParam(gainParam, 1.0);
      return;
    }

    const myUid = myRobloxUserId || latestPinMap[myPin];
    const peerUid = peerInfo.robloxUserId || latestPinMap[peerInfo.pin];

    const myLoc = myUid ? latestLocations[myUid] : null;
    const peerLoc = peerUid ? latestLocations[peerUid] : null;

    let reason = null;
    if (!myLoc) reason = "PIN الخاص بك غير موجود باللعبة";
    else if (!peerUid) reason = "اللاعب لم يُدخل PIN";
    else if (peerUid === myUid) reason = "نفس حسابك (تبويب آخر)";
    else if (!peerLoc) reason = "ليس داخل اللعبة حالياً";
    else if (myLoc.jobId && peerLoc.jobId && myLoc.jobId !== peerLoc.jobId) reason = "في سيرفر روبلوكس آخر";

    if (reason) {
      peerInfo.spatialSummary = reason;
      peerInfo.lastTarget = null; // snap when they become placeable again
      setParam(gainParam, 0.0);
      return;
    }

    if (peerLoc.username && peerInfo.username !== peerLoc.username) {
      peerInfo.username = peerLoc.username;
    }

    // (C) THE 3D PART: hand the PannerNode the peer's raw world position + heading.
    //     The audio thread computes distance / azimuth / elevation relative to the
    //     AudioListener (which handleLocationsBroadcast() already moved to MY position).
    placePanner(peerInfo, peerLoc.x, peerLoc.y, peerLoc.z, peerLoc.yaw);

    // (D) Hard hearing limit on top of the PannerNode's inverse-distance attenuation:
    //     1.0 up to FADE_START, linear fade to 0.0 at MAX_HEARING_DISTANCE.
    const dx = peerLoc.x - myLoc.x;
    const dy = peerLoc.y - myLoc.y;
    const dz = peerLoc.z - myLoc.z;
    const distance = Math.hypot(dx, dy, dz);

    let cutoffGain = 1.0;
    if (distance >= SPATIAL_CONFIG.MAX_HEARING_DISTANCE) {
      cutoffGain = 0.0;
    } else if (distance > SPATIAL_CONFIG.FADE_START_DISTANCE) {
      cutoffGain =
        1.0 -
        (distance - SPATIAL_CONFIG.FADE_START_DISTANCE) /
          (SPATIAL_CONFIG.MAX_HEARING_DISTANCE - SPATIAL_CONFIG.FADE_START_DISTANCE);
    }
    setParam(gainParam, cutoffGain);

    // (E) Human-readable direction for the UI ONLY — the audio doesn't use this.
    //     Project the offset onto my forward and right vectors (right = forward × up).
    const f = yawToForward(myLoc.yaw);
    const ahead = dx * f.x + dz * f.z;
    const side = dx * -f.z + dz * f.x;
    const angleDeg = Math.round((Math.atan2(side, ahead) * 180) / Math.PI); // 0 = ahead, +90 = right

    if (distance >= SPATIAL_CONFIG.MAX_HEARING_DISTANCE) {
      peerInfo.spatialSummary = `${distance.toFixed(1)} studs • خارج السمع`;
    } else {
      const dirText =
        Math.abs(angleDeg) <= 20
          ? "أمامك"
          : Math.abs(angleDeg) >= 160
          ? "خلفك"
          : angleDeg > 0
          ? `${angleDeg}° يمين`
          : `${Math.abs(angleDeg)}° يسار`;
      peerInfo.spatialSummary = `${distance.toFixed(1)} studs • ${dirText}`;
    }
  }

  /**
   * Handle a "locations" WebSocket message (every 0.5s):
   *   locationsMap: { [robloxUserId]: { x, y, z, yaw, username, jobId } }
   *   peerMap:      { [webrtcPeerId]: robloxUserId }
   */
  function handleLocationsBroadcast(locationsMap, pinMap, peerMap) {
    latestLocations = locationsMap || {};
    latestPinMap = pinMap || {};

    // Auto-resolve my Roblox UserId from myPin!
    if (myPin && latestPinMap[myPin]) {
      myRobloxUserId = String(latestPinMap[myPin]);
    }

    if (peerMap) {
      for (const [pid, uid] of Object.entries(peerMap)) {
        const info = peers.get(pid);
        if (info && uid) info.robloxUserId = String(uid);
      }
    }

    if (pinMap) {
      for (const info of peers.values()) {
        if (info.pin && !info.robloxUserId && pinMap[info.pin]) {
          info.robloxUserId = String(pinMap[info.pin]);
        }
      }
    }

    const hasRobloxData = Object.keys(latestLocations).length > 0;
    const myUid = myRobloxUserId || latestPinMap[myPin];
    const myLoc = myUid ? latestLocations[myUid] : null;

    if (myLoc) {
      placeListener(myLoc.x, myLoc.y, myLoc.z, myLoc.yaw, !isListenerPlaced);
      isListenerPlaced = true;

      if (myLoc.username) myUsername = myLoc.username;
      spatialStatusVal.textContent = `متزامن (${Math.round(myLoc.x)}, ${Math.round(myLoc.y)}, ${Math.round(myLoc.z)})`;
      spatialStatusVal.className = "pill-value mono ok";
    } else {
      isListenerPlaced = false;
      if (!hasRobloxData) {
        const t = lastListenerTarget;
        const atOrigin = t && t.x === 0 && t.y === 0 && t.z === 0 && t.yaw === 0;
        if (!atOrigin) resetListenerToOrigin();
        spatialStatusVal.textContent = "بانتظار اللعبة";
        spatialStatusVal.className = "pill-value mono";
      } else {
        spatialStatusVal.textContent = "PIN غير موجود باللعبة";
        spatialStatusVal.className = "pill-value mono warn";
      }
    }

    for (const peerInfo of peers.values()) {
      applySpatialLocationsToPeer(peerInfo);
    }
    renderDiscordPeersGrid();
  }

  function teardownPeerAudioNodes(peerInfo) {
    try { peerInfo.sourceNode?.disconnect(); } catch (_) {}
    try { peerInfo.pannerNode?.disconnect(); } catch (_) {}
    try { peerInfo.gainNode?.disconnect(); } catch (_) {}
    try { peerInfo.analyser?.disconnect(); } catch (_) {}
    peerInfo.sourceNode = null;
    peerInfo.pannerNode = null;
    peerInfo.gainNode = null;
    peerInfo.analyser = null;
    peerInfo.lastTarget = null;
  }

  // ---------------------------------------------------------------------------
  // كاشف التحدث الصوتي للمايك المحلي (VAD)
  // ---------------------------------------------------------------------------
  function startMicActivityDetector(audioStream) {
    if (!audioStream) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!audioContext && AudioCtx) {
        audioContext = new AudioCtx({ latencyHint: "interactive" });
      }
      if (audioContext && audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }

      const source = audioContext.createMediaStreamSource(audioStream);
      localAnalyser = audioContext.createAnalyser();
      localAnalyser.fftSize = 512;
      localAnalyser.smoothingTimeConstant = 0.25;
      source.connect(localAnalyser);

      // Force Web Audio engine to keep processing audio in Safari/Chrome background
      try {
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0.0;
        localAnalyser.connect(silentGain);
        silentGain.connect(audioContext.destination);
      } catch (_) {}

      const timeData = new Uint8Array(localAnalyser.fftSize);
      const peerDataArray = new Uint8Array(64);

      if (meterRafId) {
        cancelAnimationFrame(meterRafId);
        meterRafId = null;
      }

      const updateVAD = () => {
        // ALWAYS schedule the next frame first so loop NEVER dies
        meterRafId = requestAnimationFrame(updateVAD);

        if (!localAudioStream || isMicMuted) {
          if (micMeterBar) micMeterBar.style.width = "0%";
          isSelfSpeaking = false;
        } else {
          localAnalyser.getByteTimeDomainData(timeData);
          let sumSq = 0;
          for (let i = 0; i < timeData.length; i++) {
            const norm = (timeData[i] - 128) / 128;
            sumSq += norm * norm;
          }
          const rms = Math.sqrt(sumSq / timeData.length);
          // High-responsiveness RMS formula (0-100%)
          micLevelPct = Math.min(100, Math.round(rms * 500));
          if (micMeterBar) {
            micMeterBar.style.width = `${micLevelPct}%`;
          }
          isSelfSpeaking = micLevelPct > 6;
        }

        // كشف التحدث للأقران
        for (const peerInfo of peers.values()) {
          if (peerInfo.analyser) {
            peerInfo.analyser.getByteFrequencyData(peerDataArray);
            let peerSum = 0;
            for (let i = 0; i < peerDataArray.length; i++) peerSum += peerDataArray[i];
            peerInfo.isSpeaking = peerSum / peerDataArray.length > 8;
          }
        }

        renderDiscordPeersGrid();
      };

      meterRafId = requestAnimationFrame(updateVAD);
    } catch (err) {
      log("VAD", "خطأ في تهيئة محلل الصوت: " + err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // تشغيل نافذة ديسكورد عبر Picture-in-Picture
  // ---------------------------------------------------------------------------
  async function enterPictureInPicture(videoEl) {
    if (typeof videoEl.requestPictureInPicture === "function") {
      await videoEl.requestPictureInPicture();
      return true;
    }
    if (
      typeof videoEl.webkitSupportsPresentationMode === "function" &&
      videoEl.webkitSupportsPresentationMode("picture-in-picture") &&
      typeof videoEl.webkitSetPresentationMode === "function"
    ) {
      videoEl.webkitSetPresentationMode("picture-in-picture");
      return true;
    }
    throw new Error("PIP_NOT_SUPPORTED");
  }

  async function startDiscordOverlayAndConnect() {
    clearAlert();

    const cleanedPin = pinInput.value.replace(/\D/g, "").trim();
    if (cleanedPin.length !== 4) {
      showAlert("يرجى إدخال رمز الـ PIN المكون من 4 أرقام والظاهر في لعبة روبلوكس!", true);
      pinInput.focus();
      return;
    }
    myPin = cleanedPin;
    pinInput.value = cleanedPin;

    try {
      localStorage.setItem("rbx_aura_pin", cleanedPin);
    } catch (_) {}

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showAlert(
        "يتطلب تشغيل المايك ونافذة PiP رابط آمن HTTPS (أو localhost).",
        true
      );
      return;
    }

    initAndUnlockSpatialAudioContextSync();

    if (awaitingSecondTapForPiP && combinedPipStream) {
      try {
        connectBtn.disabled = true;
        await enterPictureInPicture(pipVideo);
        awaitingSecondTapForPiP = false;
        updatePipUiState(true);
        onPipReadyEstablishWebRTC();
      } catch (err) {
        connectBtn.disabled = false;
        handlePipFailure(err);
      }
      return;
    }

    connectBtn.disabled = true;
    connectBtnText.textContent = "جارٍ تشغيل نافذة ديسكورد المنبثقة...";

    try {
      // (a) طلب إذن المايك
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localAudioStream = audioStream;

      const primaryAudioTrack = audioStream.getAudioTracks()[0];
      if (primaryAudioTrack) {
        micStateText.textContent = "نشط";
        primaryAudioTrack.addEventListener("mute", () => {
          micStateText.textContent = "مكتوم من النظام";
        });
        primaryAudioTrack.addEventListener("unmute", () => {
          micStateText.textContent = isMicMuted ? "مكتوم" : "نشط";
        });
      }

      startMicActivityDetector(audioStream);

      // (b) بدء محرك رسم نافذة ديسكورد الحية
      startFloatingDiscordOverlayLoop();
      renderFloatingDiscordOverlay();

      // (c) التقاط دفق فيديو بدقة ديسكورد بمعدل 14 إطار بالثانية
      const videoStream = pipCanvas.captureStream(14);
      canvasVideoStream = videoStream;

      // (d) دمج دفق فيديو ديسكورد مع مسار المايك
      const combinedStream = new MediaStream([
        ...videoStream.getTracks(),
        ...audioStream.getTracks(),
      ]);
      combinedPipStream = combinedStream;

      pipVideo.srcObject = combinedStream;
      pipVideo.muted = true; // صامت لمنع ارتداد صدى صوتك في سماعاتك

      if (pipVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise((resolve) => {
          pipVideo.addEventListener("loadedmetadata", resolve, { once: true });
        });
      }
      await pipVideo.play();

      // (e) إطلاق نافذة Picture-in-Picture العائمة
      await enterPictureInPicture(pipVideo);
      updatePipUiState(true);
      log("PiP", "تم إطلاق نافذة ديسكورد العائمة (Overlay) بنجاح!");

      onPipReadyEstablishWebRTC();
    } catch (err) {
      connectBtn.disabled = false;
      handlePipFailure(err);
    }
  }

  function handlePipFailure(err) {
    const errName = err?.name || "";
    const errMsg = err?.message || String(err);
    log("Warn", `تنبيه PiP (${errName}): ${errMsg}`);

    if (!localAudioStream) {
      connectBtnText.textContent = "تشغيل نافذة الديسكورد العائمة (PiP Overlay)";
      showAlert("تم رفض إذن المايك! يرجى السماح بالوصول للمايك من إعدادات المتصفح.", true);
      return;
    }

    if (errName === "NotAllowedError" || errName === "InvalidAccessError") {
      awaitingSecondTapForPiP = true;
      connectBtnText.textContent = "اضغط مرة ثانية لفتح نافذة ديسكورد العائمة";
      showAlert("تم تجهيز المايك! نظام iOS يتطلب ضغطة ثانية لفتح نافذة PiP المنبثقة.");
      return;
    }

    if (errMsg === "PIP_NOT_SUPPORTED" || errName === "NotSupportedError") {
      connectBtnText.textContent = "تشغيل نافذة الديسكورد العائمة (PiP Overlay)";
      showAlert("خاصية PiP غير مدعومة في هذا المتصفح. على الآيفون استخدم متصفح Safari الرسمي.");
      fallbackForegroundBtn.classList.remove("hidden");
      return;
    }

    connectBtnText.textContent = "تشغيل نافذة الديسكورد العائمة (PiP Overlay)";
    showAlert(`خطأ في الإعداد: ${errMsg}`, true);
  }

  function onPipReadyEstablishWebRTC() {
    clearAlert();
    fallbackForegroundBtn.classList.add("hidden");
    identityGroup.classList.add("hidden");
    connectBtn.classList.add("connected");
    connectBtn.disabled = true;
    connectBtnText.textContent = `متصل في مكالمة Aura (PIN: ${myPin})`;
    sessionControls.classList.remove("hidden");

    connectSignalingServer();
  }

  pipVideo.addEventListener("enterpictureinpicture", () => updatePipUiState(true));
  pipVideo.addEventListener("leavepictureinpicture", () => updatePipUiState(false));
  pipVideo.addEventListener("webkitpresentationmodechanged", () => {
    updatePipUiState(pipVideo.webkitPresentationMode === "picture-in-picture");
  });

  document.addEventListener("visibilitychange", () => {
    if (combinedPipStream && pipVideo.paused) {
      pipVideo.play().catch(() => {});
    }
    if (audioContext && audioContext.state !== "running" && localAudioStream) {
      audioContext.resume().catch(() => {});
    }
    for (const info of peers.values()) {
      if (info.audioEl && info.audioEl.paused) {
        info.audioEl.play().catch(() => {});
      }
    }
  });

  // ---------------------------------------------------------------------------
  // خادم الـ WebSocket وتداول إشارات WebRTC
  // ---------------------------------------------------------------------------
  function connectSignalingServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    isIntentionalDisconnect = false;
    const url = buildSignalingUrl(myPin);
    log("WS", `جارٍ الاتصال برمز PIN=${myPin}...`);
    wsStatusVal.textContent = "جارٍ الاتصال";
    wsStatusVal.className = "pill-value warn";

    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      log("WS", "تم الاتصال بسيرفر الصوت.");
      wsStatusVal.textContent = "متصل";
      wsStatusVal.className = "pill-value ok";
      updateGlobalStatus(
        isPipActive ? "نافذة ديسكورد عائمة فوق روبلوكس" : "المكالمة متصلة (بدون نافذة)",
        isPipActive ? "online" : "warning"
      );

      clearInterval(wsHeartbeatInterval);
      wsHeartbeatInterval = setInterval(() => sendSignal({ type: "ping" }), 25000);
    });

    ws.addEventListener("message", async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      await handleSignalingMessage(msg);
    });

    ws.addEventListener("close", () => {
      clearInterval(wsHeartbeatInterval);
      wsStatusVal.textContent = "غير متصل";
      wsStatusVal.className = "pill-value warn";

      if (!isIntentionalDisconnect && localAudioStream) {
        setTimeout(() => {
          if (!isIntentionalDisconnect && localAudioStream) {
            cleanupAllPeers();
            connectSignalingServer();
          }
        }, 2500);
      }
    });
  }

  function sendSignal(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case "pong":
        return;

      case "locations": {
        handleLocationsBroadcast(msg.locations, msg.pinMap, msg.peerMap);
        return;
      }

      case "welcome": {
        myPeerId = msg.peerId;
        log("Room", `تم الانضمام برمز PIN: ${myPin} (المعرف: ${myPeerId}). المتواجدون: ${msg.peers.length}`);

        for (const remotePeer of msg.peers) {
          registerPeer(remotePeer.peerId, remotePeer.pin, remotePeer.robloxUserId, remotePeer.username);
          await initiateOfferToPeer(remotePeer.peerId);
        }
        renderDiscordPeersGrid();
        break;
      }

      case "peer-joined": {
        log("Room", `انضم لاعب: ${msg.username} (PIN: ${msg.pin})`);
        registerPeer(msg.peerId, msg.pin, msg.robloxUserId, msg.username);
        renderDiscordPeersGrid();
        break;
      }

      case "peer-left": {
        removePeer(msg.peerId);
        renderDiscordPeersGrid();
        break;
      }

      case "offer": {
        await handleIncomingOffer(msg.sender, msg.pin, msg.robloxUserId, msg.username, msg.sdp);
        break;
      }

      case "answer": {
        await handleIncomingAnswer(msg.sender, msg.sdp);
        break;
      }

      case "ice-candidate": {
        await handleIncomingIceCandidate(msg.sender, msg.candidate);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // إدارة اتصالات WebRTC Peer-to-Peer
  // ---------------------------------------------------------------------------
  function registerPeer(peerId, pin, robloxUserId, username) {
    if (!peers.has(peerId)) {
      peers.set(peerId, {
        pin: pin || "",
        robloxUserId: robloxUserId || "",
        username: username || (pin ? `لاعب ${pin}` : `لاعب_${peerId.slice(0, 4)}`),
        pc: null,
        iceQueue: [],
        audioEl: null,
        sourceNode: null,
        pannerNode: null,
        gainNode: null,
        analyser: null,
        isSpeaking: false,
        state: "connecting",
        spatialSummary: "بانتظار روبلوكس...",
      });
    } else {
      const existing = peers.get(peerId);
      if (pin) existing.pin = pin;
      if (robloxUserId) existing.robloxUserId = robloxUserId;
      if (username) existing.username = username;
    }
    return peers.get(peerId);
  }

  function getOrCreatePeerConnection(peerId, pin, robloxUserId, username) {
    const peerInfo = registerPeer(peerId, pin, robloxUserId, username);
    if (peerInfo.pc) return peerInfo.pc;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerInfo.pc = pc;

    if (localAudioStream) {
      for (const audioTrack of localAudioStream.getAudioTracks()) {
        pc.addTrack(audioTrack, localAudioStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: "ice-candidate",
          target: peerId,
          candidate: event.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      peerInfo.state = pc.connectionState;
      renderDiscordPeersGrid();
    };

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      const streamToSpatialize = remoteStream || new MediaStream([event.track]);
      attachSpatialAudioPipeline(peerId, streamToSpatialize);
    };

    return pc;
  }

  async function initiateOfferToPeer(peerId) {
    try {
      const pc = getOrCreatePeerConnection(peerId);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      sendSignal({ type: "offer", target: peerId, sdp: pc.localDescription });
    } catch (err) {
      log("WebRTC", `فشل إرسال Offer (${peerId}): ${err.message}`);
    }
  }

  async function handleIncomingOffer(senderId, senderPin, senderUserId, senderUsername, sdp) {
    try {
      const peerInfo = registerPeer(senderId, senderPin, senderUserId, senderUsername);
      const pc = getOrCreatePeerConnection(senderId, senderPin, senderUserId, senderUsername);

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushQueuedIceCandidates(peerInfo);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: "answer", target: senderId, sdp: pc.localDescription });
      renderDiscordPeersGrid();
    } catch (err) {
      log("WebRTC", `خطأ استلام Offer (${senderId}): ${err.message}`);
    }
  }

  async function handleIncomingAnswer(senderId, sdp) {
    try {
      const peerInfo = peers.get(senderId);
      if (!peerInfo || !peerInfo.pc) return;
      await peerInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushQueuedIceCandidates(peerInfo);
    } catch (err) {
      log("WebRTC", `خطأ استلام Answer (${senderId}): ${err.message}`);
    }
  }

  async function handleIncomingIceCandidate(senderId, candidateInit) {
    if (!candidateInit) return;
    const peerInfo = registerPeer(senderId);
    if (!peerInfo.pc || !peerInfo.pc.remoteDescription) {
      peerInfo.iceQueue.push(candidateInit);
      return;
    }
    try {
      await peerInfo.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
    } catch (_) {}
  }

  async function flushQueuedIceCandidates(peerInfo) {
    if (!peerInfo.pc || !peerInfo.pc.remoteDescription) return;
    while (peerInfo.iceQueue.length > 0) {
      const candidateInit = peerInfo.iceQueue.shift();
      try {
        await peerInfo.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch (_) {}
    }
  }

  function removePeer(peerId) {
    const peerInfo = peers.get(peerId);
    if (!peerInfo) return;

    teardownPeerAudioNodes(peerInfo);

    if (peerInfo.pc) {
      try {
        peerInfo.pc.ontrack = null;
        peerInfo.pc.onicecandidate = null;
        peerInfo.pc.close();
      } catch (_) {}
    }

    if (peerInfo.audioEl) {
      peerInfo.audioEl.srcObject = null;
      peerInfo.audioEl.remove();
    }

    peers.delete(peerId);
  }

  function cleanupAllPeers() {
    for (const peerId of Array.from(peers.keys())) {
      removePeer(peerId);
    }
    renderDiscordPeersGrid();
  }

  // ---------------------------------------------------------------------------
  // أزرار التحكم
  // ---------------------------------------------------------------------------
  function toggleMute() {
    if (!localAudioStream) return;
    isMicMuted = !isMicMuted;
    for (const track of localAudioStream.getAudioTracks()) {
      track.enabled = !isMicMuted;
    }
    muteBtn.classList.toggle("muted-active", isMicMuted);
    muteBtnText.textContent = isMicMuted ? "إلغاء كتم المايك" : "كتم المايك";
    micStateText.textContent = isMicMuted ? "مكتوم" : "نشط";
    renderFloatingDiscordOverlay();
    renderDiscordPeersGrid();
  }

  async function reopenPipWindow() {
    if (!combinedPipStream) return;
    try {
      if (pipVideo.paused) await pipVideo.play();
      await enterPictureInPicture(pipVideo);
      updatePipUiState(true);
    } catch (err) {
      showAlert(`تعذر فتح نافذة ديسكورد: ${err.message}`, true);
    }
  }

  async function disconnectSession() {
    isIntentionalDisconnect = true;
    awaitingSecondTapForPiP = false;
    isMicMuted = false;
    latestLocations = {};
    
    clearInterval(wsHeartbeatInterval);
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    cleanupAllPeers();

    stopFloatingDiscordOverlayLoop();

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (
        typeof pipVideo.webkitSetPresentationMode === "function" &&
        pipVideo.webkitPresentationMode === "picture-in-picture"
      ) {
        pipVideo.webkitSetPresentationMode("inline");
      }
    } catch (_) {}

    cancelAnimationFrame(meterRafId);

    canvasVideoStream?.getTracks().forEach((t) => t.stop());
    localAudioStream?.getTracks().forEach((t) => t.stop());
    canvasVideoStream = null;
    localAudioStream = null;
    combinedPipStream = null;
    pipVideo.srcObject = null;

    myPeerId = null;
    wsStatusVal.textContent = "غير متصل";
    wsStatusVal.className = "pill-value";
    spatialStatusVal.textContent = "بانتظار الـ PIN";
    spatialStatusVal.className = "pill-value mono";
    micStateText.textContent = "غير نشط";
    micMeterBar.style.width = "0%";
    muteBtn.classList.remove("muted-active");
    muteBtnText.textContent = "كتم المايك";
    updatePipUiState(false);
    updateGlobalStatus("جاهز للربط عبر PIN", "");

    sessionControls.classList.add("hidden");
    fallbackForegroundBtn.classList.add("hidden");
    identityGroup.classList.remove("hidden");
    connectBtn.classList.remove("connected");
    connectBtn.disabled = false;
    connectBtnText.textContent = "تشغيل نافذة الديسكورد العائمة (PiP Overlay)";
    clearAlert();
    renderDiscordPeersGrid();
  }

  connectBtn.addEventListener("click", startDiscordOverlayAndConnect);
  fallbackForegroundBtn.addEventListener("click", onPipReadyEstablishWebRTC);
  muteBtn.addEventListener("click", toggleMute);
  reopenPipBtn.addEventListener("click", reopenPipWindow);
  disconnectBtn.addEventListener("click", disconnectSession);
})();

// Ensure AudioContext is always resumed on any touch/click
window.addEventListener("click", () => {
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
}, { passive: true });
window.addEventListener("touchstart", () => {
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
}, { passive: true });
