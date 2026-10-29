/**
 * Roblox Proximity Voice — WebRTC Client + iOS Safari PiP Canvas Hack
 * ===================================================================
 * Bypasses iOS background browser microphone suspension by combining:
 *   1. A live 1 FPS 1x1 <canvas> video stream (`canvas.captureStream(1)`)
 *   2. The user's `getUserMedia({ audio: true })` microphone track
 * into a single `MediaStream` played inside a Picture-in-Picture `<video>`.
 *
 * Because iOS treats an active Picture-in-Picture media session as foreground
 * media playback, WebKit preserves the page's execution & audio session while
 * the player switches to the Roblox app.
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Configuration (STUN / WebSocket URL)
  // ---------------------------------------------------------------------------
  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      // NOTE FOR PRODUCTION CELLULAR (4G/5G):
      // Strict carrier-grade NATs on mobile networks sometimes block direct P2P STUN.
      // Add a TURN server entry here (e.g. Cloudflare TURN / Metered / Coturn) for 100% reachability.
    ],
  };

  // Automatically switches between ws:// (local dev) and wss:// (Render HTTPS)
  function buildSignalingUrl(username) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const encodedName = encodeURIComponent(username || "Player");
    return `${protocol}//${window.location.host}/ws?username=${encodedName}`;
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
  const usernameInput = document.getElementById("username-input");
  const identityGroup = document.getElementById("identity-group");

  const alertBanner = document.getElementById("alert-banner");
  const globalStatusDot = document.getElementById("global-status-dot");
  const globalStatusLabel = document.getElementById("global-status-label");
  const pipStatusVal = document.getElementById("pip-status-val");
  const wsStatusVal = document.getElementById("ws-status-val");
  const peerIdVal = document.getElementById("peer-id-val");
  const micStateText = document.getElementById("mic-state-text");
  const micMeterBar = document.getElementById("mic-meter-bar");

  const peersListEl = document.getElementById("peers-list");
  const peerCountBadge = document.getElementById("peer-count-badge");
  const remoteAudioContainer = document.getElementById("remote-audio-container");
  const debugLogEl = document.getElementById("debug-log");
  const pipVideo = document.getElementById("pip-video");

  // ---------------------------------------------------------------------------
  // Runtime State
  // ---------------------------------------------------------------------------
  let localAudioStream = null;      // MediaStream from getUserMedia({ audio: true })
  let canvasVideoStream = null;     // MediaStream from canvas.captureStream(1)
  let combinedPipStream = null;     // Combined video + audio MediaStream fed to pipVideo

  let keepAliveCanvas = null;
  let keepAliveCtx = null;
  let isKeepAliveActive = false;
  let rafId = null;
  let backgroundTickInterval = null;

  let audioContext = null;          // Shared AudioContext (unlocked on user tap + drives mic meter)
  let meterRafId = null;

  let ws = null;
  let wsHeartbeatInterval = null;
  let myPeerId = null;
  let isMicMuted = false;
  let isPipActive = false;
  let awaitingSecondTapForPiP = false; // Handles iOS 1st-time mic dialog gesture expiration
  let isIntentionalDisconnect = false;

  /**
   * Active remote peers keyed by `peerId`:
   * {
   *   username: string,
   *   pc: RTCPeerConnection | null,
   *   iceQueue: RTCIceCandidateInit[],
   *   audioEl: HTMLAudioElement | null,
   *   state: string
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
        updateGlobalStatus("Background Voice Active", "online");
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
        ? "Waiting for other players to join the room..."
        : "Not connected. Tap Connect Voice above to join.";
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
      subSpan.textContent = `ID: ${peerId}`;

      meta.appendChild(nameSpan);
      meta.appendChild(subSpan);

      const stateBadge = document.createElement("span");
      const isConnected = info.state === "connected";
      stateBadge.className = `peer-state${isConnected ? " connected" : ""}`;
      stateBadge.textContent = isConnected ? "Voice Live" : info.state || "Signaling";

      li.appendChild(meta);
      li.appendChild(stateBadge);
      peersListEl.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // iOS Safari Audio Session Unlock + Mic Level Visualizer
  // ---------------------------------------------------------------------------
  /**
   * iOS Safari Quirk:
   * Calling `new AudioContext()` + `audioContext.resume()` SYNCHRONOUSLY inside
   * the user's `click` event handler (before the first `await`) unlocks WebKit's
   * audio playback engine for the entire page session—ensuring incoming remote
   * `<audio>` elements can play even when peers join later while backgrounded!
   */
  function unlockIosAudioContextSync() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioContext) {
        audioContext = new AudioCtx();
      }
      if (audioContext.state === "suspended") {
        audioContext.resume();
      }
      // Play a 1-sample silent buffer to bless WebKit audio output hardware
      const silentBuffer = audioContext.createBuffer(1, 1, 22050);
      const source = audioContext.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(audioContext.destination);
      source.start(0);
      log("iOS", "AudioContext unlocked synchronously on user gesture.");
    } catch (err) {
      log("iOS", `AudioContext unlock warning: ${err.message}`);
    }
  }

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
          const pct = Math.min(100, Math.round((avg / 90) * 100));
          micMeterBar.style.width = `${pct}%`;
        }
        meterRafId = requestAnimationFrame(updateMeter);
      };
      meterRafId = requestAnimationFrame(updateMeter);
    } catch (err) {
      log("Audio", `Mic meter skipped: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Picture-in-Picture (PiP) Canvas Hack Implementation
  // ---------------------------------------------------------------------------
  /**
   * Requests Picture-in-Picture across both W3C (`requestPictureInPicture`)
   * and Apple's WebKit-prefixed API (`webkitSetPresentationMode`).
   */
  async function enterPictureInPicture(videoEl) {
    // 1. Standard W3C API (Modern iOS Safari 15+, Desktop Chrome/Edge/Safari, Android)
    if (typeof videoEl.requestPictureInPicture === "function") {
      await videoEl.requestPictureInPicture();
      return true;
    }

    // 2. Legacy / iPadOS / WebKit-prefixed API fallback
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

  /**
   * Executes the exact 7-step PiP Canvas Hack sequence:
   *   a. Request `getUserMedia({ audio: true })`
   *   b. Create `<canvas width="1" height="1">` and fill with black `ctx.fillRect(0, 0, 1, 1)`
   *   c. Continuously draw on the canvas (`requestAnimationFrame` + background `setInterval`)
   *   d. Capture stream: `const videoStream = canvas.captureStream(1)`
   *   e. Combine tracks: `new MediaStream([...videoStream.getTracks(), ...audioStream.getTracks()])`
   *   f. Assign `combinedStream` to hidden `<video playsinline autoplay>`
   *   g. Force PiP: `video.requestPictureInPicture()`
   */
  async function startPipHackAndConnect() {
    clearAlert();

    // Check for HTTPS / localhost (iOS hides navigator.mediaDevices on insecure HTTP LAN URLs)
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showAlert(
        "Microphone & PiP require HTTPS (or localhost). On iPhone/iPad, open your HTTPS Render URL or tunnel localhost via ngrok / cloudflared.",
        true
      );
      log("Error", "Insecure context: navigator.mediaDevices unavailable.");
      return;
    }

    // Unlock iOS WebKit AudioContext synchronously BEFORE any `await`
    unlockIosAudioContextSync();

    // -------------------------------------------------------------------------
    // Recovery Path: If iOS expired the transient user gesture during the 1st-time
    // OS Microphone Permission popup, `pipVideo` is ALREADY loaded and playing!
    // Trigger `requestPictureInPicture()` synchronously on this 2nd tap (0ms delay).
    // -------------------------------------------------------------------------
    if (awaitingSecondTapForPiP && combinedPipStream) {
      try {
        connectBtn.disabled = true;
        log("PiP", "Executing synchronous PiP activation on fresh iOS tap...");
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
      // -----------------------------------------------------------------------
      // Step (a): Request `getUserMedia({ audio: true })`
      // -----------------------------------------------------------------------
      log("Mic", "Requesting getUserMedia({ audio: true })...");
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localAudioStream = audioStream;

      const primaryAudioTrack = audioStream.getAudioTracks()[0];
      if (primaryAudioTrack) {
        micStateText.textContent = "Live";
        // Monitor iOS hardware-level track mute/unmute events for diagnostics
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

      // -----------------------------------------------------------------------
      // Step (b): Create `<canvas width="1" height="1">` and fill with black
      // -----------------------------------------------------------------------
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { alpha: false });

      // Prime first frame BEFORE captureStream() so Safari initializes immediately
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, 1, 1);

      keepAliveCanvas = canvas;
      keepAliveCtx = ctx;
      isKeepAliveActive = true;

      // -----------------------------------------------------------------------
      // Step (c): Continuously draw on the canvas to keep the stream active
      // -----------------------------------------------------------------------
      // iOS Safari Quirk #1: WebKit optimizes away identical pixel writes, so we
      // toggle imperceptibly between #000000 and #010101 on our 1x1 black pixel.
      // iOS Safari Quirk #2: Safari pauses `requestAnimationFrame` when backgrounded
      // (while playing Roblox), so we pair `rAF` with a 1000ms `setInterval` heartbeat!
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

      // -----------------------------------------------------------------------
      // Step (d): Capture canvas at 1 FPS (`canvas.captureStream(1)`)
      // -----------------------------------------------------------------------
      const videoStream = canvas.captureStream(1);
      canvasVideoStream = videoStream;

      // Force an immediate initial frame push so `loadedmetadata` resolves in <5ms
      // instead of waiting 1000ms (preserving Safari's transient user-gesture window!)
      drawKeepAlivePixel();
      const canvasTrack = videoStream.getVideoTracks()[0];
      if (canvasTrack && typeof canvasTrack.requestFrame === "function") {
        try {
          canvasTrack.requestFrame();
        } catch (_) {}
      }

      // -----------------------------------------------------------------------
      // Step (e): Combine video + audio tracks into `combinedStream`
      // -----------------------------------------------------------------------
      const combinedStream = new MediaStream([
        ...videoStream.getTracks(),
        ...audioStream.getTracks(),
      ]);
      combinedPipStream = combinedStream;

      // -----------------------------------------------------------------------
      // Step (f): Assign `combinedStream` to hidden `<video playsinline autoplay>`
      // -----------------------------------------------------------------------
      pipVideo.srcObject = combinedStream;
      pipVideo.muted = true; // Critical: prevents hearing your own mic feedback locally!

      if (pipVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise((resolve) => {
          pipVideo.addEventListener("loadedmetadata", resolve, { once: true });
        });
      }

      await pipVideo.play();
      log("PiP", "Hidden <video> playing combinedStream (1x1 @ 1FPS + mic track).");

      // -----------------------------------------------------------------------
      // Step (g): Force Picture-in-Picture (`video.requestPictureInPicture()`)
      // -----------------------------------------------------------------------
      log("PiP", "Calling video.requestPictureInPicture()...");
      await enterPictureInPicture(pipVideo);

      updatePipUiState(true);
      log("PiP", "Picture-in-Picture active! iOS background mic suspension bypassed.");

      // -----------------------------------------------------------------------
      // Once PiP is active -> Establish WebRTC connection via WebSocket server
      // -----------------------------------------------------------------------
      onPipReadyEstablishWebRTC();
    } catch (err) {
      connectBtn.disabled = false;
      handlePipFailure(err);
    }
  }

  /**
   * Gracefully handles iOS Safari gesture expiration & non-PiP browsers.
   */
  function handlePipFailure(err) {
    const errName = err?.name || "";
    const errMsg = err?.message || String(err);
    log("Warn", `PiP/Setup issue (${errName}): ${errMsg}`);

    // Microphone permission denied by user
    if (!localAudioStream) {
      connectBtnText.textContent = "Connect Voice (Background Mode)";
      showAlert(
        "Microphone permission was denied. Please allow microphone access in Safari Settings and try again.",
        true
      );
      return;
    }

    // iOS Safari Quirk: If the user spent >1s tapping "Allow" on the first-time OS Mic prompt,
    // WebKit expires transient user activation right before `requestPictureInPicture()`.
    // Stream + <video> are now warm—one synchronous tap immediately opens PiP!
    if (errName === "NotAllowedError" || errName === "InvalidAccessError") {
      awaitingSecondTapForPiP = true;
      connectBtnText.textContent = "Tap Again to Pop Out PiP Window";
      showAlert(
        "Microphone ready! iOS requires one more tap after the permission popup to launch the Picture-in-Picture window."
      );
      return;
    }

    // Browser lacks programmatic PiP (e.g. Desktop Firefox or restricted embedded WebView)
    const isCriOS = /CriOS/i.test(navigator.userAgent);
    if (errMsg === "PIP_NOT_SUPPORTED" || errName === "NotSupportedError") {
      connectBtnText.textContent = "Connect Voice (Background Mode)";
      if (isCriOS) {
        showAlert(
          "Chrome on iOS restricts programmatic PiP in WKWebView. Please open this page in native iOS Safari for Background Mode!",
          true
        );
      } else {
        showAlert(
          "Picture-in-Picture is not supported by this browser. For iOS background voice, use Safari. For local desktop testing, you can continue below."
        );
      }
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
      ? "Voice Active — Switch to Roblox!"
      : "Voice Active (Foreground Mode)";
    sessionControls.classList.remove("hidden");

    connectSignalingServer();
  }

  // Listen to both standard W3C PiP events and iOS WebKit presentation mode events
  pipVideo.addEventListener("enterpictureinpicture", () => {
    log("PiP", "Entered Picture-in-Picture window.");
    updatePipUiState(true);
  });

  pipVideo.addEventListener("leavepictureinpicture", () => {
    log("PiP", "Left Picture-in-Picture window.");
    updatePipUiState(false);
  });

  pipVideo.addEventListener("webkitpresentationmodechanged", () => {
    const mode = pipVideo.webkitPresentationMode;
    log("PiP", `WebKit presentation mode changed -> ${mode}`);
    updatePipUiState(mode === "picture-in-picture");
  });

  // Ensure media elements stay playing across iOS app-switch / interruption transitions
  document.addEventListener("visibilitychange", () => {
    log("App", `Visibility changed -> ${document.hidden ? "BACKGROUND (Roblox)" : "FOREGROUND"}`);
    if (combinedPipStream && pipVideo.paused) {
      pipVideo.play().catch(() => {});
    }
    for (const info of peers.values()) {
      if (info.audioEl && info.audioEl.paused) {
        info.audioEl.play().catch(() => {});
      }
    }
  });

  // ---------------------------------------------------------------------------
  // WebSocket Signaling Client (Global Room)
  // ---------------------------------------------------------------------------
  function connectSignalingServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    isIntentionalDisconnect = false;
    const desiredName = usernameInput.value.trim();
    const url = buildSignalingUrl(desiredName);

    log("WS", `Connecting to ${url}...`);
    wsStatusVal.textContent = "Connecting";
    wsStatusVal.className = "pill-value warn";

    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      log("WS", "Signaling WebSocket connected.");
      wsStatusVal.textContent = "Online";
      wsStatusVal.className = "pill-value ok";
      updateGlobalStatus(
        isPipActive ? "Background Voice Active" : "Voice Connected (No PiP)",
        isPipActive ? "online" : "warning"
      );

      // 25s heartbeat keeps Render's load balancer from closing idle WebSockets
      clearInterval(wsHeartbeatInterval);
      wsHeartbeatInterval = setInterval(() => {
        sendSignal({ type: "ping" });
      }, 25000);
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
      log("WS", "WebSocket closed.");

      // Auto-reconnect if session is still active (e.g. brief Wi-Fi / cellular handoff)
      if (!isIntentionalDisconnect && localAudioStream) {
        log("WS", "Reconnecting signaling in 2.5s...");
        setTimeout(() => {
          if (!isIntentionalDisconnect && localAudioStream) {
            cleanupAllPeers();
            connectSignalingServer();
          }
        }, 2500);
      }
    });

    ws.addEventListener("error", () => {
      log("WS", "WebSocket transport error.");
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

      case "welcome": {
        myPeerId = msg.peerId;
        peerIdVal.textContent = myPeerId;
        log("Room", `Joined as "${msg.username}" (${myPeerId}). Existing peers: ${msg.peers.length}`);

        // Deterministic Glare-Free Mesh Rule:
        // As the newcomer, WE create and send SDP Offers to all existing peers.
        for (const remotePeer of msg.peers) {
          registerPeer(remotePeer.peerId, remotePeer.username);
          await initiateOfferToPeer(remotePeer.peerId);
        }
        renderPeersList();
        break;
      }

      case "peer-joined": {
        log("Room", `Peer joined: "${msg.username}" (${msg.peerId}). Waiting for their SDP offer...`);
        registerPeer(msg.peerId, msg.username);
        renderPeersList();
        break;
      }

      case "peer-left": {
        log("Room", `Peer left: ${msg.peerId}`);
        removePeer(msg.peerId);
        renderPeersList();
        break;
      }

      case "offer": {
        await handleIncomingOffer(msg.sender, msg.username, msg.sdp);
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
  // WebRTC Peer-to-Peer Audio Mesh
  // ---------------------------------------------------------------------------
  function registerPeer(peerId, username) {
    if (!peers.has(peerId)) {
      peers.set(peerId, {
        username: username || `Player_${peerId.slice(0, 4)}`,
        pc: null,
        iceQueue: [],
        audioEl: null,
        state: "connecting",
      });
    } else if (username) {
      peers.get(peerId).username = username;
    }
    return peers.get(peerId);
  }

  function getOrCreatePeerConnection(peerId, username) {
    const peerInfo = registerPeer(peerId, username);
    if (peerInfo.pc) return peerInfo.pc;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerInfo.pc = pc;

    // Attach ONLY microphone audio tracks to WebRTC (saves bandwidth—no need to transmit the 1x1 PiP canvas!)
    if (localAudioStream) {
      for (const audioTrack of localAudioStream.getAudioTracks()) {
        pc.addTrack(audioTrack, localAudioStream);
      }
    }

    // Trickle ICE candidates to the remote peer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: "ice-candidate",
          target: peerId,
          candidate: event.candidate,
        });
      }
    };

    // Track connection lifecycle for UI badges
    pc.onconnectionstatechange = () => {
      peerInfo.state = pc.connectionState;
      log("WebRTC", `Peer ${peerId} state -> ${pc.connectionState}`);
      renderPeersList();
    };

    // Receive incoming remote audio stream and play in a standard <audio> element
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      const streamToPlay = remoteStream || new MediaStream([event.track]);
      log("WebRTC", `Received remote audio track from ${peerInfo.username} (${peerId}).`);
      attachRemoteAudioElement(peerId, streamToPlay);
    };

    return pc;
  }

  /**
   * Plays a peer's incoming WebRTC audio stream inside a standard `<audio>` element.
   * (Phase 2 Hook: Later, we will route `remoteStream` through `AudioContext.createPanner()`
   * with `panningModel = 'HRTF'` updated by 3D coordinates from your Roblox server!)
   */
  function attachRemoteAudioElement(peerId, remoteStream) {
    const peerInfo = peers.get(peerId);
    if (!peerInfo) return;

    let audioEl = peerInfo.audioEl;
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `remote-audio-${peerId}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.setAttribute("playsinline", "");
      audioEl.setAttribute("webkit-playsinline", "");
      remoteAudioContainer.appendChild(audioEl);
      peerInfo.audioEl = audioEl;
    }

    if (audioEl.srcObject !== remoteStream) {
      audioEl.srcObject = remoteStream;
    }

    audioEl.play().catch((err) => {
      log("Audio", `Autoplay warning for ${peerId}: ${err.message}`);
    });
  }

  async function initiateOfferToPeer(peerId) {
    try {
      const pc = getOrCreatePeerConnection(peerId);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);

      sendSignal({
        type: "offer",
        target: peerId,
        sdp: pc.localDescription,
      });
      log("WebRTC", `Sent SDP offer -> ${peerId}`);
    } catch (err) {
      log("WebRTC", `Failed creating offer for ${peerId}: ${err.message}`);
    }
  }

  async function handleIncomingOffer(senderId, senderUsername, sdp) {
    try {
      const peerInfo = registerPeer(senderId, senderUsername);
      const pc = getOrCreatePeerConnection(senderId, senderUsername);

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushQueuedIceCandidates(peerInfo);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      sendSignal({
        type: "answer",
        target: senderId,
        sdp: pc.localDescription,
      });
      log("WebRTC", `Accepted offer & sent SDP answer -> ${senderId}`);
      renderPeersList();
    } catch (err) {
      log("WebRTC", `Error handling offer from ${senderId}: ${err.message}`);
    }
  }

  async function handleIncomingAnswer(senderId, sdp) {
    try {
      const peerInfo = peers.get(senderId);
      if (!peerInfo || !peerInfo.pc) return;

      await peerInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushQueuedIceCandidates(peerInfo);
      log("WebRTC", `Received SDP answer <- ${senderId}`);
    } catch (err) {
      log("WebRTC", `Error handling answer from ${senderId}: ${err.message}`);
    }
  }

  async function handleIncomingIceCandidate(senderId, candidateInit) {
    if (!candidateInit) return;
    const peerInfo = registerPeer(senderId);

    // Queue ICE candidates if remoteDescription hasn't finished setting yet
    if (!peerInfo.pc || !peerInfo.pc.remoteDescription) {
      peerInfo.iceQueue.push(candidateInit);
      return;
    }

    try {
      await peerInfo.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
    } catch (err) {
      log("WebRTC", `ICE candidate error (${senderId}): ${err.message}`);
    }
  }

  async function flushQueuedIceCandidates(peerInfo) {
    if (!peerInfo.pc || !peerInfo.pc.remoteDescription) return;
    while (peerInfo.iceQueue.length > 0) {
      const candidateInit = peerInfo.iceQueue.shift();
      try {
        await peerInfo.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch (err) {
        log("WebRTC", `Queued ICE error: ${err.message}`);
      }
    }
  }

  function removePeer(peerId) {
    const peerInfo = peers.get(peerId);
    if (!peerInfo) return;

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
  // Session Controls (Mute, Re-open PiP, Full Disconnect)
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
    log("Mic", isMicMuted ? "Microphone muted." : "Microphone unmuted.");
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
    log("Session", "Disconnecting voice session...");
    isIntentionalDisconnect = true;
    awaitingSecondTapForPiP = false;
    isMicMuted = false;

    // 1. Close WebSocket & Peers
    clearInterval(wsHeartbeatInterval);
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
      ws = null;
    }
    cleanupAllPeers();

    // 2. Exit Picture-in-Picture if open
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

    // 3. Stop Canvas keep-alive loops & tracks
    isKeepAliveActive = false;
    cancelAnimationFrame(rafId);
    cancelAnimationFrame(meterRafId);
    clearInterval(backgroundTickInterval);

    if (canvasVideoStream) {
      canvasVideoStream.getTracks().forEach((t) => t.stop());
      canvasVideoStream = null;
    }
    if (localAudioStream) {
      localAudioStream.getTracks().forEach((t) => t.stop());
      localAudioStream = null;
    }
    combinedPipStream = null;
    pipVideo.srcObject = null;

    // 4. Reset UI
    myPeerId = null;
    peerIdVal.textContent = "—";
    wsStatusVal.textContent = "Offline";
    wsStatusVal.className = "pill-value";
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

  // ---------------------------------------------------------------------------
  // Event Listeners
  // ---------------------------------------------------------------------------
  connectBtn.addEventListener("click", startPipHackAndConnect);
  fallbackForegroundBtn.addEventListener("click", () => {
    log("Mode", "Continuing in desktop/foreground mode without PiP.");
    onPipReadyEstablishWebRTC();
  });
  muteBtn.addEventListener("click", toggleMute);
  reopenPipBtn.addEventListener("click", reopenPipWindow);
  disconnectBtn.addEventListener("click", disconnectSession);
})();
