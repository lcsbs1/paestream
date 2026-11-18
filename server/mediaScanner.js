'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const WINGET_FFMPEG_BIN =
  'C:\\Users\\lucas-pc\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);
const BITMAP_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
  'dvb_teletext'
]);

const LANGUAGE_NAMES = {
  por: 'Português',
  pob: 'Português (BR)',
  pt: 'Português',
  'pt-br': 'Português (BR)',
  eng: 'Inglês',
  en: 'Inglês',
  spa: 'Espanhol',
  es: 'Espanhol',
  jpn: 'Japonês',
  ja: 'Japonês',
  fre: 'Francês',
  fra: 'Francês',
  fr: 'Francês',
  ger: 'Alemão',
  deu: 'Alemão',
  de: 'Alemão',
  ita: 'Italiano',
  it: 'Italiano',
  kor: 'Coreano',
  ko: 'Coreano',
  chi: 'Chinês',
  zho: 'Chinês',
  rus: 'Russo',
  und: 'Padrão'
};

function shortHash(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 12);
}

function timingSafeMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function normalizePathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function formatLanguage(lang) {
  if (!lang) return 'Padrão';
  const key = String(lang).trim().toLowerCase();
  return LANGUAGE_NAMES[key] || lang.toUpperCase();
}

function formatChannels(channels) {
  if (channels === 1) return 'Mono';
  if (channels === 2) return '2.0';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return channels ? `${channels}ch` : '';
}

function buildAudioLabel(track) {
  const parts = [`Faixa ${track.index + 1}`];
  const langName = formatLanguage(track.language);
  if (track.title && track.title.toLowerCase() !== langName.toLowerCase()) {
    parts.push(`${langName} — ${track.title}`);
  } else {
    parts.push(langName);
  }
  const tech = [track.codec ? track.codec.toUpperCase() : '', formatChannels(track.channels)]
    .filter(Boolean)
    .join(' ');
  return tech ? `${parts.join(' · ')} (${tech})` : parts.join(' · ');
}

function buildSubtitleLabel({ source, index, language, title, filename }) {
  if (source === 'external' && filename) {
    return `${filename} (Externa)`;
  }
  if (source === 'uploaded' && filename) {
    return `${filename} (Enviada)`;
  }
  const langName = formatLanguage(language);
  const base = title ? `${langName} — ${title}` : langName;
  return `Legenda ${index + 1} · ${base}`;
}

/**
 * Find ffmpeg and ffprobe binaries in PATH, known WinGet directory, or project bin/.
 * @param {{ rootDir?: string }} [options]
 * @returns {{ ffmpegPath: string, ffprobePath: string }}
 */
function resolveFfmpegBinaries(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const candidates = [];

  if (process.env.FFMPEG_PATH) {
    candidates.push(path.dirname(process.env.FFMPEG_PATH));
  }
  candidates.push(path.join(rootDir, 'bin'));

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  candidates.push(...pathEntries);
  candidates.push(WINGET_FFMPEG_BIN);

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const wingetPkgRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    try {
      const pkgs = fs.readdirSync(wingetPkgRoot);
      for (const pkg of pkgs) {
        if (pkg.startsWith('Gyan.FFmpeg')) {
          const pkgDir = path.join(wingetPkgRoot, pkg);
          const subEntries = fs.readdirSync(pkgDir);
          for (const sub of subEntries) {
            candidates.push(path.join(pkgDir, sub, 'bin'));
          }
        }
      }
    } catch {
      // WinGet packages folder does not exist or is unreadable.
    }
  }

  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const findBinary = (name, envOverride) => {
    if (envOverride && fs.existsSync(envOverride)) {
      return envOverride;
    }
    const target = `${name}${exeSuffix}`;
    for (const dir of candidates) {
      if (!dir) continue;
      const fullPath = path.join(dir, target);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
    return target;
  };

  return {
    ffmpegPath: findBinary('ffmpeg', process.env.FFMPEG_PATH),
    ffprobePath: findBinary('ffprobe', process.env.FFPROBE_PATH)
  };
}

function guessLanguageFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (/\.(pt-br|pob|ptbr|pt|por)\.(srt|vtt)$/.test(lower)) return 'pt-br';
  if (/\.(en|eng)\.(srt|vtt)$/.test(lower)) return 'eng';
  if (/\.(es|spa)\.(srt|vtt)$/.test(lower)) return 'spa';
  return 'und';
}

function createMediaScanner({ rootDir }) {
  const resolvedRoot = path.resolve(rootDir);
  const moviesDir = path.join(resolvedRoot, 'movies');
  const dataDir = path.join(resolvedRoot, 'data');
  const configPath = path.join(dataDir, 'config.json');
  const binaries = resolveFfmpegBinaries({ rootDir: resolvedRoot });

  const probeCache = new Map();
  const uploadedSubtitlesByMovieId = new Map();
  let moviesList = [];
  let moviesById = new Map();
  let subtitlesById = new Map();

  function ensureBaseDirectories() {
    fs.mkdirSync(moviesDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function loadConfig() {
    ensureBaseDirectories();
    let config = null;
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch {
      config = null;
    }

    let dirty = false;
    if (!config || typeof config !== 'object') {
      config = {};
      dirty = true;
    }
    if (typeof config.hostToken !== 'string' || config.hostToken.length < 16) {
      config.hostToken = crypto.randomBytes(24).toString('hex');
      dirty = true;
    }
    if (!Array.isArray(config.extraFolders)) {
      config.extraFolders = [];
      dirty = true;
    }
    if (dirty) {
      saveConfig(config);
    }
    return config;
  }

  function saveConfig(config) {
    ensureBaseDirectories();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  function getHostToken() {
    return loadConfig().hostToken;
  }

  function getSearchFolders() {
    const config = loadConfig();
    const seen = new Set();
    const folders = [];

    for (const candidate of [moviesDir, ...config.extraFolders]) {
      if (!candidate) continue;
      const resolved = path.resolve(candidate);
      const key = normalizePathKey(resolved);
      if (seen.has(key)) continue;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        seen.add(key);
        folders.push(resolved);
      }
    }
    return folders;
  }

  async function probeVideoFile(filePath) {
    const stat = fs.statSync(filePath);
    const cacheKey = `${normalizePathKey(filePath)}|${stat.mtimeMs}|${stat.size}`;
    if (probeCache.has(cacheKey)) {
      return probeCache.get(cacheKey);
    }

    const { stdout } = await execFileAsync(
      binaries.ffprobePath,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 20000, maxBuffer: 16 * 1024 * 1024 }
    );

    const parsed = JSON.parse(stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const format = parsed.format || {};

    const videoStream = streams.find((s) => s.codec_type === 'video');
    const duration =
      Number(format.duration) || Number(videoStream && videoStream.duration) || 0;
    const videoCodec = ((videoStream && videoStream.codec_name) || 'unknown').toLowerCase();
    const pixFmt = ((videoStream && videoStream.pix_fmt) || '').toLowerCase();
    const width = Number((videoStream && videoStream.width) || 0);
    const height = Number((videoStream && videoStream.height) || 0);

    const audioTracks = streams
      .filter((s) => s.codec_type === 'audio')
      .map((s, idx) => {
        const tags = s.tags || {};
        const track = {
          index: idx,
          streamIndex: s.index,
          codec: (s.codec_name || 'unknown').toLowerCase(),
          language: tags.language || tags.LANGUAGE || 'und',
          title: tags.title || tags.TITLE || '',
          channels: Number(s.channels) || 2
        };
        track.label = buildAudioLabel(track);
        return track;
      });

    const embeddedSubtitles = [];
    let subOrd = 0;
    for (const s of streams) {
      if (s.codec_type !== 'subtitle') continue;
      const codec = (s.codec_name || '').toLowerCase();
      const currentOrd = subOrd++;
      if (BITMAP_SUBTITLE_CODECS.has(codec)) continue;
      const tags = s.tags || {};
      embeddedSubtitles.push({
        subIndex: currentOrd,
        streamIndex: s.index,
        format: codec || 'subrip',
        language: tags.language || tags.LANGUAGE || 'und',
        title: tags.title || tags.TITLE || ''
      });
    }

    const result = {
      duration: Number.isFinite(duration) ? duration : 0,
      videoCodec,
      pixFmt,
      width,
      height,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      audioTracks,
      embeddedSubtitles
    };

    probeCache.set(cacheKey, result);
    return result;
  }

  function collectFoldersRecursively(rootFolders) {
    const dirMap = new Map();
    const visited = new Set();

    function walk(dirPath, depth) {
      if (depth > 8) return;
      let realPath;
      try {
        realPath = fs.realpathSync(dirPath);
      } catch {
        return;
      }
      const realKey = normalizePathKey(realPath);
      if (visited.has(realKey)) return;
      visited.add(realKey);

      let entries;
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return;
      }

      const videos = [];
      const subtitles = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const lower = entry.name.toLowerCase();
          if (lower === 'node_modules' || lower === 'temp' || lower === 'bin') continue;
          walk(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (VIDEO_EXTENSIONS.has(ext)) {
          videos.push(fullPath);
        } else if (SUBTITLE_EXTENSIONS.has(ext)) {
          subtitles.push(fullPath);
        }
      }

      if (videos.length > 0) {
        dirMap.set(dirPath, { videos, subtitles });
      }
    }

    for (const rootFolder of rootFolders) {
      walk(rootFolder, 0);
    }
    return dirMap;
  }

  function attachFolderSubtitles(movie, allFolderVideos, folderSubtitles) {
    const movieBase = path.basename(movie.path, path.extname(movie.path)).toLowerCase();
    const allBases = allFolderVideos.map((v) =>
      path.basename(v, path.extname(v)).toLowerCase()
    );

    const tracks = [];
    for (const subPath of folderSubtitles) {
      const subName = path.basename(subPath);
      const subLower = subName.toLowerCase();
      const matchesThisMovie = subLower.startsWith(movieBase);
      const matchesOtherMovie = allBases.some(
        (otherBase) => otherBase !== movieBase && subLower.startsWith(otherBase)
      );

      if (!matchesThisMovie && matchesOtherMovie) {
        continue;
      }
      if (!matchesThisMovie && allFolderVideos.length > 1) {
        continue;
      }

      const ext = path.extname(subName).toLowerCase().slice(1);
      const subId = `${movie.id}-ext-${shortHash(normalizePathKey(subPath))}`;
      const track = {
        id: subId,
        movieId: movie.id,
        source: 'external',
        path: subPath,
        filename: subName,
        format: ext,
        language: guessLanguageFromFilename(subName),
        title: path.basename(subName, path.extname(subName)),
        label: buildSubtitleLabel({ source: 'external', filename: subName })
      };
      tracks.push(track);
    }
    return tracks;
  }

  async function scanMovies() {
    ensureBaseDirectories();
    const folders = getSearchFolders();
    const dirMap = collectFoldersRecursively(folders);

    const scannedMovies = [];
    const nextMoviesById = new Map();
    const nextSubtitlesById = new Map();

    for (const [dirPath, { videos, subtitles }] of dirMap.entries()) {
      for (const videoPath of videos) {
        const movieId = shortHash(normalizePathKey(videoPath));
        const filename = path.basename(videoPath);
        const ext = path.extname(filename).toLowerCase();
        const title = path.basename(filename, ext);

        let probe;
        try {
          probe = await probeVideoFile(videoPath);
        } catch {
          continue;
        }

        const embeddedTracks = probe.embeddedSubtitles.map((sub, idx) => ({
          id: `${movieId}-emb-${sub.subIndex}`,
          movieId,
          source: 'embedded',
          subIndex: sub.subIndex,
          streamIndex: sub.streamIndex,
          format: sub.format,
          language: sub.language,
          title: sub.title,
          label: buildSubtitleLabel({
            source: 'embedded',
            index: idx,
            language: sub.language,
            title: sub.title
          })
        }));

        const externalTracks = attachFolderSubtitles(
          { id: movieId, path: videoPath },
          videos,
          subtitles
        );
        const uploadedTracks = uploadedSubtitlesByMovieId.get(movieId) || [];

        const subtitleTracks = [...embeddedTracks, ...externalTracks, ...uploadedTracks];
        for (const st of subtitleTracks) {
          nextSubtitlesById.set(st.id, st);
        }

        const needsTranscode = !(
          probe.videoCodec === 'h264' &&
          probe.pixFmt === 'yuv420p' &&
          ext !== '.avi'
        );

        const movieItem = {
          id: movieId,
          title,
          filename,
          path: videoPath,
          folder: dirPath,
          sizeBytes: probe.sizeBytes,
          mtimeMs: probe.mtimeMs,
          duration: probe.duration,
          videoCodec: probe.videoCodec,
          pixFmt: probe.pixFmt,
          width: probe.width,
          height: probe.height,
          needsTranscode,
          audioTracks: probe.audioTracks,
          subtitleTracks
        };

        scannedMovies.push(movieItem);
        nextMoviesById.set(movieId, movieItem);
      }
    }

    scannedMovies.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
    moviesList = scannedMovies;
    moviesById = nextMoviesById;
    subtitlesById = nextSubtitlesById;

    return {
      movies: moviesList,
      folders
    };
  }

  async function addFolder(folderPath) {
    if (typeof folderPath !== 'string' || !folderPath.trim()) {
      const err = new Error('Caminho da pasta é obrigatório.');
      err.statusCode = 400;
      throw err;
    }

    const resolved = path.resolve(folderPath.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      const err = new Error(`Pasta não encontrada: ${resolved}`);
      err.statusCode = 404;
      throw err;
    }

    const config = loadConfig();
    const targetKey = normalizePathKey(resolved);
    const existingKeys = new Set(
      [moviesDir, ...config.extraFolders].map((dir) => normalizePathKey(dir))
    );

    if (!existingKeys.has(targetKey)) {
      config.extraFolders.push(resolved);
      saveConfig(config);
    }

    const result = await scanMovies();
    return {
      folderPath: resolved,
      folders: result.folders,
      movies: result.movies
    };
  }

  function registerUploadedSubtitle(movieId, subtitleTrack) {
    const list = uploadedSubtitlesByMovieId.get(movieId) || [];
    const filtered = list.filter((item) => item.id !== subtitleTrack.id);
    filtered.push(subtitleTrack);
    uploadedSubtitlesByMovieId.set(movieId, filtered);

    subtitlesById.set(subtitleTrack.id, subtitleTrack);
    const movie = moviesById.get(movieId);
    if (movie) {
      movie.subtitleTracks = [
        ...movie.subtitleTracks.filter((item) => item.id !== subtitleTrack.id),
        subtitleTrack
      ];
    }
    return subtitleTrack;
  }

  return {
    binaries,
    moviesDir,
    dataDir,
    configPath,
    loadConfig,
    getHostToken,
    getSearchFolders,
    scanMovies,
    addFolder,
    registerUploadedSubtitle,
    getMovies: () => moviesList,
    getMovieById: (id) => moviesById.get(id) || null,
    getSubtitleById: (id) => subtitlesById.get(id) || null
  };
}

module.exports = {
  createMediaScanner,
  resolveFfmpegBinaries,
  timingSafeMatch
};
