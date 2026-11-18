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

    const { SOCKET_EVENTS } = contract;

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

    // Audio / Ducking state
    let audioCtx = null;
    let remoteSourceNode = null;
    let analyserNode = null;
    let analyserData = null;
    let voiceGainNode = null;
    let usingWebAudioForVoice = false;

    let micActive = false;
    let camActive = false;
    let whatsappMode = false;
    let movieVolume = 1.0;
    let voiceVolume = 1.0;
    let autoDuckEnabled = true;
    let currentDuckFactor = 1.0;
    let lastSpeechAt = 0;
    let duckTimer = null;

    const RTC_CONFIG = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

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
      // Prime remote video element inside user gesture for Safari iOS
      if (elements.remoteVideo && elements.remoteVideo.srcObject) {
        elements.remoteVideo.play().catch(() => {});
      }
      if (remoteStream && remoteStream.getAudioTracks().length > 0 && !usingWebAudioForVoice) {
        attachRemoteAudioGraph(remoteStream);
      } else {
        syncRemoteAudioRouting();
      }
    }

    function syncRemoteAudioRouting() {
      const remoteVideo = elements.remoteVideo;
      if (!remoteVideo) return;

      if (usingWebAudioForVoice && voiceGainNode && audioCtx && audioCtx.state === 'running') {
        voiceGainNode.gain.value = whatsappMode ? 0 : voiceVolume;
        remoteVideo.muted = true;
      } else {
        remoteVideo.muted = whatsappMode;
        try {
          remoteVideo.volume = Math.max(0, Math.min(1, voiceVolume));
        } catch (_err) {
          // Safe no-op on iOS
        }
      }
    }

    function attachRemoteAudioGraph(stream) {
      if (!stream) return;
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        usingWebAudioForVoice = false;
        return;
      }

      const ctx = ensureAudioContext();
      if (!ctx) {
        usingWebAudioForVoice = false;
        syncRemoteAudioRouting();
        return;
      }

      try {
        if (remoteSourceNode) {
          try {
            remoteSourceNode.disconnect();
          } catch (_e) {}
          remoteSourceNode = null;
        }
        remoteSourceNode = ctx.createMediaStreamSource(stream);
        analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 512;
        analyserNode.smoothingTimeConstant = 0.78;
        analyserData = new Uint8Array(analyserNode.fftSize);

        voiceGainNode = ctx.createGain();
        voiceGainNode.gain.value = whatsappMode ? 0 : voiceVolume;

        remoteSourceNode.connect(analyserNode);
        analyserNode.connect(voiceGainNode);
        voiceGainNode.connect(ctx.destination);

        usingWebAudioForVoice = true;
        syncRemoteAudioRouting();
      } catch (_err) {
        usingWebAudioForVoice = false;
        syncRemoteAudioRouting();
      }
    }

    function startDuckingMonitor() {
      if (duckTimer) return;
      duckTimer = setInterval(() => {
        if (!autoDuckEnabled || whatsappMode || !analyserNode || !analyserData || !usingWebAudioForVoice) {
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

      const remoteLiveVideo =
        remoteStream &&
        remoteStream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted) &&
        partnerHasVideo;

      if (remotePlaceholder) {
        remotePlaceholder.hidden = Boolean(remoteLiveVideo);
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
        } else if (pc && pc.connectionState === 'connected') {
          callStatusBadge.textContent = 'Conectado P2P • voz e vídeo prontos';
          callStatusBadge.classList.add('is-live');
        } else {
          callStatusBadge.textContent = 'Voz WebRTC pronta';
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

    function ensurePeerConnection() {
      if (pc) return pc;
      if (typeof global.RTCPeerConnection === 'undefined') {
        onToast?.('WebRTC não disponível neste navegador.', true);
        return null;
      }

      pc = new global.RTCPeerConnection(RTC_CONFIG);

      audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
      videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });

      remoteStream = new MediaStream();
      if (elements.remoteVideo) {
        elements.remoteVideo.srcObject = remoteStream;
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendWebRtcSignal('candidate', event.candidate);
        }
      };

      pc.onnegotiationneeded = async () => {
        if (!joined || !partnerConnected || !pc) return;
        try {
          makingOffer = true;
          await pc.setLocalDescription();
          if (pc.localDescription) {
            sendWebRtcSignal('offer', pc.localDescription);
          }
        } catch (_err) {
          // Handled by collision/retry on next state change
        } finally {
          makingOffer = false;
        }
      };

      pc.ontrack = (event) => {
        if (!remoteStream) {
          remoteStream = new MediaStream();
        }
        const track = event.track;
        const already = remoteStream.getTracks().some((t) => t.id === track.id);
        if (!already) {
          remoteStream.addTrack(track);
        }

        if (elements.remoteVideo) {
          elements.remoteVideo.srcObject = remoteStream;
          elements.remoteVideo.play().catch(() => {});
        }

        if (track.kind === 'audio') {
          partnerHasAudio = !track.muted;
          track.onunmute = () => {
            partnerHasAudio = true;
            updateCallUi();
          };
          track.onmute = () => {
            partnerHasAudio = false;
            updateCallUi();
          };
          attachRemoteAudioGraph(remoteStream);
          startDuckingMonitor();
        } else if (track.kind === 'video') {
          partnerHasVideo = !track.muted;
          track.onunmute = () => {
            partnerHasVideo = true;
            updateCallUi();
          };
          track.onmute = () => {
            partnerHasVideo = false;
            updateCallUi();
          };
        }

        track.onended = () => {
          if (track.kind === 'video') partnerHasVideo = false;
          if (track.kind === 'audio') partnerHasAudio = false;
          updateCallUi();
        };

        updateCallUi();
      };

      pc.onconnectionstatechange = () => {
        if (!pc) return;
        if (pc.connectionState === 'failed') {
          pc.restartIce?.();
        }
        updateCallUi();
      };

      return pc;
    }

    async function flushIceCandidates() {
      if (!pc || !pc.remoteDescription) return;
      while (iceCandidateQueue.length > 0) {
        const candidate = iceCandidateQueue.shift();
        try {
          await pc.addIceCandidate(candidate);
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
        if (pc.localDescription) {
          sendWebRtcSignal('offer', pc.localDescription);
        }
      } catch (_err) {
        // Ignore transient signaling error
      } finally {
        makingOffer = false;
      }
    }

    async function handleWebRtcSignal(data) {
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
        if (payload && payload.ready && role === 'host' && partnerConnected) {
          ensurePeerConnection();
          triggerRenegotiationIfNeeded();
        }
        updateCallUi();
        return;
      }

      const peer = ensurePeerConnection();
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
          await peer.setRemoteDescription(description);
          isSettingRemoteAnswerPending = false;
          await flushIceCandidates();

          if (description.type === 'offer') {
            await peer.setLocalDescription();
            if (peer.localDescription) {
              sendWebRtcSignal('answer', peer.localDescription);
            }
          }
        } else if (type === 'candidate') {
          if (!payload) return;
          if (!peer.remoteDescription) {
            iceCandidateQueue.push(payload);
          } else {
            try {
              await peer.addIceCandidate(new global.RTCSessionDescription(payload));
            } catch (err) {
              if (!ignoreOffer) throw err;
            }
          }
        }
      } catch (_err) {
        // Resilient against transient SDP collision
      }
    }

    async function toggleMic() {
      if (whatsappMode) {
        onToast?.('Desative o Modo WhatsApp/FaceTime para usar o microfone aqui.', false);
        return;
      }

      ensureAudioContext();
      const peer = ensurePeerConnection();

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
              triggerRenegotiationIfNeeded();
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
      const peer = ensurePeerConnection();

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
          if (localVideoTrack) {
            localPreviewStream = new MediaStream([localVideoTrack]);
            if (elements.localVideo) {
              elements.localVideo.srcObject = localPreviewStream;
              elements.localVideo.play().catch(() => {});
            }
            if (peer && videoTransceiver) {
              videoTransceiver.direction = 'sendrecv';
              await videoTransceiver.sender.replaceTrack(localVideoTrack);
              triggerRenegotiationIfNeeded();
            }
            camActive = true;
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
          triggerRenegotiationIfNeeded();
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
      ensurePeerConnection();
      updateCallUi();
      broadcastCallState();
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

      if (partnerConnected && !wasPartnerConnected && joined) {
        ensurePeerConnection();
        broadcastCallState();
        if (role === 'host') {
          triggerRenegotiationIfNeeded();
        }
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
