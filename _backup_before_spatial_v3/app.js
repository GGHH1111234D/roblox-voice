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
  // إعدادات الصوت والـ WebRTC
  // ---------------------------------------------------------------------------
  const SPATIAL_CONFIG = {
    REF_DISTANCE: 6,           // صوت كامل 100% ضمن مسافة 6 حبات أو أقل
    FADE_START_DISTANCE: 55,   // يبدأ التلاشي بعد 55 حبة
    MAX_HEARING_DISTANCE: 80,  // انقطاع تام للصوت بعد 80 حبة
    ROLLOFF_FACTOR: 1.2,       // سرعة انخفاض الصوت مع المسافة
    RAMP_SECONDS: 0.45,        // تنعيم تغير الموقع لتفادي التقطيع الصوتي
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
  let myPin = "";
  let myRobloxUserId = "";
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

  let latestLocations = {}; // { [userId]: { pin, username, x, y, z, yaw } }
  let latestPinMap = {};    // { [pin]: userId }

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

  // ---------------------------------------------------------------------------
  // محرك الصوت ثلاثي الأبعاد Web Audio API (HRTF 3D Panner)
  // ---------------------------------------------------------------------------
  function initAndUnlockSpatialAudioContextSync() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!audioContext) {
        audioContext = new AudioCtx({ latencyHint: "interactive" });

        const listener = audioContext.listener;
        if (listener.positionX) {
          const now = audioContext.currentTime;
          listener.positionX.setValueAtTime(0, now);
          listener.positionY.setValueAtTime(0, now);
          listener.positionZ.setValueAtTime(0, now);
          listener.forwardX.setValueAtTime(0, now);
          listener.forwardY.setValueAtTime(0, now);
          listener.forwardZ.setValueAtTime(-1, now);
          listener.upX.setValueAtTime(0, now);
          listener.upY.setValueAtTime(1, now);
          listener.upZ.setValueAtTime(0, now);
        } else if (typeof listener.setPosition === "function") {
          listener.setPosition(0, 0, 0);
          listener.setOrientation(0, 0, -1, 0, 1, 0);
        }

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

      const silentBuf = audioContext.createBuffer(1, 1, 22050);
      const src = audioContext.createBufferSource();
      src.buffer = silentBuf;
      src.connect(audioContext.destination);
      src.start(0);
    } catch (err) {
      log("AudioCtx", `تنبيه فك القفل: ${err.message}`);
    }
  }

  function attachSpatialAudioPipeline(peerId, remoteStream) {
    const peerInfo = peers.get(peerId);
    if (!peerInfo) return;

    let audioEl = peerInfo.audioEl;
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.muted = true; // صامت لمنع تشغيل الصوت الجاف
      audioEl.playsInline = true;
      audioEl.setAttribute("playsinline", "");
      remoteAudioContainer.appendChild(audioEl);
      peerInfo.audioEl = audioEl;
    }
    audioEl.srcObject = remoteStream;
    audioEl.play().catch(() => {});

    if (!audioContext) {
      audioEl.muted = false;
      return;
    }

    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }

    teardownPeerAudioNodes(peerInfo);

    const sourceNode = audioContext.createMediaStreamSource(remoteStream);
    const pannerNode = audioContext.createPanner();
    pannerNode.panningModel = "HRTF";
    pannerNode.distanceModel = "inverse";
    pannerNode.refDistance = SPATIAL_CONFIG.REF_DISTANCE;
    pannerNode.maxDistance = SPATIAL_CONFIG.MAX_HEARING_DISTANCE;
    pannerNode.rolloffFactor = SPATIAL_CONFIG.ROLLOFF_FACTOR;
    pannerNode.coneInnerAngle = 360;

    setPannerPositionSmooth(pannerNode, 0, 0, -2, true);

    const gainNode = audioContext.createGain();
    gainNode.gain.value = 1.0;

    // كاشف التحدث الصوتي (Voice Activity Detector) للصديق
    const peerAnalyser = audioContext.createAnalyser();
    peerAnalyser.fftSize = 128;
    sourceNode.connect(peerAnalyser);

    sourceNode.connect(pannerNode);
    pannerNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    peerInfo.sourceNode = sourceNode;
    peerInfo.pannerNode = pannerNode;
    peerInfo.gainNode = gainNode;
    peerInfo.analyser = peerAnalyser;

    applySpatialLocationsToPeer(peerInfo);
    renderDiscordPeersGrid();
  }

  function setPannerPositionSmooth(pannerNode, x, y, z, immediate = false) {
    if (!audioContext || !pannerNode) return;
    const now = audioContext.currentTime;

    if (pannerNode.positionX) {
      if (immediate) {
        pannerNode.positionX.setValueAtTime(x, now);
        pannerNode.positionY.setValueAtTime(y, now);
        pannerNode.positionZ.setValueAtTime(z, now);
      } else {
        const targetTime = now + SPATIAL_CONFIG.RAMP_SECONDS;
        pannerNode.positionX.linearRampToValueAtTime(x, targetTime);
        pannerNode.positionY.linearRampToValueAtTime(y, targetTime);
        pannerNode.positionZ.linearRampToValueAtTime(z, targetTime);
      }
    } else if (typeof pannerNode.setPosition === "function") {
      pannerNode.setPosition(x, y, z);
    }
  }

  function setGainSmooth(gainNode, targetGain) {
    if (!audioContext || !gainNode) return;
    const now = audioContext.currentTime;
    gainNode.gain.linearRampToValueAtTime(targetGain, now + SPATIAL_CONFIG.RAMP_SECONDS);
  }

  function applySpatialLocationsToPeer(peerInfo) {
    const hasRobloxData = Object.keys(latestLocations).length > 0;

    if (!hasRobloxData) {
      peerInfo.spatialSummary = "وضع عادي (بانتظار روبلوكس)";
      if (peerInfo.pannerNode && peerInfo.gainNode) {
        setPannerPositionSmooth(peerInfo.pannerNode, 0, 0, -2);
        setGainSmooth(peerInfo.gainNode, 1.0);
      }
      return;
    }

    const myUid = myRobloxUserId || latestPinMap[myPin];
    const peerUid = peerInfo.robloxUserId || latestPinMap[peerInfo.pin];

    const myLoc = myUid ? latestLocations[myUid] : null;
    const peerLoc = peerUid ? latestLocations[peerUid] : null;

    if (!myLoc || !peerLoc) {
      peerInfo.spatialSummary = !myLoc
        ? "PIN غير مرصود باللعبة"
        : "اللاعب لم يظهر في اللعبة";
      if (peerInfo.gainNode) {
        setGainSmooth(peerInfo.gainNode, 0.0);
      }
      return;
    }

    if (peerLoc.username && peerInfo.username !== peerLoc.username) {
      peerInfo.username = peerLoc.username;
    }

    const dx = peerLoc.x - myLoc.x;
    const dy = peerLoc.y - myLoc.y;
    const dz = peerLoc.z - myLoc.z;
    const distance = Math.hypot(dx, dy, dz);

    const yaw = typeof myLoc.yaw === "number" ? myLoc.yaw : 0;
    const fx = Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const relX = dx * -fz + dz * fx;
    const relY = dy;
    const relZ = -(dx * fx + dz * fz);

    const angleDeg = Math.round((Math.atan2(relX, -relZ) * 180) / Math.PI);

    let cutoffGain = 1.0;
    if (distance >= SPATIAL_CONFIG.MAX_HEARING_DISTANCE) {
      cutoffGain = 0.0;
    } else if (distance > SPATIAL_CONFIG.FADE_START_DISTANCE) {
      cutoffGain =
        1.0 -
        (distance - SPATIAL_CONFIG.FADE_START_DISTANCE) /
          (SPATIAL_CONFIG.MAX_HEARING_DISTANCE - SPATIAL_CONFIG.FADE_START_DISTANCE);
    }

    if (peerInfo.pannerNode) {
      setPannerPositionSmooth(peerInfo.pannerNode, relX, relY, relZ);
    }
    if (peerInfo.gainNode) {
      setGainSmooth(peerInfo.gainNode, cutoffGain);
    }

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

  function handleLocationsBroadcast(locationsMap, pinMap) {
    latestLocations = locationsMap || {};
    latestPinMap = pinMap || {};

    const myUid = myRobloxUserId || latestPinMap[myPin];
    const myLoc = myUid ? latestLocations[myUid] : null;

    if (myLoc) {
      myRobloxUserId = myUid;
      if (myLoc.username) myUsername = myLoc.username;
      spatialStatusVal.textContent = `متزامن (${Math.round(myLoc.x)}, ${Math.round(myLoc.z)})`;
      spatialStatusVal.className = "pill-value mono ok";
    } else if (Object.keys(latestLocations).length > 0) {
      spatialStatusVal.textContent = "PIN غير موجود باللعبة";
      spatialStatusVal.className = "pill-value mono warn";
    } else {
      spatialStatusVal.textContent = "بانتظار اللعبة";
      spatialStatusVal.className = "pill-value mono";
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
  }

  // ---------------------------------------------------------------------------
  // كاشف التحدث الصوتي للمايك المحلي (VAD)
  // ---------------------------------------------------------------------------
  function startMicActivityDetector(audioStream) {
    if (!audioContext) return;
    try {
      const source = audioContext.createMediaStreamSource(audioStream);
      localAnalyser = audioContext.createAnalyser();
      localAnalyser.fftSize = 256;
      source.connect(localAnalyser);

      const dataArray = new Uint8Array(localAnalyser.frequencyBinCount);
      const peerDataArray = new Uint8Array(64);

      const updateVAD = () => {
        if (!localAudioStream) {
          micMeterBar.style.width = "0%";
          isSelfSpeaking = false;
          return;
        }

        if (isMicMuted) {
          micMeterBar.style.width = "0%";
          isSelfSpeaking = false;
        } else {
          localAnalyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          micLevelPct = Math.min(100, Math.round((avg / 90) * 100));
          micMeterBar.style.width = `${micLevelPct}%`;
          isSelfSpeaking = micLevelPct > 10;
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
        meterRafId = requestAnimationFrame(updateVAD);
      };
      meterRafId = requestAnimationFrame(updateVAD);
    } catch (_) {}
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
    log("WS", `جارٍ الاتصال بالـ PIN=${myPin}...`);
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
        handleLocationsBroadcast(msg.locations, msg.pinMap);
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
    latestPinMap = {};

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
