'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { io: ioClient } = require('socket.io-client');

const { ENDPOINTS, SOCKET_EVENTS } = require('../shared/contract');
const { resolveFfmpegBinaries } = require('../server/mediaScanner');
const { decodeTextBuffer, normalizeToVtt, shiftVtt } = require('../server/subtitleService');
const { startServer } = require('../server/index');

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(__dirname, '..');
const MOVIES_DIR = path.join(ROOT_DIR, 'movies');
const TEMP_DIR = path.join(ROOT_DIR, 'temp');
const SAMPLE_MKV = path.join(MOVIES_DIR, '__test_sample.mkv');
const SAMPLE_SRT = path.join(TEMP_DIR, '__test_sub.srt');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(socket, eventName, predicate = () => true, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, listener);
      reject(new Error(`Timeout aguardando evento '${eventName}' (${timeoutMs}ms)`));
    }, timeoutMs);

    function listener(payload) {
      try {
        if (predicate(payload)) {
          clearTimeout(timer);
          socket.off(eventName, listener);
          resolve(payload);
        }
      } catch (err) {
        clearTimeout(timer);
        socket.off(eventName, listener);
        reject(err);
      }
    }

    socket.on(eventName, listener);
  });
}

function emitWithAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout no ack de '${eventName}'`)), 15000);
    socket.emit(eventName, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

async function generateSyntheticSampleMkv(ffmpegPath) {
  fs.mkdirSync(MOVIES_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const srtContent = [
    '1',
    '00:00:00,500 --> 00:00:01,500',
    'Olá, coração! Antes do offset.',
    '',
    '2',
    '00:00:03,000 --> 00:00:05,500',
    'Ação e emoção no PaeStream: ç, ã, õ, é!',
    '',
    '3',
    '00:00:06,000 --> 00:00:07,800',
    'Última cena com áudio em português.',
    ''
  ].join('\n');

  fs.writeFileSync(SAMPLE_SRT, srtContent, 'utf8');

  await execFileAsync(
    ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=8:size=640x360:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=8',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:duration=8',
      '-i',
      SAMPLE_SRT,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-map',
      '2:a:0',
      '-map',
      '3:s:0',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-c:s',
      'srt',
      '-metadata:s:a:0',
      'language=por',
      '-metadata:s:a:0',
      'title=Português (Teste)',
      '-metadata:s:a:1',
      'language=eng',
      '-metadata:s:a:1',
      'title=English (Test)',
      '-metadata:s:s:0',
      'language=por',
      '-metadata:s:s:0',
      'title=Português (BR)',
      SAMPLE_MKV
    ],
    { timeout: 30000 }
  );
}

async function runTests() {
  const { ffmpegPath } = resolveFfmpegBinaries({ rootDir: ROOT_DIR });
  console.log(`[verify] Gerando amostra sintética com FFmpeg (${ffmpegPath})...`);
  await generateSyntheticSampleMkv(ffmpegPath);

  // Unit check: Windows-1252 / Latin-1 PT-BR decoding & VTT shifting
  const latin1Bytes = Buffer.from('1\r\n00:00:03,000 --> 00:00:05,000\r\nCoração, ação e pão!\r\n', 'latin1');
  const decodedLatin1 = decodeTextBuffer(latin1Bytes);
  assert(decodedLatin1.includes('Coração, ação e pão!'), 'Falha na detecção Latin1/Windows-1252 PT-BR');
  const shiftedUnit = shiftVtt(normalizeToVtt(decodedLatin1), 2);
  assert(shiftedUnit.includes('00:00:01.000 --> 00:00:03.000'), 'Falha no deslocamento unitário de VTT');
  console.log('[verify] OK: Detecção UTF-8 vs Windows-1252/Latin1 e deslocamento VTT.');

  let server;
  const sockets = [];

  try {
    server = await startServer({
      rootDir: ROOT_DIR,
      port: 0,
      enableTunnel: false
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    console.log(`[verify] Servidor de teste iniciado em ${baseUrl}`);

    // 1. Test host bootstrap & security gates
    const bootRes = await fetch(`${baseUrl}${ENDPOINTS.HOST_BOOTSTRAP}`);
    assert.strictEqual(bootRes.status, 200, 'Bootstrap via localhost deve retornar 200');
    const bootJson = await bootRes.json();
    assert.strictEqual(bootJson.hostToken, server.hostToken);

    const tunnelSpoofRes = await fetch(`${baseUrl}${ENDPOINTS.HOST_BOOTSTRAP}`, {
      headers: { 'x-forwarded-for': '203.0.113.50' }
    });
    assert.strictEqual(tunnelSpoofRes.status, 403, 'Bootstrap com x-forwarded-for deve retornar 403');

    const unauthSelect = await fetch(`${baseUrl}${ENDPOINTS.HOST_SELECT_MOVIE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movieId: 'any' })
    });
    assert.strictEqual(unauthSelect.status, 403, 'POST /api/host/select-movie sem token deve retornar 403');

    const unauthAddFolder = await fetch(`${baseUrl}${ENDPOINTS.HOST_ADD_FOLDER}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: MOVIES_DIR })
    });
    assert.strictEqual(unauthAddFolder.status, 403, 'POST /api/host/add-folder sem token deve retornar 403');

    const missingAddFolder = await fetch(`${baseUrl}${ENDPOINTS.HOST_ADD_FOLDER}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': server.hostToken
      },
      body: JSON.stringify({ folderPath: path.join(ROOT_DIR, '__nonexistent_folder__') })
    });
    assert.strictEqual(missingAddFolder.status, 404, 'POST /api/host/add-folder para pasta inexistente deve retornar 404');

    const publicTunnelRes = await fetch(`${baseUrl}${ENDPOINTS.TUNNEL}`);
    const publicTunnel = await publicTunnelRes.json();
    assert(!('hostToken' in publicTunnel), 'GET /api/tunnel não pode vazar hostToken');
    assert(!('hostMobileUrl' in publicTunnel), 'GET /api/tunnel não pode vazar hostMobileUrl');

    const hostTunnelRes = await fetch(`${baseUrl}${ENDPOINTS.HOST_TUNNEL}`, {
      headers: { 'x-host-token': server.hostToken }
    });
    assert.strictEqual(hostTunnelRes.status, 200);
    const hostTunnel = await hostTunnelRes.json();
    assert(hostTunnel.hostMobileUrl.includes(server.hostToken), 'GET /api/host/tunnel deve conter hostMobileUrl com token');
    console.log('[verify] OK: Segurança de Bootstrap localhost-only e rotas POST /api/host/*.');

    // 2. Test GET /api/movies
    const moviesRes = await fetch(`${baseUrl}${ENDPOINTS.MOVIES}`);
    assert.strictEqual(moviesRes.status, 200);
    const moviesData = await moviesRes.json();
    const sampleMovie = moviesData.movies.find((m) => m.filename === '__test_sample.mkv');
    assert(sampleMovie, 'GET /api/movies deve encontrar __test_sample.mkv');
    assert.strictEqual(sampleMovie.audioTracks.length, 2, 'Deve detectar exatamente 2 faixas de áudio');
    assert(sampleMovie.subtitleTracks.length >= 1, 'Deve detectar a faixa de legenda embutida');
    assert(sampleMovie.duration >= 7 && sampleMovie.duration <= 9, `Duração inesperada: ${sampleMovie.duration}`);
    console.log(`[verify] OK: GET /api/movies detectou ${sampleMovie.audioTracks.length} áudios e ${sampleMovie.subtitleTracks.length} legenda.`);

    const embeddedSub = sampleMovie.subtitleTracks.find((s) => s.source === 'embedded');
    assert(embeddedSub, 'Legenda embutida não encontrada');

    // 3. Test POST /api/host/select-movie -> HLS + shifted VTT
    const selectRes = await fetch(`${baseUrl}${ENDPOINTS.HOST_SELECT_MOVIE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': server.hostToken
      },
      body: JSON.stringify({
        movieId: sampleMovie.id,
        audioIndex: 0,
        subtitleId: embeddedSub.id,
        startTime: 4
      })
    });
    assert.strictEqual(selectRes.status, 200, 'select-movie deve retornar 200');
    const selectJson = await selectRes.json();
    assert(selectJson.ok, 'select-movie ok deve ser true');
    assert.strictEqual(selectJson.state.baseOffset, 4, 'baseOffset deve ser 4 quando startTime=4');
    assert.strictEqual(selectJson.state.streamEpoch, 1, 'streamEpoch inicial deve ser 1');

    const m3u8Res = await fetch(`${baseUrl}${selectJson.state.streamUrl}`);
    assert.strictEqual(m3u8Res.status, 200, 'playlist.m3u8 deve responder 200');
    assert(
      (m3u8Res.headers.get('content-type') || '').includes('mpegurl'),
      'playlist.m3u8 deve ter Content-Type application/vnd.apple.mpegurl'
    );
    assert.strictEqual(m3u8Res.headers.get('cache-control'), 'no-store');
    const m3u8Text = await m3u8Res.text();
    const firstTsLine = m3u8Text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.endsWith('.ts'));
    assert(firstTsLine, 'playlist.m3u8 deve listar ao menos um segmento .ts');

    const streamDirUrl = selectJson.state.streamUrl.replace(/\/playlist\.m3u8$/, '');
    const tsRes = await fetch(`${baseUrl}${streamDirUrl}/${firstTsLine}`);
    assert.strictEqual(tsRes.status, 200, 'Segmento .ts deve responder 200');
    assert.strictEqual(tsRes.headers.get('content-type'), 'video/mp2t');
    const tsBuf = Buffer.from(await tsRes.arrayBuffer());
    assert(tsBuf.length > 0, 'Segmento .ts deve ter bytes > 0');

    // Test subtitle extraction + offset shifting
    const vttZeroRes = await fetch(`${baseUrl}${ENDPOINTS.SUBTITLE_BASE}/${embeddedSub.id}.vtt?offset=0`);
    assert.strictEqual(vttZeroRes.status, 200);
    assert((vttZeroRes.headers.get('content-type') || '').includes('text/vtt'));
    const vttZero = await vttZeroRes.text();
    assert(vttZero.startsWith('WEBVTT'), 'Legenda deve começar com WEBVTT');
    assert(vttZero.includes('Olá, coração!'), 'Acentos PT-BR devem ser preservados na legenda extraída');
    assert(vttZero.includes('ç, ã, õ, é!'), 'Caracteres especiais PT-BR devem ser preservados');

    const vttShiftedRes = await fetch(`${baseUrl}${ENDPOINTS.SUBTITLE_BASE}/${embeddedSub.id}.vtt?offset=2`);
    assert.strictEqual(vttShiftedRes.status, 200);
    const vttShifted = await vttShiftedRes.text();
    assert(!vttShifted.includes('Antes do offset'), 'Cue anterior ao offset=2 deve ser descartado');
    assert(
      vttShifted.includes('00:00:01.000 --> 00:00:03.500'),
      `Cue 2 deveria estar deslocado para 00:00:01.000 --> 00:00:03.500. Recebido:\n${vttShifted}`
    );
    console.log('[verify] OK: HLS playlist.m3u8 + .ts válidos e legenda .vtt com ?offset=2 deslocada corretamente.');

    // Test POST /api/host/upload-subtitle
    const uploadRes = await fetch(`${baseUrl}${ENDPOINTS.HOST_UPLOAD_SUBTITLE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': server.hostToken
      },
      body: JSON.stringify({
        movieId: sampleMovie.id,
        filename: 'externa-pt.srt',
        content: '1\n00:00:01,000 --> 00:00:04,000\nLegenda enviada pelo Host com coração!\n'
      })
    });
    assert.strictEqual(uploadRes.status, 200);
    const uploadJson = await uploadRes.json();
    assert(uploadJson.ok && uploadJson.subtitleTrack);
    assert.strictEqual(uploadJson.state.selectedSubtitleId, uploadJson.subtitleTrack.id);
    console.log('[verify] OK: Upload de legenda via POST /api/host/upload-subtitle.');

    // 4. Test real Socket.io host & guest clients
    const guestSocket = ioClient(baseUrl, { transports: ['websocket'] });
    const spoofSocket = ioClient(baseUrl, { transports: ['websocket'] });
    const hostSocket = ioClient(baseUrl, { transports: ['websocket'] });
    sockets.push(guestSocket, spoofSocket, hostSocket);

    await Promise.all([
      waitForEvent(guestSocket, 'connect'),
      waitForEvent(spoofSocket, 'connect'),
      waitForEvent(hostSocket, 'connect')
    ]);

    const guestJoin = await emitWithAck(guestSocket, SOCKET_EVENTS.ROOM_JOIN, {
      role: 'guest',
      displayName: 'Amor'
    });
    assert.strictEqual(guestJoin.role, 'guest');

    const spoofErrPromise = waitForEvent(
      spoofSocket,
      SOCKET_EVENTS.HOST_ERROR,
      (e) => e.code === 'INVALID_HOST_TOKEN'
    );
    const spoofJoin = await emitWithAck(spoofSocket, SOCKET_EVENTS.ROOM_JOIN, {
      role: 'host',
      hostToken: 'token-falso',
      displayName: 'Intruso'
    });
    await spoofErrPromise;
    assert.strictEqual(spoofJoin.role, 'guest', 'Host com token inválido deve ser rebaixado para guest');

    const hostJoin = await emitWithAck(hostSocket, SOCKET_EVENTS.ROOM_JOIN, {
      role: 'host',
      hostToken: server.hostToken,
      displayName: 'Lucas'
    });
    assert.strictEqual(hostJoin.role, 'host');
    assert.strictEqual(hostJoin.state.hostConnected, true);
    assert.strictEqual(hostJoin.state.guestConnected, true);

    // Guest tries unauthorized host:command & host:time-update -> MUST fail
    const forbiddenErrPromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.HOST_ERROR,
      (e) => e.code === 'FORBIDDEN'
    );
    const guestCmdAck = await emitWithAck(guestSocket, SOCKET_EVENTS.HOST_COMMAND, {
      action: 'play',
      currentTime: 0
    });
    await forbiddenErrPromise;
    assert.strictEqual(guestCmdAck.ok, false);
    assert.strictEqual(guestCmdAck.code, 'FORBIDDEN');

    const timeForbiddenPromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.HOST_ERROR,
      (e) => e.code === 'FORBIDDEN'
    );
    guestSocket.emit(SOCKET_EVENTS.HOST_TIME_UPDATE, { currentTime: 99, isPlaying: true });
    await timeForbiddenPromise;
    assert.strictEqual(server.roomSync.getPublicState().isPlaying, false, 'Comando de guest não pode alterar isPlaying');
    console.log('[verify] OK: Comandos host:command e host:time-update da Guest bloqueados com FORBIDDEN.');

    // Host commands: play -> pause -> set-audio -> seek (backward restarts FFmpeg) -> set-subtitle
    const playStatePromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.ROOM_STATE,
      (s) => s.isPlaying === true
    );
    const playAck = await emitWithAck(hostSocket, SOCKET_EVENTS.HOST_COMMAND, {
      action: 'play',
      currentTime: 4
    });
    assert(playAck.ok);
    const playState = await playStatePromise;
    assert.strictEqual(playState.isPlaying, true);

    const pauseStatePromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.ROOM_STATE,
      (s) => s.isPlaying === false
    );
    await emitWithAck(hostSocket, SOCKET_EVENTS.HOST_COMMAND, {
      action: 'pause',
      currentTime: 4.5
    });
    const pauseState = await pauseStatePromise;
    assert.strictEqual(pauseState.isPlaying, false);

    // set-audio -> audioIndex 1
    const audioStatePromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.ROOM_STATE,
      (s) => s.selectedAudioIndex === 1 && s.streamEpoch >= 2
    );
    const audioAck = await emitWithAck(hostSocket, SOCKET_EVENTS.HOST_COMMAND, {
      action: 'set-audio',
      audioIndex: 1
    });
    assert(audioAck.ok);
    const audioState = await audioStatePromise;
    assert.strictEqual(audioState.selectedAudioIndex, 1);
    const epochAfterAudio = audioState.streamEpoch;

    // seek backward from baseOffset (~4.5) to 1.0 -> must restart FFmpeg, baseOffset=1, streamEpoch++
    const seekStatePromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.ROOM_STATE,
      (s) => s.streamEpoch > epochAfterAudio && s.baseOffset === 1
    );
    const seekAck = await emitWithAck(hostSocket, SOCKET_EVENTS.HOST_COMMAND, {
      action: 'seek',
      currentTime: 1
    });
    assert(seekAck.ok);
    const seekState = await seekStatePromise;
    assert.strictEqual(seekState.baseOffset, 1);
    assert(seekState.subtitleUrl.includes('offset=1'), 'subtitleUrl deve atualizar offset para 1 após seek');

    // set-subtitle -> null -> embeddedSub.id
    const subOffPromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.ROOM_STATE,
      (s) => s.selectedSubtitleId === null && s.subtitleUrl === null
    );
    await emitWithAck(hostSocket, SOCKET_EVENTS.HOST_COMMAND, {
      action: 'set-subtitle',
      subtitleId: null
    });
    await subOffPromise;

    const subOnPromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.ROOM_STATE,
      (s) => s.selectedSubtitleId === embeddedSub.id
    );
    await emitWithAck(hostSocket, SOCKET_EVENTS.HOST_COMMAND, {
      action: 'set-subtitle',
      subtitleId: embeddedSub.id
    });
    const subOnState = await subOnPromise;
    assert(subOnState.subtitleUrl.includes(`${embeddedSub.id}.vtt?offset=1`));

    // host:time-update -> sync:pulse
    const pulsePromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.SYNC_PULSE,
      (p) => Math.abs(p.hostTime - 3.2) < 0.01
    );
    hostSocket.emit(SOCKET_EVENTS.HOST_TIME_UPDATE, { currentTime: 3.2, isPlaying: false });
    await pulsePromise;

    // Chat & Reaction & WebRTC signal relay
    const chatPromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.CHAT_MESSAGE,
      (m) => m.text === 'Pipoca pronta!' && m.role === 'host'
    );
    hostSocket.emit(SOCKET_EVENTS.CHAT_MESSAGE, { text: 'Pipoca pronta!', role: 'guest' });
    await chatPromise;

    const reactionPromise = waitForEvent(
      hostSocket,
      SOCKET_EVENTS.CHAT_REACTION,
      (r) => r.emoji === '❤️' && r.role === 'guest'
    );
    guestSocket.emit(SOCKET_EVENTS.CHAT_REACTION, { emoji: '❤️', role: 'host' });
    await reactionPromise;

    const webrtcPromise = waitForEvent(
      guestSocket,
      SOCKET_EVENTS.WEBRTC_SIGNAL,
      (sig) => sig.type === 'offer' && sig.fromRole === 'host'
    );
    hostSocket.emit(SOCKET_EVENTS.WEBRTC_SIGNAL, {
      type: 'offer',
      payload: { sdp: 'fake-sdp' }
    });
    await webrtcPromise;

    console.log('[verify] OK: Todos os comandos Socket.io (play, pause, seek, set-audio, set-subtitle, sync:pulse, chat, reações, WebRTC) validados.');
    console.log('✅ TODOS OS TESTES DO PAESTREAM PASSARAM COM 100% DE SUCESSO!');
  } finally {
    for (const sock of sockets) {
      try {
        sock.disconnect();
      } catch {
        // Ignore disconnect error.
      }
    }
    if (server) {
      await server.close();
    }
    await sleep(150);

    // Clean up test artifacts
    for (const file of [SAMPLE_MKV, SAMPLE_SRT]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        // Ignore cleanup failure.
      }
    }
    const subCacheDir = path.join(TEMP_DIR, 'subtitles');
    if (fs.existsSync(subCacheDir)) {
      try {
        fs.rmSync(subCacheDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}

runTests().catch((err) => {
  console.error('❌ FALHA NOS TESTES:', err);
  process.exit(1);
});
