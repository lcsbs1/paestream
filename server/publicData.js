'use strict';

/**
 * Strip filesystem paths and other host-only fields before sending data to clients.
 */
function sanitizeSubtitleTrackForClient(track) {
  if (!track || typeof track !== 'object') return null;
  return {
    id: track.id,
    movieId: track.movieId,
    source: track.source,
    filename: track.filename,
    format: track.format,
    language: track.language,
    title: track.title,
    label: track.label,
    subIndex: track.subIndex
  };
}

function sanitizeMovieForClient(movie) {
  if (!movie || typeof movie !== 'object') return null;
  return {
    id: movie.id,
    title: movie.title,
    filename: movie.filename,
    folder: movie.folder,
    sizeBytes: movie.sizeBytes,
    mtimeMs: movie.mtimeMs,
    duration: movie.duration,
    videoCodec: movie.videoCodec,
    pixFmt: movie.pixFmt,
    width: movie.width,
    height: movie.height,
    needsTranscode: movie.needsTranscode,
    audioTracks: Array.isArray(movie.audioTracks) ? movie.audioTracks : [],
    subtitleTracks: Array.isArray(movie.subtitleTracks)
      ? movie.subtitleTracks.map(sanitizeSubtitleTrackForClient).filter(Boolean)
      : []
  };
}

function sanitizeMoviesPayload(payload) {
  const movies = Array.isArray(payload && payload.movies)
    ? payload.movies.map(sanitizeMovieForClient).filter(Boolean)
    : [];
  const folders = Array.isArray(payload && payload.folders) ? payload.folders.slice() : [];
  return { movies, folders };
}

function sanitizeRoomStateForClient(state) {
  if (!state || typeof state !== 'object') return state;
  return {
    ...state,
    subtitleTracks: Array.isArray(state.subtitleTracks)
      ? state.subtitleTracks.map(sanitizeSubtitleTrackForClient).filter(Boolean)
      : []
  };
}

module.exports = {
  sanitizeSubtitleTrackForClient,
  sanitizeMovieForClient,
  sanitizeMoviesPayload,
  sanitizeRoomStateForClient
};
