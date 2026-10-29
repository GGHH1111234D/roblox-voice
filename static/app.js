/**
 * Roblox Aura Voice — Clean 3D WebRTC Engine + Minimalist Black Box PiP
 * =====================================================================
 * 1. صوت مكاني 3D حقيقي عبر Web Audio API (HRTF Panner) بمقاييس روبلوكس (Studs).
 * 2. نافذة PiP مصغرة فائقة الخفة (مربع أسود خالص 160x160) لضمان استمرار المايك بالخلفية بدون استهلاك بطارية أو معالج.
 * 3. المظاهر والشاشات والفقاعات التفاعلية تظل بالكامل داخل روبلوكس فقط (Overhead Bubbles & Topbar).
 * 4. مزامنة الكتم الثنائية (Bidirectional Mute Sync): الكتم داخل روبلوكس يكتم الموقع، والعكس صحيح.
 * 5. نظام الكتم والحظر المتطور:
 *    - كتم (Mute): أنت لا تسمعه، ولكنه يسمعك.
 *    - حظر (Block): حظر متبادل كامل (لا يسمعك ولا تسمعه).
 * 6. اختيار المايك والتبديل المباشر بين أجهزة الصوت + التحكم بالحساسية.
 * 7. نظام حسابات متكامل لحفظ المايك المفضل وقوائم الحظر والكتم سحابياً.
 * 8. إنهاء المكالمة تلقائياً عند مغادرة ماب روبلوكس.
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // 3D Audio Tuning (Roblox STUDS -> Web Audio API)
  // ---------------------------------------------------------------------------
  const SPATIAL_CONFIG = {
    REF_DISTANCE: 6,
    ROLLOFF_FACTOR: 1.2,
    FADE_START_DISTANCE: 55,
    MAX_HEARING_DISTANCE: 80,
    SMOOTHING_TIME_CONSTANT: 0.15,
    DIRECTIONAL_VOICE: true,
    CONE_INNER_ANGLE: 140,
    CONE_OUTER_ANGLE: 320,
    CONE_OUTER_GAIN: 0.45,
  };

  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ],
  };

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
  const micSelect = document.getElementById("mic-select");
  const settingsMicSelect = document.getElementById("settings-mic-select");

  const alertBanner = document.getElementById("alert-banner");
  const globalStatusDot = document.getElementById("global-status-dot");
  const pipStatusVal = document.getElementById("pip-status-val");
  const wsStatusVal = document.getElementById("ws-status-val");
  const spatialStatusVal = document.getElementById("spatial-status-val");
  const micStateText = document.getElementById("mic-state-text");
  const micMeterBar = document.getElementById("mic-meter-bar");
  const debugLogEl = document.getElementById("debug-log");

  // Navigation & Modals Elements
  const openPlayersBtn = document.getElementById("open-players-btn");
  const openSettingsBtn = document.getElementById("open-settings-btn");
  const openAccountBtn = document.getElementById("open-account-btn");
  const accountPillText = document.getElementById("account-pill-text");
  const navPlayerCount = document.getElementById("nav-player-count");

  const playersModal = document.getElementById("players-modal");
  const closePlayersBtn = document.getElementById("close-players-btn");
  const playersListContainer = document.getElementById("players-list-container");

  const settingsModal = document.getElementById("settings-modal");
  const closeSettingsBtn = document.getElementById("close-settings-btn");
  const micSensitivitySlider = document.getElementById("mic-sensitivity-slider");
  const sensitivityVal = document.getElementById("sensitivity-val");
  const noiseSuppressCheck = document.getElementById("noise-suppress-check");
  const saveSettingsBtn = document.getElementById("save-settings-btn");

  const accountModal = document.getElementById("account-modal");
  const closeAccountBtn = document.getElementById("close-account-btn");
  const tabLoginBtn = document.getElementById("tab-login-btn");
  const tabRegisterBtn = document.getElementById("tab-register-btn");
  const authForm = document.getElementById("auth-form");
  const authUsername = document.getElementById("auth-username");
  const authPassword = document.getElementById("auth-password");
  const authSubmitBtn = document.getElementById("auth-submit-btn");
  const authFormsWrap = document.getElementById("auth-forms-wrap");
  const profileWrap = document.getElementById("profile-wrap");
  const profileUsername = document.getElementById("profile-username");
  const profileAvatar = document.getElementById("profile-avatar");
  const profileMutedCount = document.getElementById("profile-muted-count");
  const profileBlockedCount = document.getElementById("profile-blocked-count");
  const logoutBtn = document.getElementById("logout-btn");

  // PiP Elements
  const pipCanvas = document.getElementById("pipCanvas");
  const pipCtx = pipCanvas.getContext("2d", { alpha: false });
  const pipVideo = document.getElementById("pip-video");

  // Streamer Mask Toggle for PIN
  if (togglePinMaskBtn && pinInput) {
    let isMasked = false;
    togglePinMaskBtn.addEventListener("click", () => {
      isMasked = !isMasked;
      pinInput.type = isMasked ? "password" : "text";
      togglePinMaskBtn.textContent = isMasked ? "🔒" : "👁️";
    });
  }

  try {
    pinInput.value = localStorage.getItem("rbx_aura_pin") || "";
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // حالة التطبيق (Runtime State)
  // ---------------------------------------------------------------------------
  let myPin = "";
  let myRobloxUserId = "";
  let latestPinMap = {};
  let myUsername = "أنا";
  let myPeerId = null;

  let localAudioStream = null;
  let canvasVideoStream = null;
  let combinedPipStream = null;

  let audioContext = null;
  let localAnalyser = null;
  let localSourceNode = null;
  let micLevelPct = 0;
  let isSelfSpeaking = false;
  let lastBroadcastSpeaking = false;
  let lastVoiceActivityTime = 0;
  let meterRafId = null;
  let micSensitivityThreshold = 4; // default 4%

  let ws = null;
  let wsHeartbeatInterval = null;
  let isMicMuted = false;
  let isPipActive = false;
  let awaitingSecondTapForPiP = false;
  let isIntentionalDisconnect = false;

  let latestLocations = {};
  let isListenerPlaced = false;
  let hasJoinedRobloxGame = false;
  let missingLocationTicks = 0;

  // Moderation Sets (Muted & Blocked players by UserId or PeerId)
  const locallyMutedUsers = new Set();  // "أنت لا تسمعه، ولكنه يسمعك"
  const locallyBlockedUsers = new Set(); // "حظر متبادل: لا يسمعك ولا تسمعه"

  // User Account & Cloud Settings
  let currentUser = null;
  let authToken = localStorage.getItem("aura_auth_token") || "";
  let selectedMicrophoneId = localStorage.getItem("aura_preferred_mic") || "";

  /**
   * خريطة الأقران المتصلين
   */
  const peers = new Map();

  // ---------------------------------------------------------------------------
  // Logging & Utilities
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
    globalStatusDot.className = "pulse-dot" + (dotState ? ` ${dotState}` : "");
  }

  function updatePipUiState(active) {
    isPipActive = active;
    if (active) {
      pipStatusVal.textContent = "نشط بالخلفية 🟢";
      pipStatusVal.className = "pill-value ok";
      reopenPipBtn.classList.add("hidden");
      if (ws && ws.readyState === WebSocket.OPEN) {
        updateGlobalStatus("المكالمة نشطة بالخلفية", "online");
      }
    } else {
      pipStatusVal.textContent = localAudioStream ? "متوقف مؤقتاً" : "معطل";
      pipStatusVal.className = localAudioStream ? "pill-value warn" : "pill-value";
      if (localAudioStream && ws) {
        reopenPipBtn.classList.remove("hidden");
        updateGlobalStatus("المايك يحتاج إعادة فتح PiP", "warning");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PiP Black Box Engine (مربع أسود خالص 160x160 فائق الخفة)
  // ---------------------------------------------------------------------------
  function renderBlackBoxPiP() {
    if (!pipCtx) return;
    pipCtx.fillStyle = "#000000";
    pipCtx.fillRect(0, 0, 160, 160);

    // نقطة ميكرو صغيرة جداً في المنتصف لتحديث فريم الفيديو لنظام iOS دون أي معالجة ثقيلة
    if (isMicMuted) {
      pipCtx.fillStyle = "#ef4444";
      pipCtx.beginPath();
      pipCtx.arc(80, 80, 2, 0, Math.PI * 2);
      pipCtx.fill();
    } else if (isSelfSpeaking) {
      pipCtx.fillStyle = "#22c55e";
      pipCtx.beginPath();
      pipCtx.arc(80, 80, 3, 0, Math.PI * 2);
      pipCtx.fill();
    }
  }

  let pipIntervalId = null;
  function startBlackBoxPiPLoop() {
    renderBlackBoxPiP();
    // تحديث خفيف جداً بمعدل مرة كل 1.5 ثانية فقط لإبقاء مسار الفيديو حياً في iOS
    clearInterval(pipIntervalId);
    pipIntervalId = setInterval(renderBlackBoxPiP, 1500);
  }

  function stopBlackBoxPiPLoop() {
    clearInterval(pipIntervalId);
    renderBlackBoxPiP();
  }

  // ---------------------------------------------------------------------------
  // قائمة وإدارة أجهزة المايكروفون (Microphone Selection & Switching)
  // ---------------------------------------------------------------------------
  async function loadAudioDevices() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");

      micSelect.innerHTML = "";
      settingsMicSelect.innerHTML = "";

      if (audioInputs.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "المايك الافتراضي للجهاز";
        micSelect.appendChild(opt);
        settingsMicSelect.appendChild(opt.cloneNode(true));
        return;
      }

      audioInputs.forEach((device, index) => {
        const label = device.label || `مايك إدخال ${index + 1}`;
        const opt = document.createElement("option");
        opt.value = device.deviceId;
        opt.textContent = label;

        if (device.deviceId === selectedMicrophoneId) {
          opt.selected = true;
        }

        micSelect.appendChild(opt);
        settingsMicSelect.appendChild(opt.cloneNode(true));
      });
    } catch (err) {
      log("Devices", `تعذر سرد أجهزة الصوت: ${err.message}`);
    }
  }

  async function switchAudioDevice(deviceId) {
    selectedMicrophoneId = deviceId;
    localStorage.setItem("aura_preferred_mic", deviceId);
    micSelect.value = deviceId;
    settingsMicSelect.value = deviceId;

    if (currentUser && authToken) {
      syncSettingsToCloud();
    }

    if (!localAudioStream) return;

    log("Audio", `جارٍ التبديل إلى المايك: ${deviceId || "default"}`);
    try {
      const constraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: noiseSuppressCheck ? noiseSuppressCheck.checked : true,
          noiseSuppression: noiseSuppressCheck ? noiseSuppressCheck.checked : true,
          autoGainControl: true,
        },
      };

      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      const [newTrack] = newStream.getAudioTracks();

      // Replace audio track in all peer connections
      for (const peerInfo of peers.values()) {
        if (peerInfo.pc) {
          const senders = peerInfo.pc.getSenders();
          const audioSender = senders.find((s) => s.track && s.track.kind === "audio");
          if (audioSender) {
            audioSender.replaceTrack(newTrack);
          }
        }
      }

      // Reconnect to local analyser
      if (audioContext && localSourceNode) {
        try { localSourceNode.disconnect(); } catch (_) {}
        localSourceNode = audioContext.createMediaStreamSource(newStream);
        localSourceNode.connect(localAnalyser);
      }

      // Stop old tracks
      localAudioStream.getAudioTracks().forEach((t) => t.stop());
      localAudioStream = newStream;
      setMuteState(isMicMuted, false);

      showAlert("تم تبديل المايك بنجاح!");
      setTimeout(clearAlert, 2000);
    } catch (err) {
      log("Audio", `خطأ أثناء تبديل المايك: ${err.message}`);
      showAlert(`تعذر تبديل المايك: ${err.message}`, true);
    }
  }

  micSelect.addEventListener("change", (e) => switchAudioDevice(e.target.value));
  settingsMicSelect.addEventListener("change", (e) => switchAudioDevice(e.target.value));

  // ---------------------------------------------------------------------------
  // Web Audio 3D Spatial Pipeline (Binaural HRTF Panner)
  // ---------------------------------------------------------------------------
  const TELEPORT_SNAP_DISTANCE = 40;
  const LISTENER_YAW_SNAP_RADIANS = (2 * Math.PI) / 3;
  let lastListenerTarget = null;

  function initAndUnlockSpatialAudioContextSync() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!audioContext) {
        audioContext = new AudioCtx({ latencyHint: "interactive" });
        resetListenerToOrigin();

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

  function yawToForward(yaw) {
    const a = Number.isFinite(yaw) ? yaw : 0;
    return { x: Math.sin(a), y: 0, z: -Math.cos(a) };
  }

  function angleDelta(a, b) {
    let d = (a - b) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  }

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

  function createSpatialPanner() {
    const panner = audioContext.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = SPATIAL_CONFIG.REF_DISTANCE;
    panner.rolloffFactor = SPATIAL_CONFIG.ROLLOFF_FACTOR;
    panner.maxDistance = SPATIAL_CONFIG.MAX_HEARING_DISTANCE;

    if (SPATIAL_CONFIG.DIRECTIONAL_VOICE) {
      panner.coneInnerAngle = SPATIAL_CONFIG.CONE_INNER_ANGLE;
      panner.coneOuterAngle = SPATIAL_CONFIG.CONE_OUTER_ANGLE;
      panner.coneOuterGain = SPATIAL_CONFIG.CONE_OUTER_GAIN;
    } else {
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 1;
    }
    return panner;
  }

  function placePanner(peerInfo, x, y, z, yaw) {
    const panner = peerInfo.pannerNode;
    if (!panner || !audioContext) return;

    const f = yawToForward(yaw);
    const prev = peerInfo.lastTarget;
    const snapPosition =
      !prev || Math.hypot(x - prev.x, y - prev.y, z - prev.z) > TELEPORT_SNAP_DISTANCE;
    const snapOrientation =
      snapPosition || angleDelta(yaw, prev.yaw) > LISTENER_YAW_SNAP_RADIANS;
    peerInfo.lastTarget = { x, y, z, yaw };

    if (panner.positionX) {
      setParam(panner.positionX, x, snapPosition);
      setParam(panner.positionY, y, snapPosition);
      setParam(panner.positionZ, z, snapPosition);
      setParam(panner.orientationX, f.x, snapOrientation);
      setParam(panner.orientationY, 0, snapOrientation);
      setParam(panner.orientationZ, f.z, snapOrientation);
    } else if (typeof panner.setPosition === "function") {
      panner.setPosition(x, y, z);
      panner.setOrientation(f.x, 0, f.z);
    }
  }

  function attachSpatialAudioPipeline(peerId, remoteStream) {
    const peerInfo = peers.get(peerId);
    if (!peerInfo) return;

    teardownPeerAudioNodes(peerInfo);

    const audioEl = document.createElement("audio");
    audioEl.id = `remote-audio-${peerId}`;
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.muted = true;
    audioEl.srcObject = remoteStream;
    document.getElementById("remote-audio-container").appendChild(audioEl);
    peerInfo.audioEl = audioEl;

    audioEl.play().catch(() => {});

    try {
      const source = audioContext.createMediaStreamSource(remoteStream);
      const panner = createSpatialPanner();
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 1.0;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 64;

      source.connect(analyser);
      analyser.connect(panner);
      panner.connect(gainNode);
      gainNode.connect(audioContext.destination);

      peerInfo.sourceNode = source;
      peerInfo.pannerNode = panner;
      peerInfo.gainNode = gainNode;
      peerInfo.analyser = analyser;

      applySpatialLocationsToPeer(peerInfo);
    } catch (err) {
      log("WebAudio", `خطأ تركيب مسار الصوت (${peerId}): ${err.message}`);
    }
  }

  function applySpatialLocationsToPeer(peerInfo) {
    if (!peerInfo.gainNode) return;
    const gainParam = peerInfo.gainNode.gain;

    const myUid = myRobloxUserId || latestPinMap[myPin];
    const peerUid = peerInfo.robloxUserId || latestPinMap[peerInfo.pin];

    // 1. فحص الحظر والكتم المحلي للمستخدم
    const isBlocked = (peerUid && locallyBlockedUsers.has(peerUid)) || locallyBlockedUsers.has(peerInfo.peerId);
    const isMuted = (peerUid && locallyMutedUsers.has(peerUid)) || locallyMutedUsers.has(peerInfo.peerId);

    if (isBlocked || isMuted) {
      setParam(gainParam, 0.0);
      peerInfo.spatialSummary = isBlocked ? "🚫 محظور بالكامل" : "🔇 مكتوم محلياً";
      return;
    }

    const myLoc = myUid ? latestLocations[myUid] : null;
    const peerLoc = peerUid ? latestLocations[peerUid] : null;

    if (!myLoc || !peerLoc) {
      peerInfo.spatialSummary = !peerLoc ? "ليس داخل اللعبة" : "بانتظار موقعك";
      setParam(gainParam, 0.0);
      return;
    }

    if (peerLoc.username && peerInfo.username !== peerLoc.username) {
      peerInfo.username = peerLoc.username;
    }

    placePanner(peerInfo, peerLoc.x, peerLoc.y, peerLoc.z, peerLoc.yaw);

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

    const f = yawToForward(myLoc.yaw);
    const ahead = dx * f.x + dz * f.z;
    const side = dx * -f.z + dz * f.x;
    const angleDeg = Math.round((Math.atan2(side, ahead) * 180) / Math.PI);

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

  function handleLocationsBroadcast(locationsMap, pinMap, peerMap) {
    latestLocations = locationsMap || {};
    latestPinMap = pinMap || {};

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
      hasJoinedRobloxGame = true;
      missingLocationTicks = 0;
      placeListener(myLoc.x, myLoc.y, myLoc.z, myLoc.yaw, !isListenerPlaced);
      isListenerPlaced = true;

      if (myLoc.username) myUsername = myLoc.username;
      spatialStatusVal.textContent = `متزامن (${Math.round(myLoc.x)}, ${Math.round(myLoc.y)}, ${Math.round(myLoc.z)})`;
      spatialStatusVal.className = "pill-value mono ok";

      // مزامنة حالة الكتم من روبلوكس إلى المتصفح (إذا تغيرت في اللعبة)
      if (typeof myLoc.muted === "boolean" && myLoc.muted !== isMicMuted) {
        setMuteState(myLoc.muted, false);
      }
    } else {
      isListenerPlaced = false;

      // الخروج التلقائي من المكالمة بالكامل إذا غادر اللاعب ماب روبلوكس
      if (hasJoinedRobloxGame && localAudioStream) {
        missingLocationTicks++;
        if (missingLocationTicks >= 4) {
          log("Spatial", "تم رصد خروج اللاعب من ماب روبلوكس -> إنهاء المكالمة بالكامل.");
          disconnectSession();
          showAlert("تم إنهاء المكالمة الصوتية تلقائياً لخروجك من ماب روبلوكس.", false);
          return;
        }
      }

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

    updatePlayersListUI();
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
  // كاشف التحدث للمايك (Voice Activity Detector)
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

      localSourceNode = audioContext.createMediaStreamSource(audioStream);
      localAnalyser = audioContext.createAnalyser();
      localAnalyser.fftSize = 512;
      localAnalyser.smoothingTimeConstant = 0.25;
      localSourceNode.connect(localAnalyser);

      try {
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0.0;
        localAnalyser.connect(silentGain);
        silentGain.connect(audioContext.destination);
      } catch (_) {}

      const timeData = new Uint8Array(localAnalyser.fftSize);

      if (meterRafId) {
        cancelAnimationFrame(meterRafId);
        meterRafId = null;
      }

      const updateVAD = () => {
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
          micLevelPct = Math.min(100, Math.round(rms * 500));
          if (micMeterBar) {
            micMeterBar.style.width = `${micLevelPct}%`;
          }

          const isSpeakingNow = micLevelPct > micSensitivityThreshold;
          if (isSpeakingNow) {
            lastVoiceActivityTime = Date.now();
            isSelfSpeaking = true;
          } else if (Date.now() - lastVoiceActivityTime < 900) {
            isSelfSpeaking = true;
          } else {
            isSelfSpeaking = false;
          }
        }

        const nowSpeaking = Boolean(isSelfSpeaking);
        if (nowSpeaking !== lastBroadcastSpeaking) {
          lastBroadcastSpeaking = nowSpeaking;
          renderBlackBoxPiP();
          if (ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "speaking", speaking: nowSpeaking }));
            } catch (_) {}
          }
        }
      };

      meterRafId = requestAnimationFrame(updateVAD);
    } catch (err) {
      log("VAD", "خطأ في تهيئة محلل الصوت: " + err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // تشغيل PiP والاتصال الأساسي
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

    const rawInput = pinInput.value.trim();
    if (!rawInput) {
      showAlert("يرجى إدخال رمز الـ PIN (4 أرقام) أو اسم المستخدم أو UserId الخاص بك في روبلوكس!", true);
      pinInput.focus();
      return;
    }

    const digitsOnly = rawInput.replace(/\D/g, "");
    if (digitsOnly.length === 4) {
      myPin = digitsOnly;
      myRobloxUserId = "";
    } else if (digitsOnly.length > 4) {
      myRobloxUserId = digitsOnly;
      myPin = "";
    } else {
      myUsername = rawInput;
    }

    try {
      localStorage.setItem("rbx_aura_pin", rawInput);
    } catch (_) {}

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showAlert("يتطلب تشغيل المايك ونافذة PiP رابط آمن HTTPS (أو localhost).", true);
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
    connectBtnText.textContent = "جارٍ تشغيل نافذة PiP بالخلفية...";
    hasJoinedRobloxGame = false;
    missingLocationTicks = 0;
    lastVoiceActivityTime = 0;

    try {
      const audioConstraints = {
        deviceId: selectedMicrophoneId ? { exact: selectedMicrophoneId } : undefined,
        echoCancellation: noiseSuppressCheck ? noiseSuppressCheck.checked : true,
        noiseSuppression: noiseSuppressCheck ? noiseSuppressCheck.checked : true,
        autoGainControl: true,
      };

      localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      log("Media", "تم الحصول على إذن المايك بنجاح.");
      startMicActivityDetector(localAudioStream);
      await loadAudioDevices();

      // إنشاء مسار الفيديو الأسود الخفيف (160x160 مربع أسود)
      canvasVideoStream = pipCanvas.captureStream ? pipCanvas.captureStream(5) : null;
      startBlackBoxPiPLoop();

      combinedPipStream = new MediaStream();
      if (canvasVideoStream) {
        canvasVideoStream.getVideoTracks().forEach((t) => combinedPipStream.addTrack(t));
      }
      localAudioStream.getAudioTracks().forEach((t) => combinedPipStream.addTrack(t));

      pipVideo.srcObject = combinedPipStream;
      await pipVideo.play().catch(() => {});

      try {
        await enterPictureInPicture(pipVideo);
        updatePipUiState(true);
        onPipReadyEstablishWebRTC();
      } catch (pipErr) {
        handlePipFailure(pipErr);
      }
    } catch (err) {
      connectBtn.disabled = false;
      connectBtnText.textContent = "بدء الاتصال الصوتي (PiP)";
      showAlert(`فشل تشغيل المايك: ${err.message}`, true);
    }
  }

  function handlePipFailure(err) {
    const errName = err?.name || "";
    const errMsg = err?.message || String(err);
    log("Warn", `تنبيه PiP (${errName}): ${errMsg}`);

    if (errName === "NotAllowedError" || errName === "InvalidAccessError") {
      awaitingSecondTapForPiP = true;
      connectBtn.disabled = false;
      connectBtnText.textContent = "اضغط مرة ثانية لفتح نافذة PiP المنبثقة";
      showAlert("تم تجهيز المايك! نظام iOS يتطلب ضغطة ثانية لفتح نافذة PiP المنبثقة.");
      return;
    }

    if (errMsg === "PIP_NOT_SUPPORTED" || errName === "NotSupportedError") {
      connectBtn.disabled = false;
      connectBtnText.textContent = "بدء الاتصال الصوتي (PiP)";
      showAlert("نافذة PiP غير مدعومة في هذا المتصفح. يمكنك المتابعة بالوضع العادي أدناه.");
      fallbackForegroundBtn.classList.remove("hidden");
      return;
    }

    connectBtn.disabled = false;
    connectBtnText.textContent = "بدء الاتصال الصوتي (PiP)";
    showAlert(`خطأ في الإعداد: ${errMsg}`, true);
  }

  let isPinMasked = false;
  try {
    isPinMasked = localStorage.getItem("rbx_pin_masked") === "true";
  } catch (_) {}

  function updateConnectedBannerText() {
    const idDisplay = myPin || (myRobloxUserId ? `ID: ${myRobloxUserId}` : myUsername);
    const text = isPinMasked ? "PIN: ••••" : (idDisplay || "متصل");
    connectBtnText.textContent = `🟢 متصل في مكالمة Aura (${text})  🔒`;
  }

  function onPipReadyEstablishWebRTC() {
    clearAlert();
    fallbackForegroundBtn.classList.add("hidden");
    identityGroup.classList.add("hidden");
    connectBtn.classList.add("connected");
    connectBtn.disabled = false;
    connectBtn.title = "انقر لإخفاء أو إظهار الرمز لحماية البث المباشر (Streamer Mode / Share Screen)";
    updateConnectedBannerText();
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
  });

  // ---------------------------------------------------------------------------
  // خادم الـ WebSocket وتبادل الإشارات
  // ---------------------------------------------------------------------------
  function buildSignalingUrl(pin) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      pin: myPin || (pin || ""),
      user_id: myRobloxUserId || "",
      username: myUsername !== "أنا" ? myUsername : "",
    });
    return `${protocol}//${window.location.host}/ws?${params.toString()}`;
  }

  function connectSignalingServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    isIntentionalDisconnect = false;
    const url = buildSignalingUrl(myPin);
    wsStatusVal.textContent = "جارٍ الاتصال";
    wsStatusVal.className = "pill-value warn";

    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      wsStatusVal.textContent = "متصل";
      wsStatusVal.className = "pill-value ok";
      updateGlobalStatus(
        isPipActive ? "المكالمة نشطة بالخلفية" : "المكالمة متصلة",
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

      case "roblox-disconnected": {
        log("WebSocket", "تم تلقي إشعار خروج اللاعب من ماب روبلوكس -> إنهاء المكالمة بالكامل.");
        disconnectSession();
        showAlert(msg.message || "تم إنهاء المكالمة الصوتية تلقائياً لمغادرتك ماب روبلوكس.", false);
        return;
      }

      case "locations": {
        handleLocationsBroadcast(msg.locations, msg.pinMap, msg.peerMap);
        return;
      }

      case "sync-mute": {
        // مزامنة حالة الكتم من السيرفر/روبلوكس
        if (typeof msg.muted === "boolean" && msg.muted !== isMicMuted) {
          setMuteState(msg.muted, false);
        }
        return;
      }

      case "welcome": {
        myPeerId = msg.peerId;
        for (const remotePeer of msg.peers) {
          registerPeer(remotePeer.peerId, remotePeer.pin, remotePeer.robloxUserId, remotePeer.username);
          await initiateOfferToPeer(remotePeer.peerId);
        }
        updatePlayersListUI();
        break;
      }

      case "peer-joined": {
        registerPeer(msg.peerId, msg.pin, msg.robloxUserId, msg.username);
        updatePlayersListUI();
        break;
      }

      case "peer-left": {
        removePeer(msg.peerId);
        updatePlayersListUI();
        break;
      }

      case "peer-block": {
        // اللاعب قام بحظرنا أو رفع الحظر عنا
        const senderInfo = peers.get(msg.sender);
        if (senderInfo && senderInfo.gainNode) {
          if (msg.blocked) {
            senderInfo.gainNode.gain.value = 0.0;
            senderInfo.spatialSummary = "🚫 قام اللاعب بحظرك";
          }
        }
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
  // WebRTC Peer Connections
  // ---------------------------------------------------------------------------
  function registerPeer(peerId, pin, robloxUserId, username) {
    if (!peers.has(peerId)) {
      peers.set(peerId, {
        peerId,
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
    updatePlayersListUI();
  }

  // ---------------------------------------------------------------------------
  // مزامنة الكتم الثنائية (Bidirectional Mute Synchronization)
  // ---------------------------------------------------------------------------
  function setMuteState(muted, notifyServer = true) {
    isMicMuted = Boolean(muted);

    if (localAudioStream) {
      for (const track of localAudioStream.getAudioTracks()) {
        track.enabled = !isMicMuted;
      }
    }

    muteBtn.classList.toggle("muted-active", isMicMuted);
    muteBtnText.textContent = isMicMuted ? "إلغاء كتم المايك" : "كتم المايك";
    micStateText.textContent = isMicMuted ? "مكتوم 🔇" : "نشط 🟢";

    renderBlackBoxPiP();

    // إرسال التحديث لسيرفر روبلوكس لتحديث زر المايك في اللعبة
    if (notifyServer && ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "set-mute", muted: isMicMuted }));
      } catch (_) {}
    }
  }

  function toggleMute() {
    if (!localAudioStream) return;
    setMuteState(!isMicMuted, true);
  }

  muteBtn.addEventListener("click", toggleMute);

  // ---------------------------------------------------------------------------
  // نظام الكتم والحظر (Mute vs. Block System)
  // ---------------------------------------------------------------------------
  /**
   * كتم (Mute): أنت لا تسمعه، ولكنه يسمعك.
   */
  function togglePeerMute(targetId) {
    if (locallyMutedUsers.has(targetId)) {
      locallyMutedUsers.delete(targetId);
    } else {
      locallyMutedUsers.add(targetId);
      locallyBlockedUsers.delete(targetId); // إلغاء الحظر إذا تم تحويله لكتم فقط
    }

    // تطبيق فوراً على مسار الصوت
    for (const info of peers.values()) {
      if (info.peerId === targetId || info.robloxUserId === targetId) {
        applySpatialLocationsToPeer(info);
      }
    }

    saveModerationSettings();
    updatePlayersListUI();
  }

  /**
   * حظر (Block): حظر متبادل كامل (لا يسمعك ولا تسمعه).
   */
  function togglePeerBlock(targetId) {
    const isNowBlocked = !locallyBlockedUsers.has(targetId);

    if (isNowBlocked) {
      locallyBlockedUsers.add(targetId);
      locallyMutedUsers.delete(targetId);
    } else {
      locallyBlockedUsers.delete(targetId);
    }

    // 1. كتم الصوت القادم منه محلياً (لا تسمعه)
    // 2. إيقاف مسار الصوت الصادر إليه في WebRTC (لا يسمعك)
    for (const info of peers.values()) {
      if (info.peerId === targetId || info.robloxUserId === targetId) {
        applySpatialLocationsToPeer(info);

        if (info.pc) {
          const senders = info.pc.getSenders();
          for (const s of senders) {
            if (s.track && s.track.kind === "audio") {
              s.track.enabled = !isNowBlocked;
            }
          }
        }

        // إرسال إشارة للطرف الآخر ليعرف أنه محظور
        sendSignal({
          type: "peer-block",
          target: info.peerId,
          blocked: isNowBlocked,
        });
      }
    }

    saveModerationSettings();
    updatePlayersListUI();
  }

  function saveModerationSettings() {
    localStorage.setItem("aura_muted_users", JSON.stringify(Array.from(locallyMutedUsers)));
    localStorage.setItem("aura_blocked_users", JSON.stringify(Array.from(locallyBlockedUsers)));

    if (currentUser && authToken) {
      syncSettingsToCloud();
    }
  }

  function loadModerationSettings() {
    try {
      const m = JSON.parse(localStorage.getItem("aura_muted_users") || "[]");
      const b = JSON.parse(localStorage.getItem("aura_blocked_users") || "[]");
      m.forEach((id) => locallyMutedUsers.add(String(id)));
      b.forEach((id) => locallyBlockedUsers.add(String(id)));
    } catch (_) {}
  }

  loadModerationSettings();

  // ---------------------------------------------------------------------------
  // واجهة قائمة اللاعبين المنبثقة (Players Moderation Modal)
  // ---------------------------------------------------------------------------
  function updatePlayersListUI() {
    const count = peers.size;
    navPlayerCount.textContent = count;

    if (!playersModal.classList.contains("hidden")) {
      renderPlayersModalList();
    }
  }

  function renderPlayersModalList() {
    playersListContainer.innerHTML = "";

    if (peers.size === 0) {
      playersListContainer.innerHTML = `
        <div style="text-align: center; padding: 24px 10px; color: var(--text-secondary); font-size: 0.88rem;">
          لا يوجد لاعبون آخرون متصلون في سيرفر روبلوكس حالياً.
        </div>
      `;
      return;
    }

    for (const info of peers.values()) {
      const peerKey = info.robloxUserId || info.peerId;
      const isMuted = locallyMutedUsers.has(peerKey) || locallyMutedUsers.has(info.peerId);
      const isBlocked = locallyBlockedUsers.has(peerKey) || locallyBlockedUsers.has(info.peerId);

      const row = document.createElement("div");
      row.className = "player-mod-card";

      const initials = (info.username || "لاعب").replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, "").slice(0, 2).toUpperCase() || "🎙️";

      row.innerHTML = `
        <div class="player-info-side">
          <div class="player-avatar-circle">${initials}</div>
          <div class="player-name-meta">
            <span class="player-main-name">${info.username}</span>
            <span class="player-sub-meta">${info.spatialSummary || "متصل"}</span>
          </div>
        </div>
        <div class="player-actions-side">
          <button type="button" class="btn-action-mute ${isMuted ? "active" : ""}" title="كتم: أنت لا تسمعه وهو يسمعك">
            ${isMuted ? "إلغاء الكتم" : "🔇 كتم"}
          </button>
          <button type="button" class="btn-action-block ${isBlocked ? "active" : ""}" title="حظر متبادل: لا يسمعك ولا تسمعه">
            ${isBlocked ? "إلغاء الحظر" : "🚫 حظر"}
          </button>
        </div>
      `;

      const muteBtn = row.querySelector(".btn-action-mute");
      const blockBtn = row.querySelector(".btn-action-block");

      muteBtn.addEventListener("click", () => togglePeerMute(peerKey));
      blockBtn.addEventListener("click", () => togglePeerBlock(peerKey));

      playersListContainer.appendChild(row);
    }
  }

  openPlayersBtn.addEventListener("click", () => {
    renderPlayersModalList();
    playersModal.classList.remove("hidden");
  });
  closePlayersBtn.addEventListener("click", () => playersModal.classList.add("hidden"));

  // ---------------------------------------------------------------------------
  // واجهة الإعدادات المنبثقة (Audio Settings Modal)
  // ---------------------------------------------------------------------------
  openSettingsBtn.addEventListener("click", () => {
    loadAudioDevices();
    settingsModal.classList.remove("hidden");
  });
  closeSettingsBtn.addEventListener("click", () => settingsModal.classList.add("hidden"));

  micSensitivitySlider.addEventListener("input", (e) => {
    micSensitivityThreshold = parseInt(e.target.value, 10);
    sensitivityVal.textContent = `${micSensitivityThreshold}%`;
  });

  saveSettingsBtn.addEventListener("click", () => {
    settingsModal.classList.add("hidden");
    showAlert("تم حفظ إعدادات الصوت بنجاح!");
    setTimeout(clearAlert, 2000);
    if (currentUser && authToken) {
      syncSettingsToCloud();
    }
  });

  // ---------------------------------------------------------------------------
  // نظام الحسابات والمصادقة (User Accounts & Cloud Sync)
  // ---------------------------------------------------------------------------
  openAccountBtn.addEventListener("click", () => {
    accountModal.classList.remove("hidden");
    updateAccountModalView();
  });
  closeAccountBtn.addEventListener("click", () => accountModal.classList.add("hidden"));

  let isRegisterTab = false;
  tabLoginBtn.addEventListener("click", () => {
    isRegisterTab = false;
    tabLoginBtn.classList.add("active");
    tabRegisterBtn.classList.remove("active");
    authSubmitBtn.textContent = "تسجيل الدخول";
  });
  tabRegisterBtn.addEventListener("click", () => {
    isRegisterTab = true;
    tabRegisterBtn.classList.add("active");
    tabLoginBtn.classList.remove("active");
    authSubmitBtn.textContent = "إنشاء حساب جديد";
  });

  function updateAccountModalView() {
    if (currentUser) {
      authFormsWrap.classList.add("hidden");
      profileWrap.classList.remove("hidden");
      profileUsername.textContent = currentUser.username;
      profileAvatar.textContent = (currentUser.username[0] || "👑").toUpperCase();
      profileMutedCount.textContent = `المكتومون: ${locallyMutedUsers.size}`;
      profileBlockedCount.textContent = `المحظورون: ${locallyBlockedUsers.size}`;
      accountPillText.textContent = `👑 ${currentUser.username}`;
    } else {
      authFormsWrap.classList.remove("hidden");
      profileWrap.classList.add("hidden");
      accountPillText.textContent = "👤 حسابي";
    }
  }

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert();

    const u = authUsername.value.trim();
    const p = authPassword.value;
    const endpoint = isRegisterTab ? "/api/register" : "/api/login";

    authSubmitBtn.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "فشل تسجيل الدخول");
      }

      authToken = data.token;
      currentUser = { username: data.username, settings: data.settings };
      localStorage.setItem("aura_auth_token", authToken);

      applyCloudSettings(data.settings);
      updateAccountModalView();
      accountModal.classList.add("hidden");
      showAlert(`مرحباً بك يا ${data.username}! تم تسجيل الدخول وحفظ إعداداتك.`);
    } catch (err) {
      showAlert(err.message, true);
    } finally {
      authSubmitBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener("click", () => {
    authToken = "";
    currentUser = null;
    localStorage.removeItem("aura_auth_token");
    updateAccountModalView();
    showAlert("تم تسجيل الخروج بنجاح.");
  });

  async function checkExistingAuth() {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/me?token=${encodeURIComponent(authToken)}`);
      if (res.ok) {
        const data = await res.json();
        currentUser = { username: data.username, settings: data.settings };
        applyCloudSettings(data.settings);
        updateAccountModalView();
      } else {
        authToken = "";
        localStorage.removeItem("aura_auth_token");
      }
    } catch (_) {}
  }

  function applyCloudSettings(settings) {
    if (!settings) return;
    if (settings.preferredMicId) {
      selectedMicrophoneId = settings.preferredMicId;
      micSelect.value = selectedMicrophoneId;
      settingsMicSelect.value = selectedMicrophoneId;
    }
    if (Array.isArray(settings.mutedUsers)) {
      settings.mutedUsers.forEach((id) => locallyMutedUsers.add(String(id)));
    }
    if (Array.isArray(settings.blockedUsers)) {
      settings.blockedUsers.forEach((id) => locallyBlockedUsers.add(String(id)));
    }
    if (typeof settings.micSensitivity === "number") {
      micSensitivityThreshold = settings.micSensitivity;
      micSensitivitySlider.value = micSensitivityThreshold;
      sensitivityVal.textContent = `${micSensitivityThreshold}%`;
    }
  }

  async function syncSettingsToCloud() {
    if (!authToken || !currentUser) return;
    try {
      await fetch("/api/save-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: authToken,
          settings: {
            preferredMicId: selectedMicrophoneId,
            mutedUsers: Array.from(locallyMutedUsers),
            blockedUsers: Array.from(locallyBlockedUsers),
            micSensitivity: micSensitivityThreshold,
            noiseSuppression: noiseSuppressCheck ? noiseSuppressCheck.checked : true,
          },
        }),
      });
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // إنهاء الجلسة وإعادة التهيئة
  // ---------------------------------------------------------------------------
  async function reopenPipWindow() {
    if (!combinedPipStream) return;
    try {
      if (pipVideo.paused) await pipVideo.play();
      await enterPictureInPicture(pipVideo);
      updatePipUiState(true);
    } catch (err) {
      showAlert(`تعذر فتح نافذة PiP: ${err.message}`, true);
    }
  }

  async function disconnectSession() {
    isIntentionalDisconnect = true;
    awaitingSecondTapForPiP = false;
    isMicMuted = false;
    latestLocations = {};
    hasJoinedRobloxGame = false;
    missingLocationTicks = 0;
    lastVoiceActivityTime = 0;

    clearInterval(wsHeartbeatInterval);
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    cleanupAllPeers();
    stopBlackBoxPiPLoop();

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
    connectBtnText.textContent = "بدء الاتصال الصوتي (PiP)";
    clearAlert();
    updatePlayersListUI();
  }

  connectBtn.addEventListener("click", () => {
    if (connectBtn.classList.contains("connected")) {
      isPinMasked = !isPinMasked;
      try {
        localStorage.setItem("rbx_pin_masked", String(isPinMasked));
      } catch (_) {}
      updateConnectedBannerText();
      showAlert(isPinMasked ? "🔒 تم إخفاء الرمز لحماية البث المباشر وShare Screen" : "👁️ تم إظهار رمز الربط", false);
      return;
    }
    startDiscordOverlayAndConnect();
  });
  fallbackForegroundBtn.addEventListener("click", onPipReadyEstablishWebRTC);
  reopenPipBtn.addEventListener("click", reopenPipWindow);
  disconnectBtn.addEventListener("click", disconnectSession);

  // Initialize
  loadAudioDevices();
  checkExistingAuth();
})();

// Resume audio on user tap
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
