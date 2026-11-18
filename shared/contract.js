/**
 * PaeStream Shared Contract
 * Universal module: works in Node.js (CommonJS) and Browser (window.PAESTREAM_CONTRACT).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PAESTREAM_CONTRACT = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * REST API endpoints exposed by PaeStream server.
   *
   * - GET  ENDPOINTS.MOVIES -> (x-host-token) { movies: MovieItem[], folders: string[] }  // no absolute file paths
   * - GET  ENDPOINTS.HOST_BOOTSTRAP -> (localhost only) { hostToken: string }
   * - POST ENDPOINTS.HOST_ADD_FOLDER -> body: { folderPath: string } -> { ok: true, folderPath: string, folders: string[], movies: MovieItem[] }
   * - POST ENDPOINTS.HOST_SELECT_MOVIE -> body: { movieId: string, audioIndex?: number, subtitleId?: string|null, startTime?: number } -> { ok: true, state: RoomState }
   * - POST ENDPOINTS.HOST_UPLOAD_SUBTITLE -> body: { movieId: string, filename: string, content: string } -> { ok: true, subtitleTrack: SubtitleTrack, state: RoomState }
   * - POST ENDPOINTS.HOST_PAIRING -> (x-host-token or localhost) { ok: true, code: string, expiresAt: number }
   * - POST ENDPOINTS.HOST_REDEEM_PAIRING -> body: { code: string } -> { ok: true, hostToken: string } (single-use)
   * - GET  `${ENDPOINTS.SUBTITLE_BASE}/${subtitleId}.vtt?offset=${sec}` -> text/vtt
   * - GET  ENDPOINTS.TUNNEL -> { publicUrl: string|null, lanUrl: string, guestUrl: string, qrCodeDataUrl: string|null, status: string }
   * - GET  ENDPOINTS.HOST_TUNNEL -> (x-host-token or localhost) { ...publicTunnel, hostMobileUrl: string, hostQrCodeDataUrl: string|null }
   * - GET  `${ENDPOINTS.HLS_BASE}/${sessionId}/playlist.m3u8` -> application/vnd.apple.mpegurl
   */
  const ENDPOINTS = Object.freeze({
    MOVIES: '/api/movies',
    HOST_BOOTSTRAP: '/api/host/bootstrap',
    HOST_ADD_FOLDER: '/api/host/add-folder',
    HOST_SELECT_MOVIE: '/api/host/select-movie',
    HOST_UPLOAD_SUBTITLE: '/api/host/upload-subtitle',
    HOST_PAIRING: '/api/host/pairing',
    HOST_REDEEM_PAIRING: '/api/host/redeem-pairing',
    HOST_TUNNEL: '/api/host/tunnel',
    SUBTITLE_BASE: '/api/subtitles',
    TUNNEL: '/api/tunnel',
    HLS_BASE: '/hls'
  });

  /**
   * Socket.io event names and payload shapes.
   *
   * - ROOM_JOIN:        { role: 'host' | 'guest', hostToken?: string, displayName: string }
   * - ROOM_STATE:       { movieId, movieTitle, duration, streamUrl, streamEpoch, baseOffset, currentTime, isPlaying, audioTracks, selectedAudioIndex, subtitleTracks, selectedSubtitleId, subtitleUrl, updatedAt, hostConnected, guestConnected, users }
   * - HOST_COMMAND:     { action: 'play' | 'pause' | 'seek' | 'set-audio' | 'set-subtitle', currentTime?: number, audioIndex?: number, subtitleId?: string|null }
   * - HOST_TIME_UPDATE: { currentTime: number, isPlaying: boolean }
   * - SYNC_PULSE:       { hostTime: number, isPlaying: boolean, streamEpoch: number, baseOffset: number, serverTimestamp: number }
   * - HOST_ERROR:       { code: string, message: string }
   * - CHAT_MESSAGE:     { id: string, sender: string, role: 'host' | 'guest', text: string, timestamp: number }
   * - CHAT_REACTION:    { emoji: string, sender: string, role: 'host' | 'guest' }
   * - WEBRTC_SIGNAL:    { type: 'offer' | 'answer' | 'candidate' | 'call-state', payload: any, fromRole?: 'host' | 'guest' }
   */
  const SOCKET_EVENTS = Object.freeze({
    ROOM_JOIN: 'room:join',
    ROOM_STATE: 'room:state',
    HOST_COMMAND: 'host:command',
    HOST_TIME_UPDATE: 'host:time-update',
    SYNC_PULSE: 'sync:pulse',
    HOST_ERROR: 'host:error',
    CHAT_MESSAGE: 'chat:message',
    CHAT_REACTION: 'chat:reaction',
    WEBRTC_SIGNAL: 'webrtc:signal'
  });

  const REACTIONS = Object.freeze(['❤️', '🥰', '😂', '😱', '🔥', '😢']);

  return Object.freeze({
    ENDPOINTS,
    SOCKET_EVENTS,
    REACTIONS
  });
});
