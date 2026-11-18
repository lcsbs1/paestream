(function (global) {
  'use strict';

  function formatTimecode(totalSeconds) {
    const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    if (hours > 0) {
      return `${hours}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
  }

  function isAppleMobileDevice() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  function createPlayerController(options) {
    const {
      video,
      stageEl,
      emptyStateEl,
      bufferingBadgeEl,
      bufferingTextEl,
      autoplayBannerEl,
      syncBadgeEl,
      onTimeDisplay,
      onStatusToast,
      onEnded
    } = options;

    let role = 'guest';
    let unlocked = false;
    let hlsInstance = null;
    let currentEpoch = null;
    let currentStreamUrl = null;
    let currentBaseOffset = 0;
    let currentSubtitleUrl = null;
    let currentDuration = 0;
    let latestTargetAbsTime = 0;
    let latestExpectedPlaying = false;
    let hostConnected = false;
    let isHostScrubbing = false;
    let movieVolume = 1.0;
    let duckFactor = 1.0;
    let hudTimer = null;

    const useNativeHls = Boolean(video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl'));

    function applyEffectiveVolume() {
      const effective = Math.max(0, Math.min(1, movieVolume * duckFactor));
      if (effective <= 0.001) {
        video.muted = true;
        try {
          video.volume = 0;
        } catch (_err) {
          // iOS Safari volume property is read-only; muted handles silence
        }
      } else {
        video.muted = false;
        try {
          video.volume = effective;
        } catch (_err) {
          // Safe no-op on iOS Safari
        }
      }
    }

    function setMovieVolume(norm) {
      movieVolume = Math.max(0, Math.min(1, Number(norm)));
      applyEffectiveVolume();
    }

    function setDuckFactor(factor) {
      duckFactor = Math.max(0.1, Math.min(1, Number(factor)));
      applyEffectiveVolume();
    }

    function setBuffering(visible, message) {
      if (!bufferingBadgeEl) return;
      bufferingBadgeEl.hidden = !visible;
      if (visible && bufferingTextEl && message) {
        bufferingTextEl.textContent = message;
      }
    }

    function showAutoplayBanner(show) {
      if (!autoplayBannerEl) return;
      autoplayBannerEl.hidden = !show;
    }

    function safePlay() {
      if (!currentStreamUrl) return Promise.resolve();
      applyEffectiveVolume();
      const promise = video.play();
      if (promise && typeof promise.then === 'function') {
        return promise
          .then(() => {
            showAutoplayBanner(false);
          })
          .catch((err) => {
            if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
              if (err.name === 'NotAllowedError') {
                showAutoplayBanner(true);
              }
            }
          });
      }
      return Promise.resolve();
    }

    function reapplySubtitleMode() {
      if (!video.textTracks || video.textTracks.length === 0) return;
      if (!currentSubtitleUrl) {
        for (let i = 0; i < video.textTracks.length; i += 1) {
          video.textTracks[i].mode = 'disabled';
        }
        return;
      }
      video.textTracks[0].mode = 'showing';
      for (let i = 1; i < video.textTracks.length; i += 1) {
        video.textTracks[i].mode = 'disabled';
      }
    }

    function updateSubtitleTrack(subtitleUrl) {
      const normalized = subtitleUrl || null;
      if (normalized === currentSubtitleUrl) {
        reapplySubtitleMode();
        return;
      }

      currentSubtitleUrl = normalized;
      const existingTracks = video.querySelectorAll('track');
      existingTracks.forEach((t) => t.remove());

      if (!normalized) {
        reapplySubtitleMode();
        return;
      }

      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.srclang = 'pt';
      track.label = 'Legenda';
      track.default = true;
      track.src = normalized;
      video.appendChild(track);

      const ensureShowing = () => {
        if (currentSubtitleUrl !== normalized) return;
        if (track.track) {
          track.track.mode = 'showing';
        }
        reapplySubtitleMode();
      };

      track.addEventListener('load', ensureShowing);
      ensureShowing();
      setTimeout(ensureShowing, 80);
      setTimeout(ensureShowing, 350);
    }

    function seekSafely(targetLocalSeconds) {
      const target = Math.max(0, Number(targetLocalSeconds) || 0);
      if (video.readyState < 1) return;

      let clamped = target;
      if (video.seekable && video.seekable.length > 0) {
        const minSeek = video.seekable.start(0);
        const maxSeek = video.seekable.end(video.seekable.length - 1);
        if (Number.isFinite(maxSeek) && maxSeek > minSeek) {
          clamped = Math.max(minSeek, Math.min(target, maxSeek));
        }
      } else if (Number.isFinite(video.duration) && video.duration > 0) {
        clamped = Math.min(target, video.duration);
      }

      if (Math.abs((video.currentTime || 0) - clamped) > 0.25) {
        try {
          video.currentTime = clamped;
        } catch (_err) {
          // Ignore seek errors while media is still initializing
        }
      }
    }

    function applyDesiredPlaybackState() {
      if (!currentStreamUrl) return;
      if (latestExpectedPlaying) {
        if (video.paused) {
          safePlay();
        }
      } else if (!video.paused) {
        video.pause();
      }
    }

    function destroyHls() {
      if (hlsInstance) {
        try {
          hlsInstance.destroy();
        } catch (_err) {
          // Ignore destroy cleanup error
        }
        hlsInstance = null;
      }
    }

    function loadStream(streamUrl, epoch, baseOffset, targetAbsTime) {
      destroyHls();
      currentEpoch = epoch;
      currentStreamUrl = streamUrl;
      currentBaseOffset = Number(baseOffset) || 0;

      const initialLocal = Math.max(0, (Number(targetAbsTime) || 0) - currentBaseOffset);
      setBuffering(true, 'Carregando vídeo...');
      showAutoplayBanner(false);

      if (useNativeHls) {
        video.src = streamUrl;
        video.load();

        const onNativeReady = () => {
          if (currentEpoch !== epoch || currentStreamUrl !== streamUrl) return;
          const desiredLocal = Math.max(0, latestTargetAbsTime - currentBaseOffset);
          if (desiredLocal > 0.35) {
            seekSafely(desiredLocal);
          }
          reapplySubtitleMode();
          setBuffering(false);
          applyDesiredPlaybackState();
        };

        video.addEventListener('loadedmetadata', onNativeReady, { once: true });
        video.addEventListener('canplay', () => {
          if (currentEpoch !== epoch || currentStreamUrl !== streamUrl) return;
          const desiredLocal = Math.max(0, latestTargetAbsTime - currentBaseOffset);
          if (Math.abs((video.currentTime || 0) - desiredLocal) > 1.5) {
            seekSafely(desiredLocal);
          }
          reapplySubtitleMode();
        }, { once: true });
        return;
      }

      if (typeof global.Hls === 'undefined' || !global.Hls.isSupported()) {
        setBuffering(false);
        onStatusToast?.('Seu navegador não suporta reprodução HLS.', true);
        return;
      }

      const hls = new global.Hls({
        startPosition: initialLocal > 0.35 ? initialLocal : -1,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        maxBufferLength: 30,
        manifestLoadingMaxRetry: 10,
        manifestLoadingRetryDelay: 700,
        levelLoadingMaxRetry: 10,
        fragLoadingMaxRetry: 10
      });

      hlsInstance = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(global.Hls.Events.MANIFEST_PARSED, () => {
        if (hlsInstance !== hls) return;
        if (initialLocal > 0.35) {
          seekSafely(initialLocal);
        }
        reapplySubtitleMode();
        setBuffering(false);
        applyDesiredPlaybackState();
      });

      hls.on(global.Hls.Events.ERROR, (_evt, data) => {
        if (hlsInstance !== hls || !data || !data.fatal) return;
        if (data.type === global.Hls.ErrorTypes.NETWORK_ERROR) {
          setBuffering(true, 'Reconectando stream...');
          hls.startLoad();
        } else if (data.type === global.Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          setBuffering(false);
          onStatusToast?.('Falha na reprodução do vídeo.', true);
        }
      });
    }

    function updateGuestSyncBadge(absDiff) {
      if (!syncBadgeEl || role !== 'guest') return;
      syncBadgeEl.classList.remove('is-synced', 'is-catching-up', 'is-waiting');

      if (!hostConnected) {
        syncBadgeEl.textContent = 'Aguardando Host ⚪';
        syncBadgeEl.classList.add('is-waiting');
        return;
      }

      if (!currentStreamUrl) {
        syncBadgeEl.textContent = 'Host conectado 🟢';
        syncBadgeEl.classList.add('is-synced');
        return;
      }

      if (absDiff > 1.5) {
        syncBadgeEl.textContent = `Sincronizando (${absDiff.toFixed(1)}s) 🟡`;
        syncBadgeEl.classList.add('is-catching-up');
      } else {
        syncBadgeEl.textContent = 'Sincronizado com o Host 🟢';
        syncBadgeEl.classList.add('is-synced');
      }
    }

    function syncGuestToTarget(targetAbsTime, isPlaying) {
      if (role !== 'guest' || !currentStreamUrl) return;

      const guestAbs = getAbsoluteTime();
      const diff = targetAbsTime - guestAbs;
      const absDiff = Math.abs(diff);

      if (video.readyState >= 1) {
        const targetLocal = Math.max(0, targetAbsTime - currentBaseOffset);
        if (absDiff > 1.5) {
          video.playbackRate = 1.0;
          seekSafely(targetLocal);
        } else if (absDiff > 0.35) {
          if (isPlaying) {
            video.playbackRate = diff > 0 ? 1.04 : 0.96;
          } else {
            video.playbackRate = 1.0;
            seekSafely(targetLocal);
          }
        } else {
          video.playbackRate = 1.0;
        }
      }

      if (isPlaying && video.paused) {
        safePlay();
      } else if (!isPlaying && !video.paused) {
        video.pause();
      }

      updateGuestSyncBadge(absDiff);
    }

    function applyRoomState(state) {
      if (!state) return;
      hostConnected = Boolean(state.hostConnected);
      currentDuration = Number(state.duration) || 0;
      latestTargetAbsTime = Number(state.currentTime) || 0;
      latestExpectedPlaying = Boolean(state.isPlaying);

      if (!state.streamUrl) {
        destroyHls();
        currentEpoch = null;
        currentStreamUrl = null;
        currentBaseOffset = 0;
        updateSubtitleTrack(null);
        video.pause();
        video.removeAttribute('src');
        video.load();
        if (emptyStateEl) emptyStateEl.hidden = false;
        setBuffering(false);
        showAutoplayBanner(false);
        updateGuestSyncBadge(0);
        notifyTimeDisplay();
        return;
      }

      if (emptyStateEl) emptyStateEl.hidden = true;

      const streamChanged =
        state.streamEpoch !== currentEpoch ||
        state.streamUrl !== currentStreamUrl ||
        Number(state.baseOffset || 0) !== currentBaseOffset;

      if (streamChanged) {
        loadStream(state.streamUrl, state.streamEpoch, state.baseOffset, latestTargetAbsTime);
      } else {
        // Apply play/pause/seek updates from room:state
        if (role === 'guest') {
          syncGuestToTarget(latestTargetAbsTime, latestExpectedPlaying);
        } else {
          // Host (or second Host device like Host Mobile)
          const hostAbs = getAbsoluteTime();
          if (Math.abs(latestTargetAbsTime - hostAbs) > 1.5 && video.readyState >= 1) {
            seekSafely(Math.max(0, latestTargetAbsTime - currentBaseOffset));
          }
          applyDesiredPlaybackState();
        }
      }

      updateSubtitleTrack(state.subtitleUrl || null);
      if (role === 'guest') {
        updateGuestSyncBadge(Math.abs(latestTargetAbsTime - getAbsoluteTime()));
      }
      notifyTimeDisplay();
    }

    function handleSyncPulse(pulse) {
      if (!pulse) return;
      latestTargetAbsTime = Number(pulse.hostTime) || 0;
      latestExpectedPlaying = Boolean(pulse.isPlaying);

      if (role !== 'guest') return;
      if (pulse.streamEpoch !== currentEpoch) {
        updateGuestSyncBadge(99);
        return;
      }
      syncGuestToTarget(latestTargetAbsTime, latestExpectedPlaying);
    }

    function resyncNow() {
      if (!currentStreamUrl) return;
      video.playbackRate = 1.0;
      if (video.readyState >= 1) {
        seekSafely(Math.max(0, latestTargetAbsTime - currentBaseOffset));
      } else if (hlsInstance) {
        hlsInstance.startLoad();
      }
      applyDesiredPlaybackState();
      updateGuestSyncBadge(0);
      notifyTimeDisplay();
    }

    function unlockMedia() {
      unlocked = true;
      applyEffectiveVolume();
      if (currentStreamUrl && latestExpectedPlaying && video.paused) {
        safePlay();
      }
      showAutoplayBanner(false);
    }

    function optimisticPlayPause(shouldPlay) {
      if (role !== 'host' || !currentStreamUrl) return;
      latestExpectedPlaying = Boolean(shouldPlay);
      if (shouldPlay) {
        safePlay();
      } else {
        video.pause();
      }
    }

    function setRole(nextRole) {
      role = nextRole === 'host' ? 'host' : 'guest';
      video.removeAttribute('controls');
      updateGuestSyncBadge(0);
    }

    function getAbsoluteTime() {
      return currentBaseOffset + (video.currentTime || 0);
    }

    function getDuration() {
      if (currentDuration > 0) return currentDuration;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        return currentBaseOffset + video.duration;
      }
      return 0;
    }

    function isCurrentlyPlaying() {
      return !video.paused && !video.ended;
    }

    function setHostScrubbing(scrubbing) {
      isHostScrubbing = Boolean(scrubbing);
    }

    function notifyTimeDisplay() {
      if (isHostScrubbing) return;
      onTimeDisplay?.({
        currentTime: getAbsoluteTime(),
        duration: getDuration(),
        isPlaying: isCurrentlyPlaying(),
        hasStream: Boolean(currentStreamUrl)
      });
    }

    function toggleFullscreen() {
      const isIOS = isAppleMobileDevice();
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
        return;
      }

      if (!isIOS && typeof stageEl.requestFullscreen === 'function') {
        stageEl.requestFullscreen().catch(() => {
          if (typeof video.webkitEnterFullscreen === 'function') {
            video.webkitEnterFullscreen();
          }
        });
      } else if (typeof video.webkitEnterFullscreen === 'function') {
        try {
          video.webkitEnterFullscreen();
        } catch (_err) {
          onStatusToast?.('Carregue um vídeo para entrar em tela cheia.', true);
        }
      } else if (typeof stageEl.webkitRequestFullscreen === 'function') {
        stageEl.webkitRequestFullscreen();
      }
    }

    function isPipSupported() {
      return Boolean(
        (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') ||
        (typeof video.webkitSupportsPresentationMode === 'function' &&
          video.webkitSupportsPresentationMode('picture-in-picture')) ||
        typeof video.webkitSetPresentationMode === 'function'
      );
    }

    async function togglePip() {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          return;
        }
        if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
          await video.requestPictureInPicture();
          return;
        }
        if (typeof video.webkitSetPresentationMode === 'function') {
          const nextMode = video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture';
          video.webkitSetPresentationMode(nextMode);
          return;
        }
        onStatusToast?.('Picture-in-Picture não suportado neste navegador.', true);
      } catch (_err) {
        onStatusToast?.('Inicie o vídeo antes de ativar o Picture-in-Picture.', true);
      }
    }

    function revealHudTemporarily() {
      if (!stageEl) return;
      stageEl.classList.add('hud-visible');
      clearTimeout(hudTimer);
      hudTimer = setTimeout(() => {
        stageEl.classList.remove('hud-visible');
      }, 2800);
    }

    // Wire native video events
    video.addEventListener('timeupdate', notifyTimeDisplay);
    video.addEventListener('durationchange', notifyTimeDisplay);
    video.addEventListener('play', () => {
      showAutoplayBanner(false);
      notifyTimeDisplay();
    });
    video.addEventListener('pause', notifyTimeDisplay);
    video.addEventListener('waiting', () => {
      if (currentStreamUrl) setBuffering(true, 'Buffering...');
    });
    video.addEventListener('playing', () => {
      setBuffering(false);
      reapplySubtitleMode();
    });
    video.addEventListener('canplay', () => {
      setBuffering(false);
      reapplySubtitleMode();
    });
    video.addEventListener('ended', () => {
      notifyTimeDisplay();
      onEnded?.();
    });
    video.addEventListener('webkitbeginfullscreen', reapplySubtitleMode);
    video.addEventListener('webkitendfullscreen', () => {
      reapplySubtitleMode();
      if (role === 'guest') {
        resyncNow();
      }
    });
    document.addEventListener('fullscreenchange', reapplySubtitleMode);

    if (stageEl) {
      stageEl.addEventListener('pointerdown', revealHudTemporarily);
      stageEl.addEventListener('mousemove', revealHudTemporarily);
    }

    if (autoplayBannerEl) {
      autoplayBannerEl.addEventListener('click', () => {
        unlockMedia();
        if (role === 'guest') {
          resyncNow();
        } else {
          safePlay();
        }
      });
    }

    return {
      setRole,
      unlockMedia,
      optimisticPlayPause,
      applyRoomState,
      handleSyncPulse,
      resyncNow,
      setMovieVolume,
      setDuckFactor,
      getAbsoluteTime,
      getDuration,
      isPlaying: isCurrentlyPlaying,
      isUnlocked: () => unlocked,
      getBaseOffset: () => currentBaseOffset,
      setHostScrubbing,
      toggleFullscreen,
      togglePip,
      isPipSupported,
      formatTimecode
    };
  }

  global.PaeStreamPlayer = {
    createPlayerController,
    formatTimecode
  };
})(window);
