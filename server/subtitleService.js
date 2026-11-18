'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const TIMESTAMP_LINE_RE =
  /^\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})(.*)$/;

/**
 * Decode a Buffer as UTF-8 if strictly valid (or BOM-marked), falling back to Windows-1252.
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return '';
  }

  // Strip UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  // Handle UTF-16 LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  // Handle UTF-16 BE BOM
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function parseTimestampToSeconds(raw) {
  const normalized = raw.trim().replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length === 3) {
    const hours = Number(parts[0]);
    const mins = Number(parts[1]);
    const secs = Number(parts[2]);
    return hours * 3600 + mins * 60 + secs;
  }
  if (parts.length === 2) {
    const mins = Number(parts[0]);
    const secs = Number(parts[1]);
    return mins * 60 + secs;
  }
  return 0;
}

function formatVttTimestamp(totalSeconds) {
  const totalMs = Math.max(0, Math.round(totalSeconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hrs = Math.floor(totalMin / 60);
  return (
    String(hrs).padStart(2, '0') +
    ':' +
    String(min).padStart(2, '0') +
    ':' +
    String(sec).padStart(2, '0') +
    '.' +
    String(ms).padStart(3, '0')
  );
}

function sanitizeCueText(text) {
  return text.replace(/<\/?font\b[^>]*>/gi, '');
}

/**
 * Convert SRT or raw VTT text into normalized WebVTT string.
 * @param {string} rawText
 * @returns {string}
 */
function normalizeToVtt(rawText) {
  const cleaned = String(rawText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = cleaned.split('\n');
  const isAlreadyVtt = lines[0] && lines[0].trim().startsWith('WEBVTT');

  if (isAlreadyVtt) {
    const out = lines.map((line) => {
      const m = TIMESTAMP_LINE_RE.exec(line);
      if (!m) return line;
      const start = formatVttTimestamp(parseTimestampToSeconds(m[1]));
      const end = formatVttTimestamp(parseTimestampToSeconds(m[2]));
      const settings = m[3] || '';
      return `${start} --> ${end}${settings}`;
    });
    return out.join('\n').trimEnd() + '\n';
  }

  const cues = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }

    // Optional numeric index line before timestamp
    let timeLineIdx = i;
    if (/^\d+$/.test(line) && i + 1 < lines.length && TIMESTAMP_LINE_RE.test(lines[i + 1])) {
      timeLineIdx = i + 1;
    }

    const match = TIMESTAMP_LINE_RE.exec(lines[timeLineIdx]);
    if (!match) {
      i++;
      continue;
    }

    const start = formatVttTimestamp(parseTimestampToSeconds(match[1]));
    const end = formatVttTimestamp(parseTimestampToSeconds(match[2]));
    const settings = match[3] || '';

    const payloadLines = [];
    let j = timeLineIdx + 1;
    while (j < lines.length && lines[j].trim() !== '') {
      payloadLines.push(sanitizeCueText(lines[j]));
      j++;
    }

    if (payloadLines.length > 0) {
      cues.push(`${start} --> ${end}${settings}\n${payloadLines.join('\n')}`);
    }
    i = j + 1;
  }

  return cues.length > 0 ? `WEBVTT\n\n${cues.join('\n\n')}\n` : 'WEBVTT\n\n';
}

/**
 * Shift all WebVTT cue timestamps by -offsetSeconds, discarding cues ending at or before 0.
 * @param {string} vttText
 * @param {number} offsetSeconds
 * @returns {string}
 */
function shiftVtt(vttText, offsetSeconds) {
  const offset = Number(offsetSeconds);
  if (!Number.isFinite(offset) || offset <= 0) {
    return vttText;
  }

  const normalized = String(vttText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const outputBlocks = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;

    if (block.startsWith('WEBVTT')) {
      outputBlocks.push(block);
      continue;
    }
    if (block.startsWith('NOTE') || block.startsWith('STYLE') || block.startsWith('REGION')) {
      outputBlocks.push(block);
      continue;
    }

    const blockLines = block.split('\n');
    const timeIdx = blockLines.findIndex((l) => TIMESTAMP_LINE_RE.test(l));
    if (timeIdx === -1) {
      continue;
    }

    const match = TIMESTAMP_LINE_RE.exec(blockLines[timeIdx]);
    const origStart = parseTimestampToSeconds(match[1]);
    const origEnd = parseTimestampToSeconds(match[2]);
    const settings = match[3] || '';

    const shiftedEnd = origEnd - offset;
    if (shiftedEnd <= 0) {
      continue;
    }

    const shiftedStart = Math.max(0, origStart - offset);
    const shiftedLine = `${formatVttTimestamp(shiftedStart)} --> ${formatVttTimestamp(shiftedEnd)}${settings}`;

    const rebuilt = [
      ...blockLines.slice(0, timeIdx),
      shiftedLine,
      ...blockLines.slice(timeIdx + 1)
    ];
    outputBlocks.push(rebuilt.join('\n'));
  }

  if (outputBlocks.length === 0 || !outputBlocks[0].startsWith('WEBVTT')) {
    outputBlocks.unshift('WEBVTT');
  }
  return outputBlocks.join('\n\n') + '\n';
}

function createSubtitleService({ rootDir, mediaScanner }) {
  const resolvedRoot = path.resolve(rootDir);
  const subCacheDir = path.join(resolvedRoot, 'temp', 'subtitles');
  fs.mkdirSync(subCacheDir, { recursive: true });

  const inFlightExtractions = new Map();

  function getCachedVttPath(subtitleId) {
    const safeId = String(subtitleId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(subCacheDir, `${safeId}.vtt`);
  }

  async function extractEmbeddedToVtt(track) {
    const movie = mediaScanner.getMovieById(track.movieId);
    if (!movie) {
      const err = new Error('Filme da legenda não encontrado.');
      err.statusCode = 404;
      throw err;
    }

    const outPath = getCachedVttPath(track.id);
    if (fs.existsSync(outPath)) {
      const cacheStat = fs.statSync(outPath);
      if (cacheStat.size > 0 && cacheStat.mtimeMs >= movie.mtimeMs) {
        return fs.readFileSync(outPath, 'utf8');
      }
    }

    if (inFlightExtractions.has(track.id)) {
      return inFlightExtractions.get(track.id);
    }

    const promise = (async () => {
      try {
        await execFileAsync(
          mediaScanner.binaries.ffmpegPath,
          [
            '-y',
            '-i',
            movie.path,
            '-map',
            `0:${track.streamIndex}`,
            '-c:s',
            'webvtt',
            outPath
          ],
          { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
        );
        const buf = fs.readFileSync(outPath);
        const vtt = normalizeToVtt(decodeTextBuffer(buf));
        fs.writeFileSync(outPath, vtt, 'utf8');
        return vtt;
      } finally {
        inFlightExtractions.delete(track.id);
      }
    })();

    inFlightExtractions.set(track.id, promise);
    return promise;
  }

  async function getSubtitleVtt(subtitleId, offsetSeconds = 0) {
    const track = mediaScanner.getSubtitleById(subtitleId);
    if (!track) {
      const err = new Error(`Legenda não encontrada: ${subtitleId}`);
      err.statusCode = 404;
      throw err;
    }

    let baseVtt;
    if (track.source === 'embedded') {
      baseVtt = await extractEmbeddedToVtt(track);
    } else if (track.source === 'uploaded') {
      const filePath = track.path || getCachedVttPath(track.id);
      if (!fs.existsSync(filePath)) {
        const err = new Error('Arquivo da legenda enviada não encontrado.');
        err.statusCode = 404;
        throw err;
      }
      baseVtt = fs.readFileSync(filePath, 'utf8');
    } else {
      if (!track.path || !fs.existsSync(track.path)) {
        const err = new Error('Arquivo de legenda externo não encontrado.');
        err.statusCode = 404;
        throw err;
      }
      const rawBuf = fs.readFileSync(track.path);
      baseVtt = normalizeToVtt(decodeTextBuffer(rawBuf));
    }

    return shiftVtt(baseVtt, offsetSeconds);
  }

  function uploadSubtitle({ movieId, filename, content }) {
    const movie = mediaScanner.getMovieById(movieId);
    if (!movie) {
      const err = new Error(`Filme não encontrado: ${movieId}`);
      err.statusCode = 404;
      throw err;
    }

    if (typeof filename !== 'string' || !/\.(srt|vtt)$/i.test(filename.trim())) {
      const err = new Error('Envie um arquivo de legenda .srt ou .vtt válido.');
      err.statusCode = 400;
      throw err;
    }

    if (typeof content !== 'string' || !content.trim()) {
      const err = new Error('Conteúdo da legenda está vazio.');
      err.statusCode = 400;
      throw err;
    }

    const cleanName = path.basename(filename.trim());
    const hash = crypto
      .createHash('sha1')
      .update(`${movieId}|${cleanName}|${Date.now()}`)
      .digest('hex')
      .slice(0, 10);
    const subtitleId = `${movieId}-upl-${hash}`;
    const vtt = normalizeToVtt(content);
    const outPath = getCachedVttPath(subtitleId);
    fs.writeFileSync(outPath, vtt, 'utf8');

    const track = {
      id: subtitleId,
      movieId,
      source: 'uploaded',
      path: outPath,
      filename: cleanName,
      format: 'vtt',
      language: 'pt-br',
      title: path.basename(cleanName, path.extname(cleanName)),
      label: `${cleanName} (Enviada)`
    };

    mediaScanner.registerUploadedSubtitle(movieId, track);
    return track;
  }

  return {
    getSubtitleVtt,
    uploadSubtitle,
    decodeTextBuffer,
    normalizeToVtt,
    shiftVtt
  };
}

module.exports = {
  createSubtitleService,
  decodeTextBuffer,
  normalizeToVtt,
  shiftVtt
};
