/**
 * Roblox 3D Spatial Voice — WebRTC + Web Audio HRTF Panner + iOS PiP Hack
 * =======================================================================
 * Architecture Overview:
 * 1. iOS Background Bypass: Combines a 1x1 1FPS <canvas> video stream with the
 *    player's live microphone track inside a Picture-in-Picture <video>.
 * 2. WebRTC Mesh: Connects peers via FastAPI WebSocket signaling, associating
 *    every peer with their numeric `Roblox UserId`.
 * 3. Web Audio 3D Spatialization (`AudioContext` + `PannerNode`):
 *    - Listener sits at local head origin `(0, 0, 0)` looking toward `(0, 0, -1)`.
 *    - Each remote peer's WebRTC stream feeds:
 *        `MediaStreamAudioSourceNode` -> `PannerNode (HRTF)` -> `GainNode` -> `destination`
 *    - Every 0.5s when Roblox coordinates arrive over WebSocket, we compute each
 *      remote speaker's relative 3D offset `(relX, relY, relZ)`, Euclidean stud
 *      distance, and horizontal azimuth angle—smoothly ramping `PannerNode`
 *      position on the native audio thread so movement sounds seamless!
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Spatial Audio & WebRTC Constants (Tuned for Roblox Studs)
  // ---------------------------------------------------------------------------
  const SPATIAL_CONFIG = {
    REF_DISTANCE: 6,           // Full 100% conversational volume within 6 studs (~1.7m)
    FADE_START_DISTANCE: 55,   // Begin smooth outer cutoff fade at 55 studs
    MAX_HEARING_DISTANCE: 80,  // Complete silence (gain = 0) beyond 80 studs
    ROLLOFF_FACTOR: 1.2,       // Inverse distance rolloff steepness
    RAMP_SECONDS: 0.45,        // Smooths 0.5s Roblox server HTTP updates with zero audio clicks
  };

  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      // Add TURN credentials here for strict 4G/5G cellular carrier NAT traversal in production.
    ],
  };

  function buildSignalingUrl(userId, username) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      user_id: userId,
      username: username || "",
    });
    return `${protocol}//${window.location.host}/ws?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // DOM References
  // ---------------------------------------------------------------------------
  const connectBtn = document.getElementById("connect-btn");
  const connectBtnText = document.getElementById("connect-btn-text");
  const fallbackForegroundBtn = document.getElementById("fallback-foreground-btn");
  const sessionControls = document.getElementById("session-controls");
  const muteBtn = document.getElementById("mute-btn");
  const muteBtnText = document.getElementById("mute-btn-text");
  const reopenPipBtn = document.getElementById("reopen-pip-btn");
  const disconnectBtn = document.getElementById("disconnect-btn");

  const userIdInput = document.getElementById("userid-input");
  const usernameInput = document.getElementById("username-input");
  const identityGroup = document.getElementById("identity-group");

  const alertBanner = document.getElementById("alert-banner");
  const globalStatusDot = document.getElementById("global-status-dot");
  const globalStatusLabel = document.getElementById("global-status-label");
  const pipStatusVal = document.getElementById("pip-status-val");
  const wsStatusVal = document.getElementById("ws-status-val");
  const spatialStatusVal = document.getElementById("spatial-status-val");
  const micStateText = document.getElementById("mic-state-text");
  const micMeterBar = document.getElementById("mic-meter-bar");

  const peersListEl = document.getElementById("peers-list");
  const peerCountBadge = document.getElementById("peer-count-badge");
  const remoteAudioContainer = document.getElementById("remote-audio-container");
  const debugLogEl = document.getElementById("debug-log");
  const pipVideo = document.getElementById("pip-video");

  // Restore saved UserId & Display Name for convenience
  try {
    userIdInput.value = localStorage.getItem("rbx_spatial_userid") || "";
    usernameInput.value = localStorage.getItem("rbx_spatial_username") || "";
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // Runtime State
  // ---------------------------------------------------------------------------
  let myRobloxUserId = "";
  let myPeerId = null;

  let localAudioStream = null;
  let canvasVideoStream = null;
  let combinedPipStream = null;

  let keepAliveCtx = null;
  let isKeepAliveActive = false;
  let rafId = null;
  let backgroundTickInterval = null;

  let audioContext = null; // Shared Web Audio Context (listener + all PannerNodes)
  let meterRafId = null;

  let ws = null;
  let wsHeartbeatInterval = null;
  let isMicMuted = false;
  let isPipActive = false;
  let awaitingSecondTapForPiP = false;
  let isIntentionalDisconnect = false;

  // Latest Roblox location dictionary: { [userId]: { x, y, z, yaw? } }
  let latestLocations = {};

  /**
   * Connected WebRTC peers keyed by `peerId`:
   * {
   *   robloxUserId: string,
   *   username: string,
   *   pc: RTCPeerConnection | null,
   *   iceQueue: RTCIceCandidateInit[],
   *   audioEl: HTMLAudioElement | null,           // Muted keep-alive element (fixes Chrome/Safari silence bug)
   *   sourceNode: MediaStreamAudioSourceNode | null,
   *   pannerNode: PannerNode | null,              // 3D HRTF spatializer
   *   gainNode: GainNode | null,                  // Max-distance proximity cutoff envelope
   *   state: string,
   *   spatialSummary: string                      // e.g. "14.2 studs • 38° Right"
   * }
   */
  const peers = new Map();

  // ---------------------------------------------------------------------------
  // Logging & UI Helpers
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
      pipStatusVal.textContent = "Active";
      pipStatusVal.className = "pill-value ok";
      reopenPipBtn.classList.add("hidden");
      if (ws && ws.readyState === WebSocket.OPEN) {
        updateGlobalStatus("3D Background Voice Active", "online");
      }
    } else {
      pipStatusVal.textContent = localAudioStream ? "Paused" : "Off";
      pipStatusVal.className = localAudioStream ? "pill-value warn" : "pill-value";
      if (localAudioStream && ws) {
        reopenPipBtn.classList.remove("hidden");
        updateGlobalStatus("PiP Closed — Background Unsafe", "warning");
      }
    }
  }

  function renderPeersList() {
    peerCountBadge.textContent = `${peers.size} ${peers.size === 1 ? "Peer" : "Peers"}`;
    peersListEl.innerHTML = "";

    if (peers.size === 0) {
      const li = document.createElement("li");
      li.className = "empty-state";
      li.textContent = ws
        ? "Waiting for other players to join voice..."
        : "Enter your Roblox UserId and tap Connect Voice to join.";
      peersListEl.appendChild(li);
      return;
    }

    for (const [peerId, info] of peers.entries()) {
      const li = document.createElement("li");
      li.className = "peer-item";

      const meta = document.createElement("div");
      meta.className = "peer-meta";

      const nameSpan = document.createElement("span");
      nameSpan.className = "peer-name";
      nameSpan.textContent = info.username || `Player_${peerId.slice(0, 4)}`;

      const subSpan = document.createElement("span");
      subSpan.className = "peer-sub mono";
      subSpan.textContent = `UserId: ${info.robloxUserId || "Unset"}`;

      const spatialSpan = document.createElement("span");
      spatialSpan.className = "peer-spatial mono";
      spatialSpan.textContent = info.spatialSummary || "Awaiting Roblox 3D coords...";

      meta.appendChild(nameSpan);
      meta.appendChild(subSpan);
      meta.appendChild(spatialSpan);

      const stateBadge = document.createElement("span");
      const isConnected = info.state === "connected";
      stateBadge.className = `peer-state${isConnected ? " connected" : ""}`;
      stateBadge.textContent = isConnected ? "3D Live" : info.state || "Signaling";

      li.appendChild(meta);
      li.appendChild(stateBadge);
      peersListEl.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Web Audio API — 3D Listener & HRTF PannerNode Engine
  // ---------------------------------------------------------------------------
  /**
   * Initializes & unlocks `AudioContext` synchronously inside the user's button tap,
   * and anchors the `AudioListener` at local head origin `(0, 0, 0)` facing `(0, 0, -1)`.
   *
   * Why listener stays at (0,0,0):
   * By transforming each remote player's coordinates into the local player's
   * head-relative space `(relX, relY, relZ)` before setting `PannerNode` position,
   * we avoid cross-browser bugs in `AudioListener.positionX` on older iOS WebKit builds!
   */
  function initAndUnlockSpatialAudioContextSync() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!audioContext) {
        audioContext = new AudioCtx({ latencyHint: "interactive" });

        // Anchor listener at (0, 0, 0) looking down -Z (Forward) with +Y (Up)
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

        // Auto-resume if iOS temporarily interrupts AudioContext (e.g., Siri / notification)
        audioContext.addEventListener("statechange", () => {
          log("AudioCtx", `State -> ${audioContext.state}`);
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

      // Play a 1-sample silent buffer to unlock iOS Safari's hardware audio output
      const silentBuf = audioContext.createBuffer(1, 1, 22050);
      const src = audioContext.createBufferSource();
      src.buffer = silentBuf;
      src.connect(audioContext.destination);
      src.start(0);
    } catch (err) {
      log("AudioCtx", `Initialization warning: ${err.message}`);
    }
  }

  /**
   * Builds the Web Audio 3D spatialization graph for an incoming remote peer stream:
   *   `remoteStream` -> `MediaStreamAudioSourceNode` -> `PannerNode (HRTF)` -> `GainNode` -> `destination`
   */
  function attachSpatialAudioPipeline(peerId, remoteStream) {
    const peerInfo = peers.get(peerId);
    if (!peerInfo) return;

    // -------------------------------------------------------------------------
    // 1. CRITICAL CHROME & iOS SAFARI WORKAROUND:
    // If a WebRTC remote MediaStream is ONLY passed to `createMediaStreamSource()`
    // without an active HTML5 <audio> element, Chromium (#933677) and WebKit treat
    // the RTP receiver as inactive and feed 0.0 silence into the PannerNode!
    // Attaching a MUTED `<audio autoplay playsinline>` pulls packets without playing
    // unspatialized dry audio, letting our PannerNode render 100% of the sound!
    // -------------------------------------------------------------------------
    let audioEl = peerInfo.audioEl;
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `remote-keepalive-${peerId}`;
      audioEl.autoplay = true;
      audioEl.muted = true; // Muted so ONLY the 3D PannerNode output is heard!
      audioEl.playsInline = true;
      audioEl.setAttribute("playsinline", "");
      audioEl.setAttribute("webkit-playsinline", "");
      remoteAudioContainer.appendChild(audioEl);
      peerInfo.audioEl = audioEl;
    }

    if (audioEl.srcObject !== remoteStream) {
      audioEl.srcObject = remoteStream;
    }
    audioEl.play().catch(() => {});

    if (!audioContext) {
      // Extreme fallback if browser lacks Web Audio API
      audioEl.muted = false;
      return;
    }

    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }

    // Tear down any previous Web Audio nodes if track renegotiated
    teardownPeerAudioNodes(peerInfo);

    // -------------------------------------------------------------------------
    // 2. Construct the 3D Spatial Audio Graph
    // -------------------------------------------------------------------------
    const sourceNode = audioContext.createMediaStreamSource(remoteStream);

    const pannerNode = audioContext.createPanner();
    // "HRTF" applies binaural Head-Related Transfer Function filtering so voices
    // convincingly pan left/right and sound slightly warmer when behind you!
    pannerNode.panningModel = "HRTF";
    pannerNode.distanceModel = "inverse";
    pannerNode.refDistance = SPATIAL_CONFIG.REF_DISTANCE;
    pannerNode.maxDistance = SPATIAL_CONFIG.MAX_HEARING_DISTANCE;
    pannerNode.rolloffFactor = SPATIAL_CONFIG.ROLLOFF_FACTOR;
    pannerNode.coneInnerAngle = 360;
    pannerNode.coneOuterAngle = 360;
    pannerNode.coneOuterGain = 1;

    // Default initial placement: 2 studs directly in front (0, 0, -2)
    setPannerPositionSmooth(pannerNode, 0, 0, -2, true);

    // Proximity cutoff GainNode ensures true 0.0 silence beyond MAX_HEARING_DISTANCE
    // (because `inverse` distanceModel asymptotes above zero on its own).
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 1.0;

    // Wire pipeline: Source -> 3D Panner -> Proximity Cutoff Gain -> Speakers/Headphones
    sourceNode.connect(pannerNode);
    pannerNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Persist strong references on `peerInfo` so WebKit GC never collects the source!
    peerInfo.sourceNode = sourceNode;
    peerInfo.pannerNode = pannerNode;
    peerInfo.gainNode = gainNode;

    log("3D-Audio", `Initialized HRTF PannerNode pipeline for ${peerInfo.username}.`);

    // Immediately apply latest known 3D coordinates if available
    applySpatialLocationsToPeer(peerInfo);
    renderPeersList();
  }

  /**
   * Smoothly updates a PannerNode's 3D `(x, y, z)` coordinates on the native C++ audio thread.
   * Note: `linearRampToValueAtTime` continues interpolating at 48kHz sample accuracy
   * even when iOS Safari is backgrounded and JS timers are throttled!
   */
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
      // Legacy Safari fallback
      pannerNode.setPosition(x, y, z);
    }
  }

  function setGainSmooth(gainNode, targetGain) {
    if (!audioContext || !gainNode) return;
    const now = audioContext.currentTime;
    gainNode.gain.linearRampToValueAtTime(
      targetGain,
      now + SPATIAL_CONFIG.RAMP_SECONDS
    );
  }

  /**
   * Core 3D Spatial Math:
   * Called every 0.5s when `{ type: "locations", locations: { [userId]: {x, y, z, yaw} } }`
   * arrives via WebSocket from FastAPI.
   *
   * Coordinate Systems (Both Roblox & Web Audio API are Right-Handed!):
   *   +X = Right ear
   *   +Y = Up
   *   -Z = Forward (in front of listener), +Z = Behind listener
   */
  function applySpatialLocationsToPeer(peerInfo) {
    const hasAnyRobloxData = Object.keys(latestLocations).length > 0;

    // If Roblox Studio isn't running yet, keep voice centered in 2D fallback mode for easy testing
    if (!hasAnyRobloxData) {
      peerInfo.spatialSummary = "2D Fallback (No Roblox server data)";
      if (peerInfo.pannerNode && peerInfo.gainNode) {
        setPannerPositionSmooth(peerInfo.pannerNode, 0, 0, -2);
        setGainSmooth(peerInfo.gainNode, 1.0);
      }
      return;
    }

    const myLoc = latestLocations[myRobloxUserId];
    const peerLoc = latestLocations[peerInfo.robloxUserId];

    // If Roblox IS active, mute unspawned/lobby players so they don't broadcast globally
    if (!myLoc || !peerLoc) {
      peerInfo.spatialSummary = !myLoc
        ? "Your UserId not in Roblox server"
        : "Peer not spawned in Roblox";
      if (peerInfo.gainNode) {
        setGainSmooth(peerInfo.gainNode, 0.0);
      }
      return;
    }

    // 1. World-space delta vector (in Roblox studs)
    const dx = peerLoc.x - myLoc.x;
    const dy = peerLoc.y - myLoc.y;
    const dz = peerLoc.z - myLoc.z;

    // 2. 3D Euclidean distance between avatars
    const distance = Math.hypot(dx, dy, dz);

    // 3. Rotate horizontal offset (dx, dz) by local player's `yaw` heading so left/right
    //    ears track which direction your Roblox character is facing!
    //    (When `yaw` is 0 or omitted, fx=0 and fz=-1, so relX=dx and relZ=dz.)
    const yaw = typeof myLoc.yaw === "number" ? myLoc.yaw : 0;
    const fx = Math.sin(yaw);   // Forward X component
    const fz = -Math.cos(yaw);  // Forward Z component
    // Right vector in right-handed XZ plane = Forward × Up = (-fz, 0, fx)
    const relX = dx * -fz + dz * fx;       // +relX = Right ear, -relX = Left ear
    const relY = dy;                        // +relY = Above,     -relY = Below
    const relZ = -(dx * fx + dz * fz);     // -relZ = In Front,  +relZ = Behind

    // 4. Relative horizontal angle in degrees (-90° = Left, 0° = Front, +90° = Right)
    const angleRad = Math.atan2(relX, -relZ);
    const angleDeg = Math.round((angleRad * 180) / Math.PI);

    // 5. Compute outer-boundary cutoff gain (1.0 inside 55 studs -> 0.0 at 80+ studs)
    let cutoffGain = 1.0;
    if (distance >= SPATIAL_CONFIG.MAX_HEARING_DISTANCE) {
      cutoffGain = 0.0;
    } else if (distance > SPATIAL_CONFIG.FADE_START_DISTANCE) {
      const span = SPATIAL_CONFIG.MAX_HEARING_DISTANCE - SPATIAL_CONFIG.FADE_START_DISTANCE;
      cutoffGain = 1.0 - (distance - SPATIAL_CONFIG.FADE_START_DISTANCE) / span;
    }

    // 6. Update Web Audio PannerNode 3D coordinates & proximity cutoff GainNode
    if (peerInfo.pannerNode) {
      setPannerPositionSmooth(peerInfo.pannerNode, relX, relY, relZ);
    }
    if (peerInfo.gainNode) {
      setGainSmooth(peerInfo.gainNode, cutoffGain);
    }

    // 7. Format human-readable UI telemetry
    if (distance >= SPATIAL_CONFIG.MAX_HEARING_DISTANCE) {
      peerInfo.spatialSummary = `${distance.toFixed(1)} studs • Out of Range`;
    } else {
      const dirLabel =
        Math.abs(angleDeg) <= 20
          ? "Front"
          : Math.abs(angleDeg) >= 160
          ? "Behind"
          : angleDeg > 0
          ? `${angleDeg}° Right`
          : `${Math.abs(angleDeg)}° Left`;
      peerInfo.spatialSummary = `${distance.toFixed(1)} studs • ${dirLabel}`;
    }
  }

  function handleLocationsBroadcast(locationsMap) {
    latestLocations = locationsMap || {};

    const myLoc = latestLocations[myRobloxUserId];
    if (myLoc) {
      spatialStatusVal.textContent = `${Math.round(myLoc.x)}, ${Math.round(myLoc.z)}`;
      spatialStatusVal.className = "pill-value mono ok";
    } else if (Object.keys(latestLocations).length > 0) {
      spatialStatusVal.textContent = "ID Not Found";
      spatialStatusVal.className = "pill-value mono warn";
    } else {
      spatialStatusVal.textContent = "Waiting";
      spatialStatusVal.className = "pill-value mono";
    }

    for (const peerInfo of peers.values()) {
      applySpatialLocationsToPeer(peerInfo);
    }
    renderPeersList();
  }

  function teardownPeerAudioNodes(peerInfo) {
    try {
      peerInfo.sourceNode?.disconnect();
    } catch (_) {}
    try {
      peerInfo.pannerNode?.disconnect();
    } catch (_) {}
    try {
      peerInfo.gainNode?.disconnect();
    } catch (_) {}
    peerInfo.sourceNode = null;
    peerInfo.pannerNode = null;
    peerInfo.gainNode = null;
  }

  // ---------------------------------------------------------------------------
  // Local Microphone Level Meter
  // ---------------------------------------------------------------------------
  function startMicMeter(audioStream) {
    if (!audioContext) return;
    try {
      const source = audioContext.createMediaStreamSource(audioStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateMeter = () => {
        if (!localAudioStream) {
          micMeterBar.style.width = "0%";
          return;
        }
        if (isMicMuted) {
          micMeterBar.style.width = "0%";
        } else {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          micMeterBar.style.width = `${Math.min(100, Math.round((avg / 90) * 100))}%`;
        }
        meterRafId = requestAnimationFrame(updateMeter);
      };
      meterRafId = requestAnimationFrame(updateMeter);
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // iOS Safari Picture-in-Picture (PiP) Canvas Hack
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

  async function startPipHackAndConnect() {
    clearAlert();

    // Validate numeric Roblox UserId BEFORE requesting media or connecting
    const cleanedUserId = userIdInput.value.replace(/\D/g, "").trim();
    if (!cleanedUserId) {
      showAlert("Please enter your numeric Roblox UserId before connecting!", true);
      userIdInput.focus();
      return;
    }
    myRobloxUserId = cleanedUserId;
    userIdInput.value = cleanedUserId;

    try {
      localStorage.setItem("rbx_spatial_userid", cleanedUserId);
      localStorage.setItem("rbx_spatial_username", usernameInput.value.trim());
    } catch (_) {}

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showAlert(
        "Microphone & PiP require HTTPS (or localhost). On iPhone/iPad, open your HTTPS Render URL or tunnel via cloudflared / ngrok.",
        true
      );
      return;
    }

    // Unlock AudioContext & configure 3D listener synchronously inside user gesture!
    initAndUnlockSpatialAudioContextSync();

    // Recovery tap if iOS expired transient user gesture during 1st-time Mic popup
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
    connectBtnText.textContent = "Requesting Mic & Starting PiP...";

    try {
      // (a) Request microphone stream
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localAudioStream = audioStream;

      const primaryAudioTrack = audioStream.getAudioTracks()[0];
      if (primaryAudioTrack) {
        micStateText.textContent = "Live";
        primaryAudioTrack.addEventListener("mute", () => {
          log("iOS-Mic", "Hardware audio track muted by OS!");
          micStateText.textContent = "OS Muted";
        });
        primaryAudioTrack.addEventListener("unmute", () => {
          log("iOS-Mic", "Hardware audio track unmuted (Live).");
          micStateText.textContent = isMicMuted ? "Muted" : "Live";
        });
      }

      startMicMeter(audioStream);

      // (b) Create <canvas width="1" height="1"> and prime with black
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, 1, 1);

      keepAliveCtx = ctx;
      isKeepAliveActive = true;

      // (c) Continuously draw on canvas (rAF + 1Hz setInterval for backgrounded Safari)
      let toggleShade = false;
      const drawKeepAlivePixel = () => {
        if (!isKeepAliveActive || !keepAliveCtx) return;
        toggleShade = !toggleShade;
        keepAliveCtx.fillStyle = toggleShade ? "#000000" : "#010101";
        keepAliveCtx.fillRect(0, 0, 1, 1);
      };

      const renderLoop = () => {
        if (!isKeepAliveActive) return;
        drawKeepAlivePixel();
        rafId = requestAnimationFrame(renderLoop);
      };
      rafId = requestAnimationFrame(renderLoop);
      backgroundTickInterval = setInterval(drawKeepAlivePixel, 1000);

      // (d) Capture 1 FPS stream
      const videoStream = canvas.captureStream(1);
      canvasVideoStream = videoStream;
      drawKeepAlivePixel();
      videoStream.getVideoTracks()[0]?.requestFrame?.();

      // (e) Combine video + audio tracks
      const combinedStream = new MediaStream([
        ...videoStream.getTracks(),
        ...audioStream.getTracks(),
      ]);
      combinedPipStream = combinedStream;

      // (f) Assign to hidden <video playsinline autoplay muted>
      pipVideo.srcObject = combinedStream;
      pipVideo.muted = true;

      if (pipVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise((resolve) => {
          pipVideo.addEventListener("loadedmetadata", resolve, { once: true });
        });
      }
      await pipVideo.play();

      // (g) Force Picture-in-Picture
      await enterPictureInPicture(pipVideo);
      updatePipUiState(true);
      log("PiP", "Picture-in-Picture active! Connecting 3D Spatial WebRTC...");

      onPipReadyEstablishWebRTC();
    } catch (err) {
      connectBtn.disabled = false;
      handlePipFailure(err);
    }
  }

  function handlePipFailure(err) {
    const errName = err?.name || "";
    const errMsg = err?.message || String(err);
    log("Warn", `PiP/Setup issue (${errName}): ${errMsg}`);

    if (!localAudioStream) {
      connectBtnText.textContent = "Connect Voice (Background Mode)";
      showAlert("Microphone permission denied. Allow mic access in browser settings.", true);
      return;
    }

    if (errName === "NotAllowedError" || errName === "InvalidAccessError") {
      awaitingSecondTapForPiP = true;
      connectBtnText.textContent = "Tap Again to Pop Out PiP Window";
      showAlert(
        "Microphone ready! Tap once more to pop out the iOS Picture-in-Picture window."
      );
      return;
    }

    const isCriOS = /CriOS/i.test(navigator.userAgent);
    if (errMsg === "PIP_NOT_SUPPORTED" || errName === "NotSupportedError") {
      connectBtnText.textContent = "Connect Voice (Background Mode)";
      showAlert(
        isCriOS
          ? "Chrome on iOS blocks programmatic PiP. Please open this URL in native iOS Safari!"
          : "PiP not supported in this browser. Use Safari on iOS, or continue below for desktop testing.",
        isCriOS
      );
      fallbackForegroundBtn.classList.remove("hidden");
      return;
    }

    connectBtnText.textContent = "Connect Voice (Background Mode)";
    showAlert(`Setup error: ${errMsg}`, true);
  }

  function onPipReadyEstablishWebRTC() {
    clearAlert();
    fallbackForegroundBtn.classList.add("hidden");
    identityGroup.classList.add("hidden");
    connectBtn.classList.add("connected");
    connectBtn.disabled = true;
    connectBtnText.textContent = isPipActive
      ? `3D Voice Active (ID: ${myRobloxUserId})`
      : `3D Voice Active — Foreground (ID: ${myRobloxUserId})`;
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
  // WebSocket Signaling & Location Sync
  // ---------------------------------------------------------------------------
  function connectSignalingServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    isIntentionalDisconnect = false;
    const url = buildSignalingUrl(myRobloxUserId, usernameInput.value.trim());
    log("WS", `Connecting as Roblox UserId=${myRobloxUserId}...`);
    wsStatusVal.textContent = "Connecting";
    wsStatusVal.className = "pill-value warn";

    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      log("WS", "Connected to signaling & 3D spatial server.");
      wsStatusVal.textContent = "Online";
      wsStatusVal.className = "pill-value ok";
      updateGlobalStatus(
        isPipActive ? "3D Background Voice Active" : "3D Voice Connected (No PiP)",
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
      wsStatusVal.textContent = "Offline";
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
        handleLocationsBroadcast(msg.locations);
        return;
      }

      case "welcome": {
        myPeerId = msg.peerId;
        log(
          "Room",
          `Joined as "${msg.username}" (UserId: ${myRobloxUserId}, PeerId: ${myPeerId}). Peers: ${msg.peers.length}`
        );

        for (const remotePeer of msg.peers) {
          registerPeer(remotePeer.peerId, remotePeer.robloxUserId, remotePeer.username);
          await initiateOfferToPeer(remotePeer.peerId);
        }
        renderPeersList();
        break;
      }

      case "peer-joined": {
        log("Room", `Peer joined: ${msg.username} (UserId: ${msg.robloxUserId})`);
        registerPeer(msg.peerId, msg.robloxUserId, msg.username);
        renderPeersList();
        break;
      }

      case "peer-left": {
        removePeer(msg.peerId);
        renderPeersList();
        break;
      }

      case "offer": {
        await handleIncomingOffer(msg.sender, msg.robloxUserId, msg.username, msg.sdp);
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
  // WebRTC Peer Connection Management
  // ---------------------------------------------------------------------------
  function registerPeer(peerId, robloxUserId, username) {
    if (!peers.has(peerId)) {
      peers.set(peerId, {
        robloxUserId: robloxUserId || "",
        username: username || `Player_${peerId.slice(0, 4)}`,
        pc: null,
        iceQueue: [],
        audioEl: null,
        sourceNode: null,
        pannerNode: null,
        gainNode: null,
        state: "connecting",
        spatialSummary: "Awaiting Roblox 3D coords...",
      });
    } else {
      const existing = peers.get(peerId);
      if (robloxUserId) existing.robloxUserId = robloxUserId;
      if (username) existing.username = username;
    }
    return peers.get(peerId);
  }

  function getOrCreatePeerConnection(peerId, robloxUserId, username) {
    const peerInfo = registerPeer(peerId, robloxUserId, username);
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
      renderPeersList();
    };

    // Route incoming WebRTC audio through our 3D HRTF PannerNode pipeline!
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
      log("WebRTC", `Offer failed (${peerId}): ${err.message}`);
    }
  }

  async function handleIncomingOffer(senderId, senderUserId, senderUsername, sdp) {
    try {
      const peerInfo = registerPeer(senderId, senderUserId, senderUsername);
      const pc = getOrCreatePeerConnection(senderId, senderUserId, senderUsername);

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushQueuedIceCandidates(peerInfo);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: "answer", target: senderId, sdp: pc.localDescription });
      renderPeersList();
    } catch (err) {
      log("WebRTC", `Offer handling error (${senderId}): ${err.message}`);
    }
  }

  async function handleIncomingAnswer(senderId, sdp) {
    try {
      const peerInfo = peers.get(senderId);
      if (!peerInfo || !peerInfo.pc) return;
      await peerInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushQueuedIceCandidates(peerInfo);
    } catch (err) {
      log("WebRTC", `Answer handling error (${senderId}): ${err.message}`);
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
    renderPeersList();
  }

  // ---------------------------------------------------------------------------
  // Session Controls
  // ---------------------------------------------------------------------------
  function toggleMute() {
    if (!localAudioStream) return;
    isMicMuted = !isMicMuted;
    for (const track of localAudioStream.getAudioTracks()) {
      track.enabled = !isMicMuted;
    }
    muteBtn.classList.toggle("muted-active", isMicMuted);
    muteBtnText.textContent = isMicMuted ? "Unmute Mic" : "Mute Mic";
    micStateText.textContent = isMicMuted ? "Muted" : "Live";
  }

  async function reopenPipWindow() {
    if (!combinedPipStream) return;
    try {
      if (pipVideo.paused) await pipVideo.play();
      await enterPictureInPicture(pipVideo);
      updatePipUiState(true);
    } catch (err) {
      showAlert(`Could not re-open PiP: ${err.message}`, true);
    }
  }

  async function disconnectSession() {
    isIntentionalDisconnect = true;
    awaitingSecondTapForPiP = false;
    isMicMuted = false;
    latestLocations = {};

    clearInterval(wsHeartbeatInterval);
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
      ws = null;
    }
    cleanupAllPeers();

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

    isKeepAliveActive = false;
    cancelAnimationFrame(rafId);
    cancelAnimationFrame(meterRafId);
    clearInterval(backgroundTickInterval);

    canvasVideoStream?.getTracks().forEach((t) => t.stop());
    localAudioStream?.getTracks().forEach((t) => t.stop());
    canvasVideoStream = null;
    localAudioStream = null;
    combinedPipStream = null;
    pipVideo.srcObject = null;

    myPeerId = null;
    wsStatusVal.textContent = "Offline";
    wsStatusVal.className = "pill-value";
    spatialStatusVal.textContent = "Waiting";
    spatialStatusVal.className = "pill-value mono";
    micStateText.textContent = "Inactive";
    micMeterBar.style.width = "0%";
    muteBtn.classList.remove("muted-active");
    muteBtnText.textContent = "Mute Mic";
    updatePipUiState(false);
    updateGlobalStatus("Ready to Connect", "");

    sessionControls.classList.add("hidden");
    fallbackForegroundBtn.classList.add("hidden");
    identityGroup.classList.remove("hidden");
    connectBtn.classList.remove("connected");
    connectBtn.disabled = false;
    connectBtnText.textContent = "Connect Voice (Background Mode)";
    clearAlert();
    renderPeersList();
  }

  connectBtn.addEventListener("click", startPipHackAndConnect);
  fallbackForegroundBtn.addEventListener("click", onPipReadyEstablishWebRTC);
  muteBtn.addEventListener("click", toggleMute);
  reopenPipBtn.addEventListener("click", reopenPipWindow);
  disconnectBtn.addEventListener("click", disconnectSession);
})();
