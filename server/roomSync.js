'use strict';

const { ENDPOINTS, SOCKET_EVENTS } = require('../shared/contract');
const { timingSafeMatch } = require('./mediaScanner');
const { sanitizeRoomStateForClient } = require('./publicData');

function buildSubtitleUrl(subtitleId, baseOffset) {
  if (!subtitleId) return null;
  const safeOffset = Number.isFinite(Number(baseOffset)) ? Number(baseOffset) : 0;
  return `${ENDPOINTS.SUBTITLE_BASE}/${encodeURIComponent(subtitleId)}.vtt?offset=${safeOffset}`;
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

function createRoomSync({ io, mediaScanner, hlsManager, getHostToken }) {
  const allowWebrtc = createRateLimiter({ windowMs: 60_000, max: 120 });
  const state = {
    movieId: null,
    movieTitle: '',
    duration: 0,
    streamUrl: null,
    streamEpoch: 0,
    baseOffset: 0,
    currentTime: 0,
    isPlaying: false,
    audioTracks: [],
    selectedAudioIndex: 0,
    subtitleTracks: [],
    selectedSubtitleId: null,
    subtitleUrl: null,
    updatedAt: Date.now(),
    hostConnected: false,
    guestConnected: false,
    users: []
  };

  function getEffectiveCurrentTime() {
    if (!state.isPlaying) {
      return state.currentTime;
    }
    const elapsed = Math.max(0, (Date.now() - state.updatedAt) / 1000);
    const maxDur = state.duration > 0 ? state.duration : Infinity;
    return Math.min(maxDur, state.currentTime + elapsed);
  }

  function refreshPresence() {
    const users = [];
    let hostConnected = false;
    let guestConnected = false;

    for (const [, sock] of io.sockets.sockets) {
      if (!sock.data || !sock.data.joined) continue;
      const role = sock.data.isHost ? 'host' : 'guest';
      if (role === 'host') hostConnected = true;
      else guestConnected = true;
      users.push({
        id: sock.id,
        displayName: sock.data.displayName || (role === 'host' ? 'Lucas' : 'Amor'),
        role
      });
    }

    state.users = users;
    state.hostConnected = hostConnected;
    state.guestConnected = guestConnected;
  }

  function getPublicState() {
    refreshPresence();
    return sanitizeRoomStateForClient({
      movieId: state.movieId,
      movieTitle: state.movieTitle,
      duration: state.duration,
      streamUrl: state.streamUrl,
      streamEpoch: state.streamEpoch,
      baseOffset: state.baseOffset,
      currentTime: getEffectiveCurrentTime(),
      isPlaying: state.isPlaying,
      audioTracks: state.audioTracks,
      selectedAudioIndex: state.selectedAudioIndex,
      subtitleTracks: state.subtitleTracks,
      selectedSubtitleId: state.selectedSubtitleId,
      subtitleUrl: state.subtitleUrl,
      updatedAt: Date.now(),
      hostConnected: state.hostConnected,
      guestConnected: state.guestConnected,
      users: state.users
    });
  }

  function emitRoomState() {
    io.emit(SOCKET_EVENTS.ROOM_STATE, getPublicState());
  }

  function emitSyncPulse(target = io) {
    target.emit(SOCKET_EVENTS.SYNC_PULSE, {
      hostTime: getEffectiveCurrentTime(),
      isPlaying: state.isPlaying,
      streamEpoch: state.streamEpoch,
      baseOffset: state.baseOffset,
      serverTimestamp: Date.now()
    });
  }

  function clampMovieTime(seconds) {
    const num = Number(seconds);
    if (!Number.isFinite(num) || num < 0) return 0;
    if (state.duration > 0) {
      return Math.min(num, Math.max(0, state.duration - 0.1));
    }
    return num;
  }

  async function selectMovie({ movieId, audioIndex, subtitleId, startTime = 0 }) {
    const movie = mediaScanner.getMovieById(movieId);
    if (!movie) {
      const err = new Error(`Filme não encontrado: ${movieId}`);
      err.statusCode = 404;
      throw err;
    }

    const desiredAudio =
      typeof audioIndex === 'number' && Number.isFinite(audioIndex) ? audioIndex : 0;
    const hlsInfo = await hlsManager.startMovie({
      movie,
      startTime,
      audioIndex: desiredAudio
    });

    let chosenSubId = null;
    if (subtitleId === null) {
      chosenSubId = null;
    } else if (typeof subtitleId === 'string' && subtitleId.length > 0) {
      const exists = movie.subtitleTracks.some((t) => t.id === subtitleId);
      chosenSubId = exists ? subtitleId : null;
    } else if (movie.subtitleTracks.length > 0) {
      chosenSubId = movie.subtitleTracks[0].id;
    }

    state.movieId = movie.id;
    state.movieTitle = movie.title;
    state.duration = movie.duration;
    state.streamUrl = hlsInfo.streamUrl;
    state.streamEpoch = hlsInfo.streamEpoch;
    state.baseOffset = hlsInfo.baseOffset;
    state.currentTime = hlsInfo.baseOffset;
    state.isPlaying = false;
    state.audioTracks = movie.audioTracks;
    state.selectedAudioIndex = hlsInfo.selectedAudioIndex;
    state.subtitleTracks = movie.subtitleTracks;
    state.selectedSubtitleId = chosenSubId;
    state.subtitleUrl = buildSubtitleUrl(chosenSubId, hlsInfo.baseOffset);
    state.updatedAt = Date.now();

    emitRoomState();
    return getPublicState();
  }

  function onSubtitleUploaded(movieId, subtitleTrack) {
    if (state.movieId === movieId) {
      const movie = mediaScanner.getMovieById(movieId);
      state.subtitleTracks = movie ? movie.subtitleTracks : [...state.subtitleTracks, subtitleTrack];
      state.selectedSubtitleId = subtitleTrack.id;
      state.subtitleUrl = buildSubtitleUrl(subtitleTrack.id, state.baseOffset);
      state.updatedAt = Date.now();
      emitRoomState();
    }
    return getPublicState();
  }

  async function handleHostCommand(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Comando inválido.');
    }

    const { action } = payload;

    if (action === 'play') {
      if (typeof payload.currentTime === 'number' && Number.isFinite(payload.currentTime)) {
        state.currentTime = clampMovieTime(payload.currentTime);
      } else {
        state.currentTime = getEffectiveCurrentTime();
      }
      state.isPlaying = true;
      state.updatedAt = Date.now();
      emitRoomState();
      emitSyncPulse();
      return;
    }

    if (action === 'pause') {
      if (typeof payload.currentTime === 'number' && Number.isFinite(payload.currentTime)) {
        state.currentTime = clampMovieTime(payload.currentTime);
      } else {
        state.currentTime = getEffectiveCurrentTime();
      }
      state.isPlaying = false;
      state.updatedAt = Date.now();
      emitRoomState();
      emitSyncPulse();
      return;
    }

    if (action === 'seek') {
      const movie = mediaScanner.getMovieById(state.movieId);
      if (!movie) {
        throw new Error('Nenhum filme selecionado para buscar.');
      }
      const targetTime = clampMovieTime(payload.currentTime);
      const result = await hlsManager.seek({
        movie,
        targetTime,
        audioIndex: state.selectedAudioIndex
      });

      state.streamUrl = result.streamUrl;
      state.streamEpoch = result.streamEpoch;
      state.baseOffset = result.baseOffset;
      state.currentTime = targetTime;
      state.subtitleUrl = buildSubtitleUrl(state.selectedSubtitleId, state.baseOffset);
      state.updatedAt = Date.now();
      emitRoomState();
      emitSyncPulse();
      return;
    }

    if (action === 'set-audio') {
      const movie = mediaScanner.getMovieById(state.movieId);
      if (!movie) {
        throw new Error('Nenhum filme selecionado para trocar o áudio.');
      }
      const nextAudioIndex = Number(payload.audioIndex);
      if (!Number.isInteger(nextAudioIndex) || nextAudioIndex < 0 || nextAudioIndex >= movie.audioTracks.length) {
        throw new Error('Índice de faixa de áudio inválido.');
      }

      const resumeTime = getEffectiveCurrentTime();
      const result = await hlsManager.setAudio({
        movie,
        currentTime: resumeTime,
        audioIndex: nextAudioIndex
      });

      state.streamUrl = result.streamUrl;
      state.streamEpoch = result.streamEpoch;
      state.baseOffset = result.baseOffset;
      state.currentTime = result.baseOffset;
      state.selectedAudioIndex = result.selectedAudioIndex;
      state.subtitleUrl = buildSubtitleUrl(state.selectedSubtitleId, state.baseOffset);
      state.updatedAt = Date.now();
      emitRoomState();
      emitSyncPulse();
      return;
    }

    if (action === 'set-subtitle') {
      const subtitleId = payload.subtitleId || null;
      if (subtitleId !== null) {
        const valid =
          state.subtitleTracks.some((t) => t.id === subtitleId) ||
          Boolean(mediaScanner.getSubtitleById(subtitleId));
        if (!valid) {
          throw new Error('Legenda selecionada não encontrada.');
        }
      }
      state.selectedSubtitleId = subtitleId;
      state.subtitleUrl = buildSubtitleUrl(subtitleId, state.baseOffset);
      state.updatedAt = Date.now();
      emitRoomState();
      return;
    }

    throw new Error(`Ação desconhecida: ${String(action)}`);
  }

  function isSocketHost(socket) {
    return Boolean(socket.data && socket.data.isHost === true && socket.data.role === 'host');
  }

  function rejectGuestCommand(socket, ack, code, message) {
    socket.emit(SOCKET_EVENTS.HOST_ERROR, { code, message });
    if (typeof ack === 'function') {
      ack({ ok: false, code, message });
    }
  }

  io.on('connection', (socket) => {
    socket.data = {
      joined: false,
      isHost: false,
      role: 'guest',
      displayName: 'Convidada'
    };

    socket.on(SOCKET_EVENTS.ROOM_JOIN, (payload = {}, ack) => {
      const requestedRole = payload && payload.role === 'host' ? 'host' : 'guest';
      const validToken = getHostToken();
      let assignedRole = 'guest';
      let isHost = false;

      if (requestedRole === 'host') {
        if (timingSafeMatch(payload.hostToken, validToken)) {
          assignedRole = 'host';
          isHost = true;
        } else {
          socket.emit(SOCKET_EVENTS.HOST_ERROR, {
            code: 'INVALID_HOST_TOKEN',
            message: 'Token de Host inválido. Conexão restrita ao modo Convidada.'
          });
        }
      }

      const rawName = typeof payload.displayName === 'string' ? payload.displayName.trim() : '';
      const displayName = (rawName || (isHost ? 'Lucas' : 'Amor')).slice(0, 40);

      socket.data.joined = true;
      socket.data.isHost = isHost;
      socket.data.role = assignedRole;
      socket.data.displayName = displayName;

      const publicState = getPublicState();
      emitRoomState();

      if (typeof ack === 'function') {
        ack({ ok: true, role: assignedRole, state: publicState });
      }
    });

    socket.on(SOCKET_EVENTS.HOST_COMMAND, async (payload, ack) => {
      if (!isSocketHost(socket)) {
        rejectGuestCommand(
          socket,
          ack,
          'FORBIDDEN',
          'Apenas o Host autorizado pode controlar o cinema.'
        );
        return;
      }

      try {
        await handleHostCommand(payload);
        if (typeof ack === 'function') {
          ack({ ok: true, state: getPublicState() });
        }
      } catch (err) {
        socket.emit(SOCKET_EVENTS.HOST_ERROR, {
          code: 'COMMAND_FAILED',
          message: err.message || 'Falha ao executar comando do Host.'
        });
        if (typeof ack === 'function') {
          ack({ ok: false, code: 'COMMAND_FAILED', message: err.message });
        }
      }
    });

    socket.on(SOCKET_EVENTS.HOST_TIME_UPDATE, (payload) => {
      if (!isSocketHost(socket)) {
        socket.emit(SOCKET_EVENTS.HOST_ERROR, {
          code: 'FORBIDDEN',
          message: 'Apenas o Host pode enviar atualizações de tempo.'
        });
        return;
      }
      if (!payload || typeof payload !== 'object') return;

      if (typeof payload.currentTime === 'number' && Number.isFinite(payload.currentTime)) {
        state.currentTime = clampMovieTime(payload.currentTime);
      }
      if (typeof payload.isPlaying === 'boolean') {
        state.isPlaying = payload.isPlaying;
      }
      state.updatedAt = Date.now();
      emitSyncPulse(socket.broadcast);
    });

    socket.on(SOCKET_EVENTS.WEBRTC_SIGNAL, (payload = {}) => {
      if (!socket.data || !socket.data.joined) return;
      if (!allowWebrtc(socket.id)) return;
      if (!payload || typeof payload !== 'object' || !payload.type) return;
      socket.broadcast.emit(SOCKET_EVENTS.WEBRTC_SIGNAL, {
        type: payload.type,
        payload: payload.payload,
        fromRole: socket.data.role || 'guest'
      });
    });

    socket.on('disconnect', () => {
      if (socket.data && socket.data.joined) {
        emitRoomState();
      }
    });
  });

  return {
    getPublicState,
    selectMovie,
    onSubtitleUploaded,
    emitRoomState
  };
}

module.exports = {
  createRoomSync
};
