(function (global) {
  'use strict';

  const CONTRACT = global.PAESTREAM_CONTRACT;
  if (!CONTRACT) {
    console.error('[PaeStream] PAESTREAM_CONTRACT não carregado.');
    return;
  }

  const { ENDPOINTS, SOCKET_EVENTS } = CONTRACT;

  const dom = {
    entryOverlay: document.getElementById('entryOverlay'),
    entryForm: document.getElementById('entryForm'),
    entryRoleBadge: document.getElementById('entryRoleBadge'),
    entryMovieHint: document.getElementById('entryMovieHint'),
    displayNameInput: document.getElementById('displayNameInput'),
    enterCinemaBtn: document.getElementById('enterCinemaBtn'),

    roomTitle: document.getElementById('roomTitle'),
    connectionPill: document.getElementById('connectionPill'),
    connectionLabel: document.getElementById('connectionLabel'),
    openLibraryBtn: document.getElementById('openLibraryBtn'),
    openInviteBtn: document.getElementById('openInviteBtn'),

    playerStage: document.getElementById('playerStage'),
    cinemaVideo: document.getElementById('cinemaVideo'),
    videoEmptyState: document.getElementById('videoEmptyState'),
    emptyStateText: document.getElementById('emptyStateText'),
    emptyChooseMovieBtn: document.getElementById('emptyChooseMovieBtn'),
    videoBufferingBadge: document.getElementById('videoBufferingBadge'),
    bufferingText: document.getElementById('bufferingText'),
    autoplayUnlockBanner: document.getElementById('autoplayUnlockBanner'),
    reactionLayer: document.getElementById('reactionLayer'),
    hudMovieTitle: document.getElementById('hudMovieTitle'),
    hudPartnerVoiceBadge: document.getElementById('hudPartnerVoiceBadge'),
    pipBtn: document.getElementById('pipBtn'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),

    // Host controls
    hostControls: document.getElementById('hostControls'),
    hostCurrentTime: document.getElementById('hostCurrentTime'),
    hostSeekSlider: document.getElementById('hostSeekSlider'),
    hostDurationTime: document.getElementById('hostDurationTime'),
    rewind10Btn: document.getElementById('rewind10Btn'),
    hostPlayPauseBtn: document.getElementById('hostPlayPauseBtn'),
    hostPlayIcon: document.getElementById('hostPlayIcon'),
    hostPauseIcon: document.getElementById('hostPauseIcon'),
    forward10Btn: document.getElementById('forward10Btn'),
    audioTrackSelect: document.getElementById('audioTrackSelect'),
    subtitleTrackSelect: document.getElementById('subtitleTrackSelect'),
    uploadSubtitleBtn: document.getElementById('uploadSubtitleBtn'),
    subtitleFileInput: document.getElementById('subtitleFileInput'),

    // Guest controls
    guestControls: document.getElementById('guestControls'),
    guestCurrentTime: document.getElementById('guestCurrentTime'),
    guestProgressTrack: document.getElementById('guestProgressTrack'),
    guestProgressFill: document.getElementById('guestProgressFill'),
    guestDurationTime: document.getElementById('guestDurationTime'),
    guestSyncBadge: document.getElementById('guestSyncBadge'),
    resyncBtn: document.getElementById('resyncBtn'),
    guestPipBtn: document.getElementById('guestPipBtn'),
    guestFullscreenBtn: document.getElementById('guestFullscreenBtn'),

    // Comms elements
    callPipOverlay: document.getElementById('callPipOverlay'),
    remoteVideo: document.getElementById('remoteVideo'),
    remotePlaceholder: document.getElementById('remotePlaceholder'),
    remoteInitial: document.getElementById('remoteInitial'),
    remoteExternalBadge: document.getElementById('remoteExternalBadge'),
    remoteSpeakingDot: document.getElementById('remoteSpeakingDot'),
    localVideo: document.getElementById('localVideo'),
    pipCollapseBtn: document.getElementById('pipCollapseBtn'),
    toggleMicBtn: document.getElementById('toggleMicBtn'),
    micOnIcon: document.getElementById('micOnIcon'),
    micOffIcon: document.getElementById('micOffIcon'),
    micBtnLabel: document.getElementById('micBtnLabel'),
    toggleCamBtn: document.getElementById('toggleCamBtn'),
    camBtnLabel: document.getElementById('camBtnLabel'),
    whatsappModeBtn: document.getElementById('whatsappModeBtn'),
    callStatusBadge: document.getElementById('callStatusBadge'),
    movieVolumeSlider: document.getElementById('movieVolumeSlider'),
    movieVolumeValue: document.getElementById('movieVolumeValue'),
    voiceVolumeSlider: document.getElementById('voiceVolumeSlider'),
    voiceVolumeValue: document.getElementById('voiceVolumeValue'),
    autoDuckToggle: document.getElementById('autoDuckToggle'),
    chatMessages: document.getElementById('chatMessages'),
    reactionBar: document.getElementById('reactionBar'),
    chatForm: document.getElementById('chatForm'),
    chatInput: document.getElementById('chatInput'),

    // Modals (Host-only)
    libraryModal: document.getElementById('libraryModal'),
    closeLibraryBtn: document.getElementById('closeLibraryBtn'),
    refreshMoviesBtn: document.getElementById('refreshMoviesBtn'),
    addFolderForm: document.getElementById('addFolderForm'),
    folderPathInput: document.getElementById('folderPathInput'),
    folderTags: document.getElementById('folderTags'),
    movieList: document.getElementById('movieList'),

    inviteModal: document.getElementById('inviteModal'),
    closeInviteBtn: document.getElementById('closeInviteBtn'),
    refreshTunnelBtn: document.getElementById('refreshTunnelBtn'),
    tunnelStatusBadge: document.getElementById('tunnelStatusBadge'),
    guestQrImg: document.getElementById('guestQrImg'),
    guestQrPlaceholder: document.getElementById('guestQrPlaceholder'),
    guestUrlInput: document.getElementById('guestUrlInput'),
    copyGuestUrlBtn: document.getElementById('copyGuestUrlBtn'),
    whatsappShareLink: document.getElementById('whatsappShareLink'),
    hostQrImg: document.getElementById('hostQrImg'),
    hostQrPlaceholder: document.getElementById('hostQrPlaceholder'),
    hostMobileUrlInput: document.getElementById('hostMobileUrlInput'),
    copyHostUrlBtn: document.getElementById('copyHostUrlBtn'),

    toastContainer: document.getElementById('toastContainer')
  };

  let role = 'guest';
  let roleSource = 'guest';
  let hostToken = null;
  let displayName = 'Amor';
  let joined = false;
  let socket = null;
  let latestRoomState = null;
  let hostHeartbeatTimer = null;
  let invitePollTimer = null;
  let lastAudioSignature = '';
  let lastSubtitleSignature = '';

  function showToast(message, isError = false) {
    if (!dom.toastContainer || !message) return;
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' is-error' : ''}`;
    toast.textContent = String(message);
    dom.toastContainer.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 3600);
  }

  function isSafeHttpUrl(url) {
    return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
  }

  const player = global.PaeStreamPlayer.createPlayerController({
    video: dom.cinemaVideo,
    stageEl: dom.playerStage,
    emptyStateEl: dom.videoEmptyState,
    bufferingBadgeEl: dom.videoBufferingBadge,
    bufferingTextEl: dom.bufferingText,
    autoplayBannerEl: dom.autoplayUnlockBanner,
    syncBadgeEl: dom.guestSyncBadge,
    onTimeDisplay: handleTimeDisplay,
    onStatusToast: showToast,
    onEnded: () => {
      if (role === 'host') {
        sendHostCommand({ action: 'pause', currentTime: player.getDuration() });
      }
    }
  });

  function emitSocket(eventName, payload, ack) {
    if (!socket || !socket.connected) return;
    if (typeof ack === 'function') {
      socket.emit(eventName, payload, ack);
    } else {
      socket.emit(eventName, payload);
    }
  }

  const comms = global.PaeStreamComms.createCommsController({
    contract: CONTRACT,
    player,
    elements: dom,
    emitSocket,
    onToast: showToast
  });

  function handleTimeDisplay({ currentTime, duration, isPlaying, hasStream }) {
    const formattedCurr = player.formatTimecode(currentTime);
    const formattedDur = player.formatTimecode(duration);

    if (role === 'host') {
      if (dom.hostCurrentTime) dom.hostCurrentTime.textContent = formattedCurr;
      if (dom.hostDurationTime) dom.hostDurationTime.textContent = formattedDur;
      if (dom.hostSeekSlider) {
        dom.hostSeekSlider.max = duration > 0 ? String(duration) : '100';
        dom.hostSeekSlider.value = duration > 0 ? String(Math.min(currentTime, duration)) : '0';
      }
      if (dom.hostPlayIcon && dom.hostPauseIcon) {
        dom.hostPlayIcon.hidden = Boolean(isPlaying && hasStream);
        dom.hostPauseIcon.hidden = !(isPlaying && hasStream);
      }
    } else {
      if (dom.guestCurrentTime) dom.guestCurrentTime.textContent = formattedCurr;
      if (dom.guestDurationTime) dom.guestDurationTime.textContent = formattedDur;
      const pct = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
      if (dom.guestProgressFill) {
        dom.guestProgressFill.style.width = `${pct.toFixed(2)}%`;
      }
      if (dom.guestProgressTrack) {
        dom.guestProgressTrack.setAttribute('aria-valuenow', String(Math.round(pct)));
      }
    }
  }

  function clearHostAuthParamsFromUrl() {
    try {
      const url = new URL(global.location.href);
      if (!url.searchParams.has('role') && !url.searchParams.has('code') && !url.searchParams.has('token')) {
        return;
      }
      url.searchParams.delete('code');
      url.searchParams.delete('token');
      const clean = `${url.pathname}${url.searchParams.toString() ? `?${url.searchParams}` : ''}${url.hash}`;
      global.history.replaceState({}, '', clean);
    } catch (_err) {
      // Ignore history API failures
    }
  }

  async function detectRoleAndToken() {
    const params = new URLSearchParams(global.location.search);
    const urlRole = params.get('role');
    const urlCode = params.get('code');

    if (urlRole === 'host' && urlCode) {
      try {
        const res = await fetch(ENDPOINTS.HOST_REDEEM_PAIRING, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: urlCode }),
          cache: 'no-store'
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.hostToken) {
          try {
            global.sessionStorage.setItem('paestream_host_token', data.hostToken);
          } catch (_err) {
            // Ignore storage restrictions
          }
          try {
            global.history.replaceState({}, '', global.location.pathname);
          } catch (_err) {
            // Ignore
          }
          return { role: 'host', hostToken: data.hostToken, source: 'mobile-url' };
        }
      } catch (_err) {
        // Fall through to other host detection paths
      }
      clearHostAuthParamsFromUrl();
    }

    if (urlRole === 'host') {
      try {
        const saved = global.sessionStorage.getItem('paestream_host_token');
        if (saved) {
          clearHostAuthParamsFromUrl();
          return { role: 'host', hostToken: saved, source: 'mobile-url' };
        }
      } catch (_err) {
        // Ignore storage restrictions
      }
    }

    const hostname = global.location.hostname;
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (isLocal) {
      try {
        const res = await fetch(ENDPOINTS.HOST_BOOTSTRAP, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data && data.hostToken) {
            try {
              global.sessionStorage.setItem('paestream_host_token', data.hostToken);
            } catch (_err) {
              // Ignore
            }
            return { role: 'host', hostToken: data.hostToken, source: 'localhost' };
          }
        }
      } catch (_err) {
        // Fall back to guest if bootstrap fails
      }
    }

    return { role: 'guest', hostToken: null, source: 'guest' };
  }

  function lockGuestMode() {
    role = 'guest';
    hostToken = null;
    document.body.dataset.role = 'guest';
    player.setRole('guest');

    // Strictly remove all host-only UI elements from the DOM for Guest
    const hostEls = document.querySelectorAll('.host-only');
    hostEls.forEach((el) => el.remove());

    if (dom.entryRoleBadge) {
      dom.entryRoleBadge.textContent = 'Convidada';
      dom.entryRoleBadge.classList.remove('is-host');
    }
    if (dom.emptyStateText) {
      dom.emptyStateText.textContent = 'Aguardando o Host escolher o filme da noite...';
    }
  }

  function enableHostMode(token, source) {
    role = 'host';
    roleSource = source;
    hostToken = token;
    document.body.dataset.role = 'host';
    player.setRole('host');

    const hostBars = [
      dom.openLibraryBtn,
      dom.openInviteBtn,
      dom.emptyChooseMovieBtn,
      dom.hostControls
    ];
    hostBars.forEach((el) => {
      if (el) el.hidden = false;
    });

    if (dom.entryRoleBadge) {
      dom.entryRoleBadge.textContent = source === 'mobile-url' ? 'Host Mobile' : 'Host (PC)';
      dom.entryRoleBadge.classList.add('is-host');
    }
    if (dom.emptyStateText) {
      dom.emptyStateText.textContent = 'Selecione um filme do seu PC para começar a sessão.';
    }
  }

  async function hostFetch(url, fetchOptions = {}) {
    if (role !== 'host' || !hostToken) {
      throw new Error('Apenas o Host autorizado pode executar esta ação.');
    }
    const headers = Object.assign({}, fetchOptions.headers || {}, {
      'x-host-token': hostToken
    });
    if (fetchOptions.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, Object.assign({}, fetchOptions, { headers }));
    let data = null;
    try {
      data = await res.json();
    } catch (_err) {
      data = null;
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `Erro HTTP ${res.status}`);
    }
    return data;
  }

  function renderPresence(state) {
    if (!dom.connectionPill || !dom.connectionLabel) return;
    dom.connectionPill.classList.remove('is-pair-online', 'is-waiting');

    const both = Boolean(state.hostConnected && state.guestConnected);
    if (both) {
      dom.connectionPill.classList.add('is-pair-online');
      dom.connectionLabel.textContent = 'Vocês 2 na sala';
    } else if (role === 'host') {
      dom.connectionPill.classList.add('is-waiting');
      dom.connectionLabel.textContent = 'Aguardando Amor';
    } else {
      dom.connectionPill.classList.add(state.hostConnected ? 'is-pair-online' : 'is-waiting');
      dom.connectionLabel.textContent = state.hostConnected ? 'Host na sala' : 'Aguardando Host';
    }
  }

  function renderHostSelectors(state) {
    if (role !== 'host') return;
    const hasStream = Boolean(state && state.streamUrl);

    if (dom.hostSeekSlider) dom.hostSeekSlider.disabled = !hasStream;
    if (dom.rewind10Btn) dom.rewind10Btn.disabled = !hasStream;
    if (dom.hostPlayPauseBtn) dom.hostPlayPauseBtn.disabled = !hasStream;
    if (dom.forward10Btn) dom.forward10Btn.disabled = !hasStream;
    if (dom.uploadSubtitleBtn) dom.uploadSubtitleBtn.disabled = !Boolean(state && state.movieId);

    const audioTracks = Array.isArray(state?.audioTracks) ? state.audioTracks : [];
    const audioSig = JSON.stringify(audioTracks.map((t) => `${t.index}:${t.label}`));
    if (dom.audioTrackSelect && audioSig !== lastAudioSignature) {
      lastAudioSignature = audioSig;
      dom.audioTrackSelect.innerHTML = '';
      if (audioTracks.length === 0) {
        const opt = document.createElement('option');
        opt.value = '0';
        opt.textContent = 'Áudio padrão';
        dom.audioTrackSelect.appendChild(opt);
      } else {
        audioTracks.forEach((track) => {
          const opt = document.createElement('option');
          opt.value = String(track.index);
          opt.textContent = track.label || `Faixa ${track.index + 1}`;
          dom.audioTrackSelect.appendChild(opt);
        });
      }
    }
    if (dom.audioTrackSelect) {
      dom.audioTrackSelect.disabled = !hasStream || audioTracks.length === 0;
      if (state && typeof state.selectedAudioIndex === 'number') {
        dom.audioTrackSelect.value = String(state.selectedAudioIndex);
      }
    }

    const subtitleTracks = Array.isArray(state?.subtitleTracks) ? state.subtitleTracks : [];
    const subSig = JSON.stringify(subtitleTracks.map((t) => `${t.id}:${t.label}`));
    if (dom.subtitleTrackSelect && subSig !== lastSubtitleSignature) {
      lastSubtitleSignature = subSig;
      dom.subtitleTrackSelect.innerHTML = '';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'Sem legenda';
      dom.subtitleTrackSelect.appendChild(noneOpt);

      subtitleTracks.forEach((sub) => {
        const opt = document.createElement('option');
        opt.value = String(sub.id);
        opt.textContent = sub.label || sub.filename || 'Legenda';
        dom.subtitleTrackSelect.appendChild(opt);
      });
    }
    if (dom.subtitleTrackSelect) {
      dom.subtitleTrackSelect.disabled = !hasStream;
      dom.subtitleTrackSelect.value = state?.selectedSubtitleId ? String(state.selectedSubtitleId) : '';
    }
  }

  function renderRoomStateUi(state) {
    if (!state) return;
    latestRoomState = state;

    const titleText = state.movieTitle || 'Nenhum filme selecionado';
    if (dom.roomTitle) dom.roomTitle.textContent = titleText;
    if (dom.hudMovieTitle) dom.hudMovieTitle.textContent = state.movieTitle || '';
    if (dom.entryMovieHint) {
      dom.entryMovieHint.textContent = state.movieTitle
        ? `Em cartaz: ${state.movieTitle}`
        : 'Sala pronta';
    }

    renderPresence(state);
    renderHostSelectors(state);
    comms.updateRoomPresence(state);
  }

  function sendHostCommand(payload) {
    if (role !== 'host' || !socket || !socket.connected) return;
    socket.emit(SOCKET_EVENTS.HOST_COMMAND, payload, (ack) => {
      if (ack && ack.ok === false && ack.message) {
        showToast(ack.message, true);
      }
    });
  }

  function startHostHeartbeat() {
    clearInterval(hostHeartbeatTimer);
    if (role !== 'host') return;
    hostHeartbeatTimer = setInterval(() => {
      if (role !== 'host' || !joined || !socket || !socket.connected) return;
      if (!latestRoomState || !latestRoomState.movieId) return;
      socket.emit(SOCKET_EVENTS.HOST_TIME_UPDATE, {
        currentTime: player.getAbsoluteTime(),
        isPlaying: player.isPlaying()
      });
    }, 2000);
  }

  function renderLibraryData(data) {
    if (role !== 'host' || !data) return;
    const folders = Array.isArray(data.folders) ? data.folders : [];
    const movies = Array.isArray(data.movies) ? data.movies : [];

    if (dom.folderTags) {
      dom.folderTags.innerHTML = '';
      folders.forEach((folder) => {
        const tag = document.createElement('span');
        tag.className = 'folder-tag';
        tag.textContent = String(folder);
        dom.folderTags.appendChild(tag);
      });
    }

    if (dom.movieList) {
      dom.movieList.innerHTML = '';
      if (movies.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'movie-empty';
        empty.textContent = 'Nenhum filme encontrado. Coloque arquivos na pasta movies/ ou adicione uma pasta acima.';
        dom.movieList.appendChild(empty);
        return;
      }

      movies.forEach((movie) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isActive = latestRoomState && latestRoomState.movieId === movie.id;
        btn.className = `movie-item${isActive ? ' is-active' : ''}`;

        const info = document.createElement('div');
        info.className = 'movie-item-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'movie-item-title';
        titleEl.textContent = movie.title || movie.filename || 'Filme sem título';

        const metaEl = document.createElement('div');
        metaEl.className = 'movie-item-meta';

        const durSpan = document.createElement('span');
        durSpan.textContent = player.formatTimecode(movie.duration || 0);

        const codecSpan = document.createElement('span');
        codecSpan.className = 'codec-badge';
        codecSpan.textContent = (movie.videoCodec || 'video').toUpperCase();

        const trackSpan = document.createElement('span');
        const audioCount = Array.isArray(movie.audioTracks) ? movie.audioTracks.length : 0;
        const subCount = Array.isArray(movie.subtitleTracks) ? movie.subtitleTracks.length : 0;
        trackSpan.textContent = `${audioCount} áudio(s) • ${subCount} legenda(s)`;

        metaEl.appendChild(durSpan);
        metaEl.appendChild(codecSpan);
        metaEl.appendChild(trackSpan);

        info.appendChild(titleEl);
        info.appendChild(metaEl);

        const actionLabel = document.createElement('span');
        actionLabel.className = 'codec-badge';
        actionLabel.textContent = isActive ? 'Tocando' : 'Abrir';

        btn.appendChild(info);
        btn.appendChild(actionLabel);

        btn.addEventListener('click', async () => {
          try {
            btn.disabled = true;
            showToast(`Preparando "${movie.title || movie.filename}"...`);
            const res = await hostFetch(ENDPOINTS.HOST_SELECT_MOVIE, {
              method: 'POST',
              body: JSON.stringify({ movieId: movie.id })
            });
            closeModal(dom.libraryModal);
            if (res && res.state) {
              player.applyRoomState(res.state);
              renderRoomStateUi(res.state);
            }
          } catch (err) {
            showToast(err.message || 'Erro ao selecionar filme.', true);
          } finally {
            btn.disabled = false;
          }
        });

        dom.movieList.appendChild(btn);
      });
    }
  }

  async function loadMovieLibrary() {
    if (role !== 'host') return;
    try {
      const data = await hostFetch(ENDPOINTS.MOVIES, { cache: 'no-store' });
      renderLibraryData(data);
    } catch (err) {
      showToast(err.message || 'Não foi possível listar filmes.', true);
    }
  }

  async function loadTunnelInviteInfo() {
    if (role !== 'host') return;
    try {
      const data = await hostFetch(ENDPOINTS.HOST_TUNNEL, { cache: 'no-store' });
      const guestUrl = data.guestUrl || data.publicUrl || data.lanUrl || '';
      const hostMobileUrl = data.hostMobileUrl || '';

      if (dom.tunnelStatusBadge) {
        dom.tunnelStatusBadge.classList.toggle('is-online', Boolean(data.publicUrl));
        if (data.publicUrl) {
          dom.tunnelStatusBadge.textContent = 'Túnel HTTPS ativo (Cloudflare) 🟢';
        } else {
          dom.tunnelStatusBadge.textContent = `Rede local / LAN (túnel: ${data.status || 'iniciando'})`;
        }
      }

      if (dom.guestUrlInput) dom.guestUrlInput.value = guestUrl;
      if (dom.hostMobileUrlInput) dom.hostMobileUrlInput.value = hostMobileUrl;

      if (dom.guestQrImg && dom.guestQrPlaceholder) {
        if (data.qrCodeDataUrl) {
          dom.guestQrImg.src = data.qrCodeDataUrl;
          dom.guestQrImg.hidden = false;
          dom.guestQrPlaceholder.hidden = true;
        } else {
          dom.guestQrImg.hidden = true;
          dom.guestQrPlaceholder.hidden = false;
        }
      }

      if (dom.hostQrImg && dom.hostQrPlaceholder) {
        if (data.hostQrCodeDataUrl) {
          dom.hostQrImg.src = data.hostQrCodeDataUrl;
          dom.hostQrImg.hidden = false;
          dom.hostQrPlaceholder.hidden = true;
        } else {
          dom.hostQrImg.hidden = true;
          dom.hostQrPlaceholder.hidden = false;
        }
      }

      if (dom.whatsappShareLink) {
        if (isSafeHttpUrl(guestUrl)) {
          const msg = `Vem assistir comigo no nosso cinema particular 🍿❤️ ${guestUrl}`;
          dom.whatsappShareLink.href = `https://wa.me/?text=${encodeURIComponent(msg)}`;
          dom.whatsappShareLink.removeAttribute('aria-disabled');
        } else {
          dom.whatsappShareLink.href = '#';
          dom.whatsappShareLink.setAttribute('aria-disabled', 'true');
        }
      }
    } catch (err) {
      showToast(err.message || 'Erro ao carregar links de convite.', true);
    }
  }

  function openModal(modalEl) {
    if (!modalEl || role !== 'host') return;
    modalEl.hidden = false;
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    modalEl.hidden = true;
    if (modalEl === dom.inviteModal) {
      clearInterval(invitePollTimer);
      invitePollTimer = null;
    }
  }

  async function copyInputValue(inputEl, label) {
    if (!inputEl || !inputEl.value) return;
    try {
      await navigator.clipboard.writeText(inputEl.value);
      showToast(`${label} copiado!`);
    } catch (_err) {
      inputEl.select();
      try {
        document.execCommand('copy');
        showToast(`${label} copiado!`);
      } catch (_copyErr) {
        showToast('Selecione e copie o link manualmente.', true);
      }
    }
  }

  function readSubtitleFilePreservingAccents(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Falha ao ler arquivo de legenda.'));
      reader.onload = () => {
        try {
          const buf = reader.result;
          try {
            resolve(new TextDecoder('utf-8', { fatal: true }).decode(buf));
          } catch (_utf8Err) {
            resolve(new TextDecoder('windows-1252').decode(buf));
          }
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function joinRoomOnSocket() {
    if (!socket || !socket.connected || !joined) return;
    socket.emit(
      SOCKET_EVENTS.ROOM_JOIN,
      {
        role,
        hostToken: role === 'host' ? hostToken : undefined,
        displayName
      },
      (ack) => {
        if (!ack) return;
        if (ack.role && ack.role !== role) {
          lockGuestMode();
        }
        comms.setSessionIdentity(role, displayName);
        if (ack.state) {
          player.applyRoomState(ack.state);
          renderRoomStateUi(ack.state);
        }
        if (role === 'host') {
          startHostHeartbeat();
          loadMovieLibrary();
        }
      }
    );
  }

  function connectSocket() {
    if (typeof global.io === 'undefined') {
      showToast('Socket.io não carregado.', true);
      return;
    }
    socket = global.io();

    socket.on('connect', () => {
      if (joined) {
        joinRoomOnSocket();
      }
    });

    socket.on('disconnect', () => {
      if (dom.connectionLabel) {
        dom.connectionLabel.textContent = 'Reconectando...';
      }
    });

    socket.on(SOCKET_EVENTS.ROOM_STATE, (state) => {
      if (!joined) {
        if (dom.entryMovieHint && state && state.movieTitle) {
          dom.entryMovieHint.textContent = `Em cartaz: ${state.movieTitle}`;
        }
        return;
      }
      player.applyRoomState(state);
      renderRoomStateUi(state);
    });

    socket.on(SOCKET_EVENTS.SYNC_PULSE, (pulse) => {
      if (!joined) return;
      player.handleSyncPulse(pulse);
    });

    socket.on(SOCKET_EVENTS.HOST_ERROR, (err) => {
      if (!err) return;
      if (err.code === 'INVALID_HOST_TOKEN' && role === 'host') {
        lockGuestMode();
      }
      if (err.message) {
        showToast(err.message, true);
      }
    });

    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, (msg) => {
      comms.appendChatMessage(msg);
    });

    socket.on(SOCKET_EVENTS.CHAT_REACTION, (reaction) => {
      comms.spawnFloatingReaction(reaction);
    });

    socket.on(SOCKET_EVENTS.WEBRTC_SIGNAL, (signal) => {
      comms.handleWebRtcSignal(signal);
    });
  }

  function wireStageAndGuestEvents() {
    const pipSupported = player.isPipSupported();
    if (!pipSupported) {
      if (dom.pipBtn) dom.pipBtn.hidden = true;
      if (dom.guestPipBtn) dom.guestPipBtn.hidden = true;
    }

    dom.pipBtn?.addEventListener('click', () => player.togglePip());
    dom.guestPipBtn?.addEventListener('click', () => player.togglePip());
    dom.fullscreenBtn?.addEventListener('click', () => player.toggleFullscreen());
    dom.guestFullscreenBtn?.addEventListener('click', () => player.toggleFullscreen());

    dom.resyncBtn?.addEventListener('click', () => {
      player.unlockMedia();
      player.resyncNow();
      if (socket && socket.connected && joined) {
        joinRoomOnSocket();
      }
      showToast('Sincronizado com a sessão!');
    });
  }

  function wireHostEvents() {
    if (role !== 'host') return;

    dom.openLibraryBtn?.addEventListener('click', () => {
      openModal(dom.libraryModal);
      loadMovieLibrary();
    });

    dom.emptyChooseMovieBtn?.addEventListener('click', () => {
      openModal(dom.libraryModal);
      loadMovieLibrary();
    });

    dom.closeLibraryBtn?.addEventListener('click', () => closeModal(dom.libraryModal));
    dom.refreshMoviesBtn?.addEventListener('click', () => loadMovieLibrary());

    dom.addFolderForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const folderPath = dom.folderPathInput?.value.trim();
      if (!folderPath) return;
      try {
        const res = await hostFetch(ENDPOINTS.HOST_ADD_FOLDER, {
          method: 'POST',
          body: JSON.stringify({ folderPath })
        });
        dom.folderPathInput.value = '';
        renderLibraryData(res);
        showToast('Pasta adicionada ao catálogo!');
      } catch (err) {
        showToast(err.message || 'Não foi possível adicionar a pasta.', true);
      }
    });

    dom.openInviteBtn?.addEventListener('click', () => {
      openModal(dom.inviteModal);
      loadTunnelInviteInfo();
      clearInterval(invitePollTimer);
      invitePollTimer = setInterval(loadTunnelInviteInfo, 4000);
    });

    dom.closeInviteBtn?.addEventListener('click', () => closeModal(dom.inviteModal));
    dom.refreshTunnelBtn?.addEventListener('click', () => loadTunnelInviteInfo());
    dom.copyGuestUrlBtn?.addEventListener('click', () => copyInputValue(dom.guestUrlInput, 'Link da Convidada'));
    dom.copyHostUrlBtn?.addEventListener('click', () => copyInputValue(dom.hostMobileUrlInput, 'Link Host Mobile'));

    // Modal backdrop & Escape close
    [dom.libraryModal, dom.inviteModal].forEach((modal) => {
      modal?.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
      });
    });

    // Transport controls
    dom.hostPlayPauseBtn?.addEventListener('click', () => {
      const shouldPlay = !player.isPlaying();
      player.optimisticPlayPause(shouldPlay);
      sendHostCommand({
        action: shouldPlay ? 'play' : 'pause',
        currentTime: player.getAbsoluteTime()
      });
    });

    dom.rewind10Btn?.addEventListener('click', () => {
      const target = Math.max(0, player.getAbsoluteTime() - 10);
      sendHostCommand({ action: 'seek', currentTime: target });
    });

    dom.forward10Btn?.addEventListener('click', () => {
      const dur = player.getDuration();
      const raw = player.getAbsoluteTime() + 10;
      const target = dur > 0 ? Math.min(dur - 0.5, raw) : raw;
      sendHostCommand({ action: 'seek', currentTime: Math.max(0, target) });
    });

    if (dom.hostSeekSlider) {
      const beginScrub = () => player.setHostScrubbing(true);
      dom.hostSeekSlider.addEventListener('pointerdown', beginScrub);
      dom.hostSeekSlider.addEventListener('touchstart', beginScrub, { passive: true });
      dom.hostSeekSlider.addEventListener('input', (e) => {
        player.setHostScrubbing(true);
        if (dom.hostCurrentTime) {
          dom.hostCurrentTime.textContent = player.formatTimecode(Number(e.target.value) || 0);
        }
      });
      dom.hostSeekSlider.addEventListener('change', (e) => {
        player.setHostScrubbing(false);
        const target = Number(e.target.value) || 0;
        sendHostCommand({ action: 'seek', currentTime: target });
      });
    }

    dom.audioTrackSelect?.addEventListener('change', (e) => {
      const audioIndex = Number(e.target.value);
      if (!Number.isInteger(audioIndex)) return;
      showToast('Trocando faixa de áudio...');
      sendHostCommand({ action: 'set-audio', audioIndex });
    });

    dom.subtitleTrackSelect?.addEventListener('change', (e) => {
      const subtitleId = e.target.value ? String(e.target.value) : null;
      sendHostCommand({ action: 'set-subtitle', subtitleId });
    });

    dom.uploadSubtitleBtn?.addEventListener('click', () => {
      dom.subtitleFileInput?.click();
    });

    dom.subtitleFileInput?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file || !latestRoomState || !latestRoomState.movieId) return;

      try {
        const content = await readSubtitleFilePreservingAccents(file);
        const res = await hostFetch(ENDPOINTS.HOST_UPLOAD_SUBTITLE, {
          method: 'POST',
          body: JSON.stringify({
            movieId: latestRoomState.movieId,
            filename: file.name,
            content
          })
        });
        if (res && res.state) {
          player.applyRoomState(res.state);
          renderRoomStateUi(res.state);
        }
        showToast(`Legenda "${file.name}" carregada!`);
      } catch (err) {
        showToast(err.message || 'Erro ao enviar legenda.', true);
      }
    });
  }

  function wireKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Escape') {
        closeModal(dom.libraryModal);
        closeModal(dom.inviteModal);
        return;
      }

      if (e.key === 'f' || e.key === 'F') {
        if (joined) player.toggleFullscreen();
        return;
      }

      if (role !== 'host' || !joined || !latestRoomState?.streamUrl) return;

      if (e.code === 'Space') {
        e.preventDefault();
        dom.hostPlayPauseBtn?.click();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        dom.rewind10Btn?.click();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        dom.forward10Btn?.click();
      }
    });
  }

  async function init() {
    const detected = await detectRoleAndToken();
    if (detected.role === 'host' && detected.hostToken) {
      enableHostMode(detected.hostToken, detected.source);
    } else {
      lockGuestMode();
    }

    const defaultName = role === 'host' ? 'Lucas' : 'Amor';
    let savedName = defaultName;
    try {
      savedName = global.localStorage.getItem(`paestream_name_${role}`) || defaultName;
    } catch (_err) {
      savedName = defaultName;
    }
    if (dom.displayNameInput) {
      dom.displayNameInput.value = savedName;
    }

    connectSocket();
    wireStageAndGuestEvents();
    wireHostEvents();
    wireKeyboardShortcuts();

    dom.entryForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = dom.displayNameInput ? dom.displayNameInput.value.trim() : '';
      displayName = raw || defaultName;
      try {
        global.localStorage.setItem(`paestream_name_${role}`, displayName);
      } catch (_err) {
        // Ignore storage restrictions
      }

      // Unlock video & Web Audio synchronously on the click/submit user gesture
      player.unlockMedia();
      comms.unlockAudio();

      joined = true;
      if (dom.entryOverlay) {
        dom.entryOverlay.hidden = true;
      }

      if (socket && socket.connected) {
        joinRoomOnSocket();
      }
    });
  }

  init();
})(window);
