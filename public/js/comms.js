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
    let partnerName = 'Amor';
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
    let partnerExternalMode = false;
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
    let whatsappMode = false;
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
        voiceGainNode.gain.value = whatsappMode ? 0 : voiceVolume;
        if (remoteAudio) {
          remoteAudio.muted = true;
        }
        return;
      }

      if (remoteAudio) {
        remoteAudio.muted = Boolean(whatsappMode);
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
        if (!autoDuckEnabled || whatsappMode || !analyserNode || !analyserData) {
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
        whatsappModeBtn,
        callStatusBadge,
        callPipOverlay,
        remotePlaceholder,
        remoteInitial,
        remoteExternalBadge,
        localVideo,
        hudPartnerVoiceBadge
      } = elements;

      if (toggleMicBtn) {
        toggleMicBtn.setAttribute('aria-pressed', String(micActive && !whatsappMode));
        toggleMicBtn.disabled = whatsappMode;
      }
      if (micOnIcon) micOnIcon.hidden = !(micActive && !whatsappMode);
      if (micOffIcon) micOffIcon.hidden = micActive && !whatsappMode;
      if (micBtnLabel) micBtnLabel.textContent = micActive && !whatsappMode ? 'Mic On' : 'Mic';

      if (toggleCamBtn) {
        toggleCamBtn.setAttribute('aria-pressed', String(camActive));
      }
      if (camBtnLabel) camBtnLabel.textContent = camActive ? 'Cam On' : 'Câmera';

      if (whatsappModeBtn) {
        whatsappModeBtn.setAttribute('aria-pressed', String(whatsappMode));
      }

      if (remoteInitial) {
        remoteInitial.textContent = (partnerName || 'A').trim().charAt(0).toUpperCase() || 'A';
      }
      if (remoteExternalBadge) {
        remoteExternalBadge.hidden = !partnerExternalMode;
      }
      if (hudPartnerVoiceBadge) {
        if (whatsappMode || partnerExternalMode) {
          hudPartnerVoiceBadge.textContent = 'Ligação externa 📱';
          hudPartnerVoiceBadge.hidden = false;
        } else {
          hudPartnerVoiceBadge.hidden = true;
        }
      }

      if (remotePlaceholder) {
        const hasLiveTrack =
          remoteStream && remoteStream.getVideoTracks().some((t) => t.readyState === 'live');
        remotePlaceholder.hidden = Boolean(hasLiveTrack);
      }

      if (localVideo) {
        localVideo.hidden = !camActive;
      }

      const showPip = Boolean(
        camActive || remoteLiveVideo || partnerHasAudio || partnerMicActive || micActive || partnerExternalMode
      );
      if (callPipOverlay) {
        callPipOverlay.hidden = !showPip;
      }

      if (callStatusBadge) {
        callStatusBadge.classList.remove('is-live');
        if (whatsappMode) {
          callStatusBadge.textContent = 'Modo WhatsApp/FaceTime ativo (WebRTC mudo)';
        } else if (!partnerConnected) {
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
        micActive: micActive && !whatsappMode,
        camActive,
        externalCallMode: whatsappMode
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
        if (payload && typeof payload.externalCallMode === 'boolean') {
          partnerExternalMode = payload.externalCallMode;
        }
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
      if (whatsappMode) {
        onToast?.('Desative o Modo WhatsApp/FaceTime para usar o microfone aqui.', false);
        return;
      }

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

    async function setWhatsappMode(enabled) {
      whatsappMode = Boolean(enabled);
      if (whatsappMode) {
        // Fully release hardware mic track so FaceTime/WhatsApp on iPhone is never disrupted
        if (localAudioTrack) {
          localAudioTrack.stop();
          localAudioTrack = null;
        }
        if (audioTransceiver) {
          audioTransceiver.direction = 'recvonly';
          await audioTransceiver.sender.replaceTrack(null).catch(() => {});
          scheduleRenegotiation();
        }
        micActive = false;
        currentDuckFactor = 1.0;
        player.setDuckFactor(1.0);
        setSpeakingIndicator(false);
      }
      syncRemoteAudioRouting();
      updateCallUi();
      broadcastCallState();
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
      myName = displayName || (role === 'host' ? 'Lucas' : 'Amor');
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
        partnerExternalMode = false;
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

    elements.toggleMicBtn?.addEventListener('click', () => {
      toggleMic();
    });

    elements.toggleCamBtn?.addEventListener('click', () => {
      toggleCamera();
    });

    elements.whatsappModeBtn?.addEventListener('click', () => {
      setWhatsappMode(!whatsappMode);
    });

    elements.pipCollapseBtn?.addEventListener('click', () => {
      elements.callPipOverlay?.classList.toggle('is-collapsed');
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
      setMovieVolumePercent,
      setVoiceVolumePercent
    };
  }

  global.PaeStreamComms = {
    createCommsController
  };
})(window);
