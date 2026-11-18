'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeRemoveDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best-effort cleanup on Windows.
  }
}

function createHlsManager({ rootDir, ffmpegPath, hlsBasePath = '/hls' }) {
  const resolvedRoot = path.resolve(rootDir);
  const hlsRootDir = path.join(resolvedRoot, 'temp', 'hls');
  fs.mkdirSync(hlsRootDir, { recursive: true });

  // Clean stale HLS sessions from previous runs on boot.
  try {
    for (const entry of fs.readdirSync(hlsRootDir)) {
      safeRemoveDir(path.join(hlsRootDir, entry));
    }
  } catch {
    // Ignore cleanup errors on startup.
  }

  let currentSession = null;
  let streamEpoch = 0;
  let nvencBroken = false;
  let opQueue = Promise.resolve();

  function withLock(fn) {
    const next = opQueue.then(fn, fn);
    opQueue = next.catch(() => {});
    return next;
  }

  async function terminateProcessCleanly(session) {
    if (!session || !session.process || session.closed) return;
    const proc = session.process;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      await session.closedPromise;
      return;
    }

    session.stopping = true;
    try {
      if (proc.stdin && !proc.stdin.destroyed && proc.stdin.writable) {
        proc.stdin.write('q\n');
        proc.stdin.end();
      }
    } catch {
      // Ignore stdin write failure if FFmpeg already exited.
    }

    const exitedGracefully = await Promise.race([
      session.closedPromise.then(() => true),
      sleep(700).then(() => false)
    ]);

    if (!exitedGracefully && proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Ignore kill error.
      }
      if (process.platform === 'win32' && proc.pid) {
        await Promise.race([
          session.closedPromise,
          new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => resolve());
          })
        ]);
      }
      await Promise.race([session.closedPromise, sleep(800)]);
    }
  }

  function buildFfmpegArgs({ movie, baseOffset, audioIndex, sessionDir, useLibx264Fallback }) {
    const args = ['-hide_banner', '-loglevel', 'warning'];

    if (baseOffset > 0) {
      args.push('-ss', String(baseOffset));
    }

    args.push('-i', movie.path);

    const ext = path.extname(movie.filename || movie.path).toLowerCase();
    const canCopyVideo =
      movie.videoCodec === 'h264' &&
      movie.pixFmt === 'yuv420p' &&
      baseOffset === 0 &&
      ext !== '.avi';

    if (canCopyVideo) {
      args.push('-c:v', 'copy');
    } else if (!useLibx264Fallback && !nvencBroken) {
      args.push(
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p3',
        '-profile:v',
        'main',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '48',
        '-keyint_min',
        '48',
        '-b:v',
        '4500k',
        '-maxrate',
        '6000k',
        '-bufsize',
        '12000k'
      );
    } else {
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '48',
        '-sc_threshold',
        '0'
      );
    }

    if (movie.audioTracks && movie.audioTracks.length > 0) {
      const safeAudioIdx = Math.max(0, Math.min(audioIndex, movie.audioTracks.length - 1));
      args.push(
        '-map',
        '0:v:0',
        '-map',
        `0:a:${safeAudioIdx}`,
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-b:a',
        '192k',
        '-ar',
        '48000'
      );
    } else {
      args.push('-map', '0:v:0', '-an');
    }

    args.push(
      '-sn',
      '-f',
      'hls',
      '-hls_time',
      '2',
      '-hls_list_size',
      '0',
      '-hls_playlist_type',
      'event',
      '-hls_flags',
      'independent_segments',
      '-hls_segment_filename',
      path.join(sessionDir, 'seg_%05d.ts'),
      path.join(sessionDir, 'playlist.m3u8')
    );

    return { args, triedNvenc: !canCopyVideo && !useLibx264Fallback && !nvencBroken };
  }

  function hasReadySegment(sessionDir) {
    const playlistPath = path.join(sessionDir, 'playlist.m3u8');
    if (!fs.existsSync(playlistPath)) return false;

    let content;
    try {
      content = fs.readFileSync(playlistPath, 'utf8');
    } catch {
      return false;
    }

    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const firstSegment = lines.find((line) => !line.startsWith('#') && line.endsWith('.ts'));
    if (!firstSegment) return false;

    const segPath = path.join(sessionDir, firstSegment);
    try {
      const stat = fs.statSync(segPath);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  async function spawnHlsProcess({ movie, baseOffset, audioIndex, sessionDir, useLibx264Fallback }) {
    fs.mkdirSync(sessionDir, { recursive: true });
    const { args, triedNvenc } = buildFfmpegArgs({
      movie,
      baseOffset,
      audioIndex,
      sessionDir,
      useLibx264Fallback
    });

    const stderrChunks = [];
    const proc = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    });
    if (proc.stdin) {
      proc.stdin.on('error', () => {});
    }

    const sessionHandle = {
      movieId: movie.id,
      baseOffset,
      audioIndex,
      sessionDir,
      process: proc,
      stopping: false,
      finishedSuccessfully: false,
      exitCode: null,
      closed: false,
      closedPromise: null
    };

    sessionHandle.closedPromise = new Promise((resolve) => {
      proc.on('close', (code) => {
        sessionHandle.closed = true;
        sessionHandle.exitCode = code;
        if (code === 0 && !sessionHandle.stopping) {
          sessionHandle.finishedSuccessfully = true;
        }
        resolve(code);
      });
      proc.on('error', () => {
        sessionHandle.closed = true;
        sessionHandle.exitCode = -1;
        resolve(-1);
      });
    });

    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderrChunks.push(chunk.toString('utf8'));
        if (stderrChunks.length > 40) stderrChunks.shift();
      });
    }

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (hasReadySegment(sessionDir)) {
        return sessionHandle;
      }
      if (sessionHandle.closed) {
        if (sessionHandle.stopping) {
          throw new Error('Transcodificação cancelada.');
        }
        const stderrText = stderrChunks.join('');
        if (triedNvenc) {
          nvencBroken = true;
          safeRemoveDir(sessionDir);
          fs.mkdirSync(sessionDir, { recursive: true });
          return spawnHlsProcess({
            movie,
            baseOffset,
            audioIndex,
            sessionDir,
            useLibx264Fallback: true
          });
        }
        if (sessionHandle.exitCode === 0 && fs.existsSync(path.join(sessionDir, 'playlist.m3u8'))) {
          return sessionHandle;
        }
        throw new Error(`FFmpeg falhou ao gerar HLS (código ${sessionHandle.exitCode}): ${stderrText.slice(-500)}`);
      }
      await sleep(80);
    }

    await terminateProcessCleanly(sessionHandle);
    throw new Error('Tempo limite aguardando playlist.m3u8 e primeiro segmento .ts do FFmpeg.');
  }

  async function startSessionInternal({ movie, startTime = 0, audioIndex = 0 }) {
    const previousSession = currentSession;
    if (previousSession) {
      await terminateProcessCleanly(previousSession);
      safeRemoveDir(previousSession.sessionDir);
      currentSession = null;
    }

    const safeStart = Math.max(0, Number(startTime) || 0);
    const baseOffset = safeStart <= 0.1 ? 0 : Math.round(safeStart * 10) / 10;
    const safeAudioIndex =
      movie.audioTracks && movie.audioTracks.length > 0
        ? Math.max(0, Math.min(Number(audioIndex) || 0, movie.audioTracks.length - 1))
        : 0;

    streamEpoch += 1;
    const sessionId = `${movie.id}-e${streamEpoch}-${crypto.randomBytes(3).toString('hex')}`;
    const sessionDir = path.join(hlsRootDir, sessionId);

    const handle = await spawnHlsProcess({
      movie,
      baseOffset,
      audioIndex: safeAudioIndex,
      sessionDir,
      useLibx264Fallback: false
    });

    handle.sessionId = sessionId;
    handle.streamEpoch = streamEpoch;
    handle.streamUrl = `${hlsBasePath}/${sessionId}/playlist.m3u8`;
    currentSession = handle;

    return {
      sessionId,
      streamEpoch,
      baseOffset,
      selectedAudioIndex: safeAudioIndex,
      streamUrl: handle.streamUrl
    };
  }

  function getTranscodedEnd() {
    if (!currentSession) return 0;
    const playlistPath = path.join(currentSession.sessionDir, 'playlist.m3u8');
    if (!fs.existsSync(playlistPath)) return currentSession.baseOffset;

    let content = '';
    try {
      content = fs.readFileSync(playlistPath, 'utf8');
    } catch {
      return currentSession.baseOffset;
    }

    let total = 0;
    const regex = /#EXTINF:([0-9.]+),/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      total += Number(match[1]) || 0;
    }
    return currentSession.baseOffset + total;
  }

  function isTimeReadyInCurrentSession(targetTime) {
    if (!currentSession) return false;
    if (targetTime < currentSession.baseOffset) return false;
    if (currentSession.finishedSuccessfully) return true;
    const transcodedEnd = getTranscodedEnd();
    return targetTime <= transcodedEnd - 0.5;
  }

  async function startMovie({ movie, startTime = 0, audioIndex = 0 }) {
    return withLock(() => startSessionInternal({ movie, startTime, audioIndex }));
  }

  async function seek({ movie, targetTime, audioIndex }) {
    return withLock(async () => {
      const clamped = Math.max(
        0,
        movie.duration > 0 ? Math.min(targetTime, Math.max(0, movie.duration - 0.25)) : targetTime
      );
      if (
        currentSession &&
        currentSession.movieId === movie.id &&
        currentSession.audioIndex === audioIndex &&
        isTimeReadyInCurrentSession(clamped)
      ) {
        return {
          restarted: false,
          sessionId: currentSession.sessionId,
          streamEpoch: currentSession.streamEpoch,
          baseOffset: currentSession.baseOffset,
          selectedAudioIndex: currentSession.audioIndex,
          streamUrl: currentSession.streamUrl
        };
      }

      const started = await startSessionInternal({
        movie,
        startTime: clamped,
        audioIndex
      });
      return { restarted: true, ...started };
    });
  }

  async function setAudio({ movie, currentTime, audioIndex }) {
    return withLock(async () => {
      const started = await startSessionInternal({
        movie,
        startTime: Math.max(0, currentTime || 0),
        audioIndex
      });
      return { restarted: true, ...started };
    });
  }

  function resolveSegmentFile(sessionId, filename) {
    const safeSession = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const safeFile = path.basename(String(filename || ''));
    if (!safeSession || !safeFile) return null;
    if (!safeFile.endsWith('.m3u8') && !safeFile.endsWith('.ts')) return null;

    const fullPath = path.join(hlsRootDir, safeSession, safeFile);
    if (!fs.existsSync(fullPath)) return null;
    return fullPath;
  }

  async function shutdown() {
    return withLock(async () => {
      if (currentSession) {
        await terminateProcessCleanly(currentSession);
        safeRemoveDir(currentSession.sessionDir);
        currentSession = null;
      }
    });
  }

  return {
    startMovie,
    seek,
    setAudio,
    resolveSegmentFile,
    shutdown,
    getCurrentSession: () => currentSession
  };
}

module.exports = {
  createHlsManager
};
