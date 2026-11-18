'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');

const { ENDPOINTS } = require('../shared/contract');
const { createMediaScanner, timingSafeMatch } = require('./mediaScanner');
const { createSubtitleService } = require('./subtitleService');
const { createHlsManager } = require('./hlsManager');
const { createRoomSync } = require('./roomSync');
const { createTunnelManager } = require('./tunnelManager');
const { createHostPairing } = require('./hostPairing');
const {
  sanitizeMoviesPayload,
  sanitizeSubtitleTrackForClient,
  sanitizeRoomStateForClient
} = require('./publicData');

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = [
  'cf-connecting-ip',
  'cf-ray',
  'x-forwarded-for',
  'forwarded',
  'x-real-ip'
];

function extractHostHeaderName(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const endBracket = trimmed.indexOf(']');
    return endBracket !== -1 ? trimmed.slice(0, endBracket + 1) : trimmed;
  }
  const colonIdx = trimmed.indexOf(':');
  return colonIdx !== -1 ? trimmed.slice(0, colonIdx) : trimmed;
}

function isLocalhostRequest(req) {
  const remoteAddr = req.socket && req.socket.remoteAddress;
  if (!LOCALHOST_IPS.has(remoteAddr)) {
    return false;
  }

  for (const headerName of PROXY_HEADERS) {
    if (req.headers[headerName]) {
      return false;
    }
  }

  const hostName = extractHostHeaderName(req.headers.host);
  return hostName === 'localhost' || hostName === '127.0.0.1' || hostName === '[::1]';
}

async function startServer(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
  const port = options.port !== undefined ? Number(options.port) : Number(process.env.PORT) || 3000;
  const enableTunnel =
    options.enableTunnel !== undefined
      ? options.enableTunnel
      : process.env.PAESTREAM_DISABLE_TUNNEL !== '1';

  const mediaScanner = createMediaScanner({ rootDir });
  const hostToken = mediaScanner.getHostToken();
  const subtitleService = createSubtitleService({ rootDir, mediaScanner });
  const hlsManager = createHlsManager({
    rootDir,
    ffmpegPath: mediaScanner.binaries.ffmpegPath,
    hlsBasePath: ENDPOINTS.HLS_BASE
  });

  await mediaScanner.scanMovies();

  const app = express();
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  const hostPairing = createHostPairing({ getHostToken: () => hostToken });

  const roomSync = createRoomSync({
    io,
    mediaScanner,
    hlsManager,
    getHostToken: () => hostToken
  });

  const redeemRateLimiter = (() => {
    const hits = new Map();
    return (key) => {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || now - entry.start >= 60_000) {
        entry = { start: now, count: 0 };
        hits.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= 10;
    };
  })();

  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'x-host-token', 'Range']
    })
  );
  app.use(express.json({ limit: '15mb' }));

  const publicDir = path.join(rootDir, 'public');
  const sharedDir = path.join(rootDir, 'shared');
  fs.mkdirSync(publicDir, { recursive: true });

  app.use('/shared', express.static(sharedDir));
  app.use(express.static(publicDir));

  function hasValidHostToken(req) {
    const token = req.get('x-host-token');
    return timingSafeMatch(token, hostToken);
  }

  function requireHostToken(req, res, next) {
    if (!hasValidHostToken(req)) {
      return res.status(403).json({
        error: 'Acesso negado: apenas o Host autorizado pode executar esta ação.'
      });
    }
    return next();
  }

  app.get(ENDPOINTS.HOST_BOOTSTRAP, (req, res) => {
    if (!isLocalhostRequest(req)) {
      return res.status(403).json({
        error: 'Bootstrap disponível apenas localmente no computador Host.'
      });
    }
    return res.json({ hostToken });
  });

  app.get(ENDPOINTS.MOVIES, requireHostToken, async (req, res) => {
    try {
      const data = await mediaScanner.scanMovies();
      return res.json(sanitizeMoviesPayload(data));
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Erro ao escanear filmes.' });
    }
  });

  app.post(ENDPOINTS.HOST_ADD_FOLDER, requireHostToken, async (req, res) => {
    try {
      const { folderPath } = req.body || {};
      const result = await mediaScanner.addFolder(folderPath);
      return res.json({
        ok: true,
        folderPath: result.folderPath,
        ...sanitizeMoviesPayload(result)
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  app.post(ENDPOINTS.HOST_SELECT_MOVIE, requireHostToken, async (req, res) => {
    try {
      const { movieId, audioIndex, subtitleId, startTime } = req.body || {};
      if (!movieId) {
        return res.status(400).json({ error: 'movieId é obrigatório.' });
      }
      const state = await roomSync.selectMovie({
        movieId,
        audioIndex,
        subtitleId,
        startTime
      });
      return res.json({ ok: true, state: sanitizeRoomStateForClient(state) });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  app.post(ENDPOINTS.HOST_UPLOAD_SUBTITLE, requireHostToken, (req, res) => {
    try {
      const { movieId, filename, content } = req.body || {};
      const subtitleTrack = subtitleService.uploadSubtitle({ movieId, filename, content });
      const state = roomSync.onSubtitleUploaded(movieId, subtitleTrack);
      return res.json({
        ok: true,
        subtitleTrack: sanitizeSubtitleTrackForClient(subtitleTrack),
        state: sanitizeRoomStateForClient(state)
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  app.post(ENDPOINTS.HOST_PAIRING, (req, res) => {
    if (!hasValidHostToken(req) && !isLocalhostRequest(req)) {
      return res.status(403).json({ error: 'Acesso negado ao pareamento do Host.' });
    }
    const pairing = hostPairing.createCode();
    return res.json({
      ok: true,
      code: pairing.code,
      expiresAt: pairing.expiresAt
    });
  });

  app.post(ENDPOINTS.HOST_REDEEM_PAIRING, (req, res) => {
    const clientKey = String(
      (req.socket && req.socket.remoteAddress) || req.ip || 'unknown'
    );
    if (!redeemRateLimiter(clientKey)) {
      return res.status(429).json({ error: 'Muitas tentativas de pareamento. Aguarde um minuto.' });
    }
    try {
      const { code } = req.body || {};
      const redeemed = hostPairing.redeemCode(code);
      return res.json({ ok: true, hostToken: redeemed.hostToken });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  app.get(`${ENDPOINTS.SUBTITLE_BASE}/:subtitleFile`, async (req, res) => {
    try {
      const rawParam = String(req.params.subtitleFile || '');
      const subtitleId = rawParam.replace(/\.vtt$/i, '');
      const offset = Number(req.query.offset) || 0;
      const vtt = await subtitleService.getSubtitleVtt(subtitleId, offset);

      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(vtt);
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  app.get(`${ENDPOINTS.HLS_BASE}/:sessionId/:filename`, (req, res) => {
    const filePath = hlsManager.resolveSegmentFile(req.params.sessionId, req.params.filename);
    if (!filePath) {
      return res.status(404).end();
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    return res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        res.status(err.statusCode || 404).end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const addressInfo = httpServer.address();
  const actualPort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;

  const tunnelManager = createTunnelManager({
    rootDir,
    port: actualPort,
    enabled: enableTunnel,
    createHostPairingCode: () => hostPairing.createCode()
  });

  app.get(ENDPOINTS.TUNNEL, (req, res) => {
    return res.json(tunnelManager.getPublicInfo());
  });

  app.get(ENDPOINTS.HOST_TUNNEL, (req, res) => {
    if (!hasValidHostToken(req) && !isLocalhostRequest(req)) {
      return res.status(403).json({ error: 'Acesso negado ao link privado do Host.' });
    }
    const hostInfo = tunnelManager.getHostInfo();
    return res.json(hostInfo);
  });

  await tunnelManager.start();

  async function close() {
    await tunnelManager.stop();
    await hlsManager.shutdown();
    await new Promise((resolve) => io.close(() => resolve()));
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return {
    app,
    httpServer,
    io,
    port: actualPort,
    hostToken,
    mediaScanner,
    hlsManager,
    subtitleService,
    roomSync,
    tunnelManager,
    close
  };
}

if (require.main === module) {
  startServer()
    .then((server) => {
      const localUrl = `http://localhost:${server.port}`;
      const hostMobileLocal = `${server.tunnelManager.getHostInfo().hostMobileUrl}`;
      console.log('====================================================');
      console.log('🍿 PaeStream Cinema Privado iniciado!');
      console.log(`🎬 Host PC:     ${localUrl}`);
      console.log(`🔑 Host Mobile: ${hostMobileLocal}`);
      console.log(`📁 Filmes em:   ${server.mediaScanner.moviesDir}`);
      console.log(`🎞️ FFmpeg:      ${server.mediaScanner.binaries.ffmpegPath}`);
      console.log('====================================================');

      const shutdown = async () => {
        console.log('\n[PaeStream] Encerrando servidor...');
        await server.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[PaeStream] Falha ao iniciar servidor:', err);
      process.exit(1);
    });
}

module.exports = {
  startServer,
  isLocalhostRequest
};
