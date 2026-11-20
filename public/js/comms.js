(function (global) {
  'use strict';

  function createCommsController(options) {
    const {
      contract,
      player,
      elements,
      emitSocket,
      onToast
    } = options;

    const { SOCKET_EVENTS, ENDPOINTS } = contract;

    let role = 'guest';
    let myName = '';
    let partnerName = 'Convidado';
    let partnerConnected = false;
    let joined = false;

    // WebRTC state
    let pc = null;
    let audioTransceiver = null;
    let videoTransceiver = null;
    let localAudioTrack = null;
    let localVideoTrack = null;
    let localPreviewStream = null;
    let remoteStream = null;
    let makingOffer = false;
    let ignoreOffer = false;
    let isSettingRemoteAnswerPending = false;
    let iceCandidateQueue = [];
    let partnerMicActive = false;
    let partnerHasVideo = false;
    let partnerHasAudio = false;
    let rtcConfig = null;
    let rtcConfigPromise = null;
    let pcPromise = null;
    let signalQueue = Promise.resolve();
    let hasTurnRelay = false;
    let lastConnectionToastAt = 0;
    let renegotiateTimer = null;

    // Audio / Ducking state
    let audioCtx = null;
    let remoteSourceNode = null;
    let analyserNode = null;
    let analyserData = null;
    let voiceGainNode = null;
    let usingWebAudioForVoice = false;
    let duckCloneTrack = null;

    let micActive = false;
    let camActive = false;
    let movieVolume = 1.0;
    let voiceVolume = 1.0;
    let autoDuckEnabled = true;
    let currentDuckFactor = 1.0;
    let lastSpeechAt = 0;
    let duckTimer = null;

    const FALLBACK_RTC_CONFIG = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 4
    };

    async function loadRtcConfig() {
      if (rtcConfig) return rtcConfig;
      if (rtcConfigPromise) return rtcConfigPromise;

      rtcConfigPromise = (async () => {
        try {
          const endpoint = (ENDPOINTS && ENDPOINTS.WEBRTC_ICE) || '/api/webrtc-ice';
          const res = await fetch(endpoint, { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!data || !Array.isArray(data.iceServers) || data.iceServers.length === 0) {
            throw new Error('iceServers vazio');
          }
          hasTurnRelay = Boolean(data.hasTurn);
          rtcConfig = {
            iceServers: data.iceServers,
            iceCandidatePoolSize: 4
          };
          return rtcConfig;
        } catch (_err) {
          hasTurnRelay = false;
          rtcConfig = { ...FALLBACK_RTC_CONFIG };
          return rtcConfig;
        } finally {
          rtcConfigPromise = null;
        }
      })();

      return rtcConfigPromise;
    }

    function ensureAudioContext() {
      const AudioContextCtor = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextCtor) return null;
      if (!audioCtx) {
        audioCtx = new AudioContextCtor();
        audioCtx.onstatechange = () => {
          syncRemoteAudioRouting();
        };
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    }

    function unlockAudio() {
      const ctx = ensureAudioContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      if (elements.remoteVideo && elements.remoteVideo.srcObject) {
        elements.remoteVideo.muted = true;
        elements.remoteVideo.play().catch(() => {});
      }
      if (elements.remoteAudio && elements.remoteAudio.srcObject) {
        elements.remoteAudio.play().catch(() => {});
      }
      if (remoteStream) {
        bindRemoteMedia(remoteStream);
      } else {
        syncRemoteAudioRouting();
      }
    }

    function syncRemoteAudioRouting() {
      const remoteVideo = elements.remoteVideo;
      const remoteAudio = elements.remoteAudio;
      // Video tile must stay muted so autoplay of remote camera is allowed.
      if (remoteVideo) remoteVideo.muted = true;

      if (usingWebAudioForVoice && voiceGainNode && audioCtx && audioCtx.state === 'running') {
        voiceGainNode.gain.value = voiceVolume;
        if (remoteAudio) {
          remoteAudio.muted = true;
        }
        return;
      }

      if (remoteAudio) {
        remoteAudio.muted = false;
        try {
          remoteAudio.volume = Math.max(0, Math.min(1, voiceVolume));
        } catch (_err) {
          // Safe no-op on iOS
        }
        remoteAudio.play().catch(() => {});
      }
    }

    function teardownDuckAnalyser() {
      if (remoteSourceNode) {
        try {
          remoteSourceNode.disconnect();
        } catch (_e) {}
        remoteSourceNode = null;
      }
      if (analyserNode) {
        try {
          analyserNode.disconnect();
        } catch (_e) {}
        analyserNode = null;
      }
      if (voiceGainNode) {
        try {
          voiceGainNode.disconnect();
        } catch (_e) {}
        voiceGainNode = null;
      }
      if (duckCloneTrack) {
        try {
          duckCloneTrack.stop();
        } catch (_e) {}
        duckCloneTrack = null;
      }
      usingWebAudioForVoice = false;
      analyserData = null;
    }

    function setupDuckAnalyser(audioTrack) {
      teardownDuckAnalyser();
      if (!audioTrack) return;

      const ctx = ensureAudioContext();
      if (!ctx) return;

      try {
        duckCloneTrack = audioTrack.clone();
        const duckStream = new MediaStream([duckCloneTrack]);
        remoteSourceNode = ctx.createMediaStreamSource(duckStream);
        analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 512;
        analyserNode.smoothingTimeConstant = 0.78;
        analyserData = new Uint8Array(analyserNode.fftSize);
        remoteSourceNode.connect(analyserNode);
        // Analyser only — playback goes through <audio id="remoteAudio">.
      } catch (_err) {
        teardownDuckAnalyser();
      }
    }

    function bindRemoteMedia(stream) {
      if (!stream) return;
      remoteStream = stream;

      const remoteVideo = elements.remoteVideo;
      if (remoteVideo) {
        if (remoteVideo.srcObject !== stream) {
          remoteVideo.srcObject = stream;
        }
        remoteVideo.muted = true;
        remoteVideo.play().catch(() => {});
      }

      const audioTracks = stream.getAudioTracks().filter((t) => t.readyState !== 'ended');
      const remoteAudio = elements.remoteAudio;
      if (remoteAudio) {
        if (audioTracks.length > 0) {
          const audioOnly = new MediaStream(audioTracks);
          remoteAudio.srcObject = audioOnly;
          syncRemoteAudioRouting();
          remoteAudio.play().catch(() => {});
          setupDuckAnalyser(audioTracks[0]);
          startDuckingMonitor();
        } else {
          remoteAudio.srcObject = null;
          teardownDuckAnalyser();
        }
      }
    }

    function startDuckingMonitor() {
      if (duckTimer) return;
      duckTimer = setInterval(() => {
        if (!autoDuckEnabled || !analyserNode || !analyserData) {
          if (currentDuckFactor !== 1.0) {
            currentDuckFactor = 1.0;
            player.setDuckFactor(1.0);
          }
          setSpeakingIndicator(false);
          return;
        }

        analyserNode.getByteTimeDomainData(analyserData);
        let sumSq = 0;
        for (let i = 0; i < analyserData.length; i += 1) {
          const normalized = (analyserData[i] - 128) / 128;
          sumSq += normalized * normalized;
        }
        const rms = Math.sqrt(sumSq / analyserData.length);
        const now = Date.now();
        if (rms > 0.022) {
          lastSpeechAt = now;
        }
        const isSpeaking = now - lastSpeechAt < 650;
        setSpeakingIndicator(isSpeaking);

        const targetDuck = isSpeaking ? 0.28 : 1.0;
        const step = isSpeaking ? 0.45 : 0.16;
        currentDuckFactor = currentDuckFactor + (targetDuck - currentDuckFactor) * step;
        if (Math.abs(1.0 - currentDuckFactor) < 0.01 && !isSpeaking) {
          currentDuckFactor = 1.0;
        }
        player.setDuckFactor(currentDuckFactor);
      }, 65);
    }

    function setSpeakingIndicator(active) {
      if (elements.callPipOverlay) {
        elements.callPipOverlay.classList.toggle('is-speaking', Boolean(active));
      }
      if (elements.remoteSpeakingDot) {
        elements.remoteSpeakingDot.hidden = !active;
      }
    }

    function updateCallUi() {
      const {
        toggleMicBtn,
        micOnIcon,
        micOffIcon,
        micBtnLabel,
        toggleCamBtn,
        camBtnLabel,
        callStatusBadge,
        callPipOverlay,
        remotePlaceholder,
        remoteInitial,
        localVideo
      } = elements;

      if (toggleMicBtn) {
        toggleMicBtn.setAttribute('aria-pressed', String(micActive));
        toggleMicBtn.disabled = false;
      }
      if (micOnIcon) micOnIcon.hidden = !micActive;
      if (micOffIcon) micOffIcon.hidden = micActive;
      if (micBtnLabel) micBtnLabel.textContent = micActive ? 'Mic On' : 'Mic';

      if (toggleCamBtn) {
        toggleCamBtn.setAttribute('aria-pressed', String(camActive));
      }
      if (camBtnLabel) camBtnLabel.textContent = camActive ? 'Cam On' : 'Câmera';

      if (remoteInitial) {
        remoteInitial.textContent = (partnerName || 'C').trim().charAt(0).toUpperCase() || 'C';
      }

      // A remote video track only carries an image while it is live AND unmuted (receiving frames).
      const remoteLiveVideo = Boolean(
        remoteStream &&
          remoteStream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted)
      );

      if (remotePlaceholder) {
        remotePlaceholder.hidden = remoteLiveVideo;
      }

      if (localVideo) {
        localVideo.hidden = !camActive;
      }

      const showPip = Boolean(
        camActive || micActive || partnerMicActive || partnerHasAudio || partnerHasVideo || remoteLiveVideo
      );
      if (callPipOverlay) {
        const wasHidden = callPipOverlay.hidden;
        callPipOverlay.hidden = !showPip;
        if (showPip && wasHidden && pipLayout) {
          applyPipLayout();
        }
      }

      if (callStatusBadge) {
        callStatusBadge.classList.remove('is-live');
        if (!partnerConnected) {
          callStatusBadge.textContent = 'Aguardando outra pessoa entrar...';
        } else if (pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) {
          callStatusBadge.textContent = 'Conectado • voz e vídeo prontos';
          callStatusBadge.classList.add('is-live');
        } else if (pc && (pc.connectionState === 'connecting' || pc.iceConnectionState === 'checking')) {
          callStatusBadge.textContent = 'Conectando voz/câmera...';
        } else if (pc && (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed')) {
          callStatusBadge.textContent = hasTurnRelay
            ? 'Falha na conexão P2P — tente mic/câmera de novo'
            : 'Falha P2P — configure TURN (regiões distintas)';
        } else {
          callStatusBadge.textContent = hasTurnRelay
            ? 'Voz pronta (TURN ativo)'
            : 'Voz pronta (só STUN — TURN recomendado)';
        }
      }
    }

    function sendWebRtcSignal(type, payload) {
      emitSocket(SOCKET_EVENTS.WEBRTC_SIGNAL, { type, payload });
    }

    function broadcastCallState() {
      sendWebRtcSignal('call-state', {
        ready: true,
        micActive,
        camActive
      });
    }

    function describeLocalSdp(desc) {
      if (!desc) return null;
      return { type: desc.type, sdp: desc.sdp };
    }

    function scheduleRenegotiation() {
      if (renegotiateTimer) clearTimeout(renegotiateTimer);
      renegotiateTimer = setTimeout(() => {
        renegotiateTimer = null;
        triggerRenegotiationIfNeeded().catch(() => {});
      }, 50);
    }

    function wirePeerConnection(peer) {
      audioTransceiver = peer.addTransceiver('audio', { direction: 'recvonly' });
      videoTransceiver = peer.addTransceiver('video', { direction: 'recvonly' });

      remoteStream = new MediaStream();
      bindRemoteMedia(remoteStream);

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          sendWebRtcSignal(
            'candidate',
            event.candidate.toJSON ? event.candidate.toJSON() : event.candidate
          );
        }
      };

      peer.onnegotiationneeded = () => {
        if (!joined || !partnerConnected || !pc || pc !== peer) return;
        scheduleRenegotiation();
      };

      peer.ontrack = (event) => {
        if (!remoteStream) {
          remoteStream = new MediaStream();
        }
        const track = event.track;
        const already = remoteStream.getTracks().some((t) => t.id === track.id);
        if (!already) {
          remoteStream.addTrack(track);
        }

        if (track.kind === 'audio') {
          partnerHasAudio = true;
          track.onunmute = () => {
            partnerHasAudio = true;
            updateCallUi();
          };
          track.onmute = () => {
            updateCallUi();
          };
        } else if (track.kind === 'video') {
          partnerHasVideo = true;
          track.onunmute = () => {
            partnerHasVideo = true;
            updateCallUi();
          };
          track.onmute = () => {
            updateCallUi();
          };
        }

        track.onended = () => {
          if (remoteStream) {
            try {
              remoteStream.removeTrack(track);
            } catch (_e) {}
          }
          if (track.kind === 'video') partnerHasVideo = false;
          if (track.kind === 'audio') partnerHasAudio = false;
          bindRemoteMedia(remoteStream);
          updateCallUi();
        };

        bindRemoteMedia(remoteStream);
        updateCallUi();
      };

      peer.onconnectionstatechange = () => {
        if (!pc || pc !== peer) return;
        if (peer.connectionState === 'failed') {
          try {
            peer.restartIce?.();
          } catch (_err) {
            // ignore
          }
          const now = Date.now();
          if (now - lastConnectionToastAt > 8000) {
            lastConnectionToastAt = now;
            onToast?.(
              hasTurnRelay
                ? 'Conexão de voz/câmera falhou. Tente desligar e ligar mic/câmera.'
                : 'Conexão de voz/câmera falhou entre regiões. Configure um servidor TURN (veja README).',
              true
            );
          }
        }
        updateCallUi();
      };

      peer.oniceconnectionstatechange = () => {
        updateCallUi();
      };
    }

    function closePeerConnection() {
      if (pc) {
        try {
          pc.onicecandidate = null;
          pc.onnegotiationneeded = null;
          pc.ontrack = null;
          pc.onconnectionstatechange = null;
          pc.oniceconnectionstatechange = null;
          pc.close();
        } catch (_err) {
          // ignore
        }
      }
      pc = null;
      audioTransceiver = null;
      videoTransceiver = null;
      iceCandidateQueue = [];
      makingOffer = false;
      ignoreOffer = false;
      isSettingRemoteAnswerPending = false;
      partnerHasAudio = false;
      // Keep partnerHasVideo from call-state until tracks return
    }

    async function ensurePeerConnection() {
      if (pc) return pc;
      if (pcPromise) return pcPromise;
      if (typeof global.RTCPeerConnection === 'undefined') {
        onToast?.('WebRTC não disponível neste navegador.', true);
        return null;
      }

      pcPromise = (async () => {
        const config = await loadRtcConfig();
        if (pc) return pc;
        pc = new global.RTCPeerConnection(config);
        wirePeerConnection(pc);
        return pc;
      })()
        .catch((err) => {
          console.warn('[PaeStream] Falha ao criar RTCPeerConnection:', err);
          return null;
        })
        .finally(() => {
          pcPromise = null;
        });

      return pcPromise;
    }

    async function flushIceCandidates() {
      if (!pc || !pc.remoteDescription) return;
      while (iceCandidateQueue.length > 0) {
        const candidate = iceCandidateQueue.shift();
        try {
          await pc.addIceCandidate(new global.RTCIceCandidate(candidate));
        } catch (_err) {
          if (!ignoreOffer) {
            // Ignore stale candidates
          }
        }
      }
    }

    async function triggerRenegotiationIfNeeded() {
      if (!pc || !joined || !partnerConnected) return;
      if (pc.signalingState !== 'stable') return;
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        const desc = describeLocalSdp(pc.localDescription);
        if (desc) {
          sendWebRtcSignal('offer', desc);
        }
      } catch (_err) {
        // Ignore transient signaling error
      } finally {
        makingOffer = false;
      }
    }

    async function processWebRtcSignal(data) {
      if (!data) return;
      const { type, payload } = data;

      if (type === 'call-state') {
        if (payload && typeof payload.micActive === 'boolean') {
          partnerMicActive = payload.micActive;
        }
        if (payload && typeof payload.camActive === 'boolean') {
          partnerHasVideo = payload.camActive;
        }
        if (payload && payload.ready && partnerConnected) {
          await ensurePeerConnection();
          if (role === 'host') {
            await triggerRenegotiationIfNeeded();
          }
        }
        updateCallUi();
        return;
      }

      const peer = await ensurePeerConnection();
      if (!peer) return;

      const polite = role === 'guest';

      try {
        if (type === 'offer' || type === 'answer') {
          const description = new global.RTCSessionDescription(payload);
          const readyForOffer =
            !makingOffer &&
            (peer.signalingState === 'stable' || isSettingRemoteAnswerPending);
          const offerCollision = description.type === 'offer' && !readyForOffer;

          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) return;

          isSettingRemoteAnswerPending = description.type === 'answer';
          try {
            await peer.setRemoteDescription(description);
          } finally {
            isSettingRemoteAnswerPending = false;
          }
          await flushIceCandidates();

          if (description.type === 'offer') {
            await peer.setLocalDescription();
            const answer = describeLocalSdp(peer.localDescription);
            if (answer) {
              sendWebRtcSignal('answer', answer);
            }
          }
        } else if (type === 'candidate') {
          if (!payload) return;
          if (!peer.remoteDescription) {
            iceCandidateQueue.push(payload);
          } else {
            try {
              await peer.addIceCandidate(new global.RTCIceCandidate(payload));
            } catch (err) {
              if (!ignoreOffer) throw err;
            }
          }
        }
      } catch (err) {
        console.warn('[PaeStream] WebRTC signal handling error:', err);
      }
    }

    function handleWebRtcSignal(data) {
      signalQueue = signalQueue
        .then(() => processWebRtcSignal(data))
        .catch((err) => {
          console.warn('[PaeStream] WebRTC queue error:', err);
        });
      return signalQueue;
    }

    async function toggleMic() {
      ensureAudioContext();
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        onToast?.('Microfone indisponível neste navegador (precisa de HTTPS ou localhost).', true);
        return;
      }
      const peer = await ensurePeerConnection();

      if (!micActive) {
        if (localAudioTrack && localAudioTrack.readyState === 'live') {
          localAudioTrack.enabled = true;
          micActive = true;
        } else {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
              }
            });
            localAudioTrack = stream.getAudioTracks()[0] || null;
            if (localAudioTrack && peer && audioTransceiver) {
              audioTransceiver.direction = 'sendrecv';
              await audioTransceiver.sender.replaceTrack(localAudioTrack);
              micActive = true;
              scheduleRenegotiation();
            }
          } catch (_err) {
            onToast?.('Não foi possível acessar o microfone. Verifique a permissão.', true);
            micActive = false;
          }
        }
      } else {
        if (localAudioTrack) {
          localAudioTrack.enabled = false;
        }
        micActive = false;
      }

      updateCallUi();
      broadcastCallState();
    }

    async function toggleCamera() {
      ensureAudioContext();
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        onToast?.('Câmera indisponível neste navegador (precisa de HTTPS ou localhost).', true);
        return;
      }
      const peer = await ensurePeerConnection();

      if (!camActive) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'user',
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 24 }
            }
          });
          localVideoTrack = stream.getVideoTracks()[0] || null;
          if (!localVideoTrack || !peer || !videoTransceiver) {
            if (localVideoTrack) {
              localVideoTrack.stop();
              localVideoTrack = null;
            }
            onToast?.('Não foi possível publicar a câmera na chamada.', true);
            camActive = false;
          } else {
            localPreviewStream = new MediaStream([localVideoTrack]);
            if (elements.localVideo) {
              elements.localVideo.srcObject = localPreviewStream;
              elements.localVideo.play().catch(() => {});
            }
            videoTransceiver.direction = 'sendrecv';
            await videoTransceiver.sender.replaceTrack(localVideoTrack);
            camActive = true;
            scheduleRenegotiation();
          }
        } catch (_err) {
          onToast?.('Não foi possível ativar a câmera. Verifique a permissão.', true);
          camActive = false;
        }
      } else {
        if (localVideoTrack) {
          localVideoTrack.stop();
          localVideoTrack = null;
        }
        if (elements.localVideo) {
          elements.localVideo.srcObject = null;
        }
        if (videoTransceiver) {
          videoTransceiver.direction = 'recvonly';
          await videoTransceiver.sender.replaceTrack(null).catch(() => {});
          scheduleRenegotiation();
        }
        camActive = false;
      }

      updateCallUi();
      broadcastCallState();
    }

    // ---------------------------------------------------------------------
    // Free-floating camera window: drag anywhere + resize from any corner
    // ---------------------------------------------------------------------
    const PIP_STORAGE_KEY = 'paestream_camera_pip_v1';
    const PIP_MARGIN = 6;
    const PIP_MIN_W = 96;
    const PIP_MIN_H = 68;
    const PIP_COLLAPSED = 48;
    let pipLayout = null; // { width, height, anchorX, anchorY } — anchors in [0, 1]

    function clampNum(value, min, max) {
      if (max < min) return min;
      return Math.min(max, Math.max(min, value));
    }

    function clamp01(value) {
      return clampNum(Number(value) || 0, 0, 1);
    }

    function getStageSize() {
      const stage = elements.playerStage;
      if (!stage) return null;
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (!w || !h) return null;
      return { w, h };
    }

    function loadPipLayout() {
      try {
        const raw = global.localStorage.getItem(PIP_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed) return null;
        const values = [parsed.width, parsed.height, parsed.anchorX, parsed.anchorY].map(Number);
        if (!values.every((v) => Number.isFinite(v))) return null;
        return {
          width: Math.max(PIP_MIN_W, values[0]),
          height: Math.max(PIP_MIN_H, values[1]),
          anchorX: clamp01(values[2]),
          anchorY: clamp01(values[3])
        };
      } catch (_err) {
        return null;
      }
    }

    function savePipLayout() {
      if (!pipLayout) return;
      try {
        global.localStorage.setItem(PIP_STORAGE_KEY, JSON.stringify(pipLayout));
      } catch (_err) {
        // Ignore storage restrictions
      }
    }

    function layoutFromBox(left, top, boxW, boxH, width, height, size) {
      const freeX = Math.max(0, size.w - PIP_MARGIN * 2 - boxW);
      const freeY = Math.max(0, size.h - PIP_MARGIN * 2 - boxH);
      return {
        width: Math.max(PIP_MIN_W, width),
        height: Math.max(PIP_MIN_H, height),
        anchorX: freeX > 0 ? clamp01((left - PIP_MARGIN) / freeX) : 0,
        anchorY: freeY > 0 ? clamp01((top - PIP_MARGIN) / freeY) : 0
      };
    }

    function captureLayoutFromDom() {
      const overlay = elements.callPipOverlay;
      const stage = elements.playerStage;
      const size = getStageSize();
      if (!overlay || !stage || !size) return null;
      const stageRect = stage.getBoundingClientRect();
      const rect = overlay.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return layoutFromBox(
        rect.left - stageRect.left,
        rect.top - stageRect.top,
        rect.width,
        rect.height,
        rect.width,
        rect.height,
        size
      );
    }

    function applyPipLayout() {
      const overlay = elements.callPipOverlay;
      const size = getStageSize();
      if (!overlay || !pipLayout || !size) return;
      const collapsed = overlay.classList.contains('is-collapsed');
      const width = clampNum(pipLayout.width, PIP_MIN_W, size.w - PIP_MARGIN * 2);
      const height = clampNum(pipLayout.height, PIP_MIN_H, size.h - PIP_MARGIN * 2);
      const boxW = collapsed ? PIP_COLLAPSED : width;
      const boxH = collapsed ? PIP_COLLAPSED : height;
      const freeX = Math.max(0, size.w - PIP_MARGIN * 2 - boxW);
      const freeY = Math.max(0, size.h - PIP_MARGIN * 2 - boxH);
      overlay.style.width = `${Math.round(width)}px`;
      overlay.style.height = `${Math.round(height)}px`;
      overlay.style.left = `${Math.round(PIP_MARGIN + freeX * pipLayout.anchorX)}px`;
      overlay.style.top = `${Math.round(PIP_MARGIN + freeY * pipLayout.anchorY)}px`;
      overlay.style.right = 'auto';
      overlay.style.bottom = 'auto';
    }

    function setupCameraPipInteractions() {
      const overlay = elements.callPipOverlay;
      const stage = elements.playerStage;
      if (!overlay || !stage) return;

      pipLayout = loadPipLayout();
      let gesture = null;

      overlay.addEventListener('pointerdown', (e) => {
        // Never let camera gestures toggle the player HUD underneath.
        e.stopPropagation();
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target.closest('.pip-collapse-btn')) return;
        const handle = e.target.closest('[data-resize]');
        if (handle && overlay.classList.contains('is-collapsed')) return;
        if (!getStageSize()) return;

        const stageRect = stage.getBoundingClientRect();
        const rect = overlay.getBoundingClientRect();
        gesture = {
          id: e.pointerId,
          mode: handle ? handle.dataset.resize : 'move',
          startX: e.clientX,
          startY: e.clientY,
          left: rect.left - stageRect.left,
          top: rect.top - stageRect.top,
          width: rect.width,
          height: rect.height,
          moved: false,
          current: null
        };
        overlay.classList.add('is-interacting');
        try {
          overlay.setPointerCapture(e.pointerId);
        } catch (_err) {
          // ignore
        }
        e.preventDefault();
      });

      overlay.addEventListener('pointermove', (e) => {
        if (!gesture || e.pointerId !== gesture.id) return;
        const size = getStageSize();
        if (!size) return;
        const dx = e.clientX - gesture.startX;
        const dy = e.clientY - gesture.startY;
        if (!gesture.moved && Math.hypot(dx, dy) < 3) return;
        gesture.moved = true;

        let { left, top, width, height } = gesture;
        const mode = gesture.mode;

        if (mode === 'move') {
          left = clampNum(gesture.left + dx, PIP_MARGIN, size.w - PIP_MARGIN - gesture.width);
          top = clampNum(gesture.top + dy, PIP_MARGIN, size.h - PIP_MARGIN - gesture.height);
        } else {
          const right = gesture.left + gesture.width;
          const bottom = gesture.top + gesture.height;
          if (mode.includes('e')) {
            width = clampNum(gesture.width + dx, PIP_MIN_W, size.w - PIP_MARGIN - gesture.left);
          }
          if (mode.includes('w')) {
            width = clampNum(gesture.width - dx, PIP_MIN_W, right - PIP_MARGIN);
            left = right - width;
          }
          if (mode.includes('s')) {
            height = clampNum(gesture.height + dy, PIP_MIN_H, size.h - PIP_MARGIN - gesture.top);
          }
          if (mode.includes('n')) {
            height = clampNum(gesture.height - dy, PIP_MIN_H, bottom - PIP_MARGIN);
            top = bottom - height;
          }
          overlay.style.width = `${Math.round(width)}px`;
          overlay.style.height = `${Math.round(height)}px`;
        }

        overlay.style.left = `${Math.round(left)}px`;
        overlay.style.top = `${Math.round(top)}px`;
        overlay.style.right = 'auto';
        overlay.style.bottom = 'auto';
        gesture.current = { left, top, width, height };
      });

      const endGesture = (e) => {
        if (!gesture || e.pointerId !== gesture.id) return;
        overlay.classList.remove('is-interacting');
        try {
          overlay.releasePointerCapture(e.pointerId);
        } catch (_err) {
          // ignore
        }
        const size = getStageSize();
        if (gesture.moved && gesture.current && size) {
          const c = gesture.current;
          const collapsed = overlay.classList.contains('is-collapsed');
          const keepW = collapsed && pipLayout ? pipLayout.width : c.width;
          const keepH = collapsed && pipLayout ? pipLayout.height : c.height;
          pipLayout = layoutFromBox(c.left, c.top, c.width, c.height, keepW, keepH, size);
          savePipLayout();
          applyPipLayout();
        } else if (!gesture.moved && overlay.classList.contains('is-collapsed')) {
          toggleCameraPipCollapsed();
        }
        gesture = null;
      };
      overlay.addEventListener('pointerup', endGesture);
      overlay.addEventListener('pointercancel', endGesture);

      const relayout = () => {
        if (pipLayout) applyPipLayout();
      };
      if (typeof global.ResizeObserver === 'function') {
        try {
          new global.ResizeObserver(relayout).observe(stage);
        } catch (_err) {
          // ignore
        }
      }
      global.addEventListener('resize', relayout);
      global.addEventListener('orientationchange', relayout);
      document.addEventListener('fullscreenchange', relayout);
      document.addEventListener('webkitfullscreenchange', relayout);
      relayout();
    }

    function toggleCameraPipCollapsed() {
      const overlay = elements.callPipOverlay;
      if (!overlay) return;
      if (!pipLayout && !overlay.classList.contains('is-collapsed')) {
        pipLayout = captureLayoutFromDom();
      }
      overlay.classList.toggle('is-collapsed');
      if (pipLayout) {
        applyPipLayout();
        savePipLayout();
      }
    }

    /**
     * Called when the page returns to the foreground (mobile background / tab switch).
     * Resumes audio graph + media elements and reconciles tracks the OS may have killed.
     */
    function handleAppResume() {
      if (audioCtx && audioCtx.state !== 'running') {
        audioCtx.resume().catch(() => {});
      }
      [elements.remoteVideo, elements.localVideo, elements.remoteAudio].forEach((el) => {
        if (el && el.srcObject) {
          el.play().catch(() => {});
        }
      });

      let changed = false;
      if (localVideoTrack && localVideoTrack.readyState === 'ended') {
        localVideoTrack = null;
        localPreviewStream = null;
        camActive = false;
        if (elements.localVideo) elements.localVideo.srcObject = null;
        if (videoTransceiver) {
          videoTransceiver.direction = 'recvonly';
          videoTransceiver.sender.replaceTrack(null).catch(() => {});
        }
        changed = true;
      }
      if (localAudioTrack && localAudioTrack.readyState === 'ended') {
        localAudioTrack = null;
        micActive = false;
        if (audioTransceiver) {
          audioTransceiver.direction = 'recvonly';
          audioTransceiver.sender.replaceTrack(null).catch(() => {});
        }
        changed = true;
      }
      if (changed) {
        scheduleRenegotiation();
        broadcastCallState();
        onToast?.('Câmera/microfone foram pausados pelo sistema. Ative novamente se quiser.', false);
      }
      if (pipLayout) applyPipLayout();
      updateCallUi();
    }

    function setMovieVolumePercent(pct) {
      const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
      movieVolume = clamped / 100;
      player.setMovieVolume(movieVolume);
      if (elements.movieVolumeValue) {
        elements.movieVolumeValue.textContent = `${Math.round(clamped)}%`;
      }
    }

    function setVoiceVolumePercent(pct) {
      const clamped = Math.max(0, Math.min(150, Number(pct) || 0));
      voiceVolume = clamped / 100;
      syncRemoteAudioRouting();
      if (elements.voiceVolumeValue) {
        elements.voiceVolumeValue.textContent = `${Math.round(clamped)}%`;
      }
    }

    function setSessionIdentity(nextRole, displayName) {
      role = nextRole === 'host' ? 'host' : 'guest';
      myName = displayName || (role === 'host' ? 'Lucas' : 'Convidado');
      joined = true;
      loadRtcConfig()
        .then(() => ensurePeerConnection())
        .then(() => {
          updateCallUi();
          broadcastCallState();
        })
        .catch(() => {
          updateCallUi();
          broadcastCallState();
        });
    }

    function updateRoomPresence(state) {
      if (!state) return;
      const wasPartnerConnected = partnerConnected;
      partnerConnected = role === 'host' ? Boolean(state.guestConnected) : Boolean(state.hostConnected);

      if (Array.isArray(state.users)) {
        const partner = state.users.find((u) => u && u.role !== role);
        if (partner && partner.displayName) {
          partnerName = partner.displayName;
        }
      }

      if (!partnerConnected && wasPartnerConnected) {
        partnerMicActive = false;
        partnerHasVideo = false;
        partnerHasAudio = false;
      }

      if (partnerConnected && !wasPartnerConnected && joined) {
        ensurePeerConnection()
          .then(() => {
            broadcastCallState();
            scheduleRenegotiation();
          })
          .catch(() => {});
      }

      updateCallUi();
    }

    // Wire UI events
    startDuckingMonitor();
    setupCameraPipInteractions();

    elements.toggleMicBtn?.addEventListener('click', () => {
      toggleMic();
    });

    elements.toggleCamBtn?.addEventListener('click', () => {
      toggleCamera();
    });

    elements.pipCollapseBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCameraPipCollapsed();
    });

    elements.movieVolumeSlider?.addEventListener('input', (e) => {
      setMovieVolumePercent(e.target.value);
    });

    elements.voiceVolumeSlider?.addEventListener('input', (e) => {
      setVoiceVolumePercent(e.target.value);
    });

    elements.autoDuckToggle?.addEventListener('change', (e) => {
      autoDuckEnabled = Boolean(e.target.checked);
      if (!autoDuckEnabled) {
        currentDuckFactor = 1.0;
        player.setDuckFactor(1.0);
        setSpeakingIndicator(false);
      }
    });

    return {
      unlockAudio,
      setSessionIdentity,
      updateRoomPresence,
      handleWebRtcSignal,
      handleAppResume,
      setMovieVolumePercent,
      setVoiceVolumePercent
    };
  }

  global.PaeStreamComms = {
    createCommsController
  };
})(window);
