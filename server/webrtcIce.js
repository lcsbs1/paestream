'use strict';

const DEFAULT_STUN = Object.freeze([
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
]);

let cachedMetered = null;
let cachedMeteredAt = 0;
const METERED_TTL_MS = 55 * 60 * 1000;

function splitUrls(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildStaticTurnFromEnv() {
  const urls = splitUrls(process.env.PAESTREAM_TURN_URLS || '');
  if (urls.length === 0) return [];

  const username = process.env.PAESTREAM_TURN_USERNAME || '';
  const credential = process.env.PAESTREAM_TURN_CREDENTIAL || '';
  if (!username || !credential) {
    console.warn(
      '[PaeStream] PAESTREAM_TURN_URLS definido, mas falta PAESTREAM_TURN_USERNAME / PAESTREAM_TURN_CREDENTIAL.'
    );
    return [];
  }

  return urls.map((url) => ({
    urls: url,
    username,
    credential
  }));
}

function parseIceServersJson() {
  const raw = process.env.PAESTREAM_ICE_SERVERS_JSON;
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.warn('[PaeStream] PAESTREAM_ICE_SERVERS_JSON deve ser um array JSON de iceServers.');
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[PaeStream] PAESTREAM_ICE_SERVERS_JSON inválido:', err.message);
    return null;
  }
}

function normalizeMeteredAppName(raw) {
  let name = String(raw || '').trim();
  if (!name) return '';
  // Accept accidental full host/URL pastes from the dashboard.
  name = name.replace(/^https?:\/\//i, '');
  name = name.split('/')[0];
  name = name.replace(/\.metered\.live$/i, '');
  name = name.replace(/\.metered\.ca$/i, '');
  return name.trim();
}

async function fetchMeteredIceServers() {
  const apiKey = String(process.env.PAESTREAM_METERED_TURN_API_KEY || '').trim();
  const appName = normalizeMeteredAppName(process.env.PAESTREAM_METERED_APP_NAME);
  if (!apiKey || !appName) return null;

  const now = Date.now();
  if (cachedMetered && now - cachedMeteredAt < METERED_TTL_MS) {
    return cachedMetered;
  }

  const url = `https://${encodeURIComponent(appName)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Metered TURN HTTP ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
  }
  const iceServers = await res.json();
  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    throw new Error('Metered TURN retornou iceServers vazio.');
  }
  cachedMetered = iceServers;
  cachedMeteredAt = now;
  return iceServers;
}

/**
 * Build RTCPeerConnection iceServers for cross-region cinema calls.
 * Priority: PAESTREAM_ICE_SERVERS_JSON > Metered API > STUN + optional static TURN.
 */
async function getIceServers() {
  const fromJson = parseIceServersJson();
  if (fromJson) {
    return {
      iceServers: fromJson,
      hasTurn: fromJson.some((s) => String(s.urls || s.url || '').includes('turn')),
      source: 'env-json'
    };
  }

  try {
    const metered = await fetchMeteredIceServers();
    if (metered) {
      return {
        iceServers: metered,
        hasTurn: true,
        source: 'metered'
      };
    }
  } catch (err) {
    console.warn('[PaeStream] Falha ao buscar Metered TURN:', err.message);
  }

  const iceServers = [...DEFAULT_STUN, ...buildStaticTurnFromEnv()];
  const hasTurn = iceServers.some((s) => String(s.urls || '').includes('turn'));
  return {
    iceServers,
    hasTurn,
    source: hasTurn ? 'stun+env-turn' : 'stun-only'
  };
}

function createWebrtcIce() {
  return {
    getIceServers,
    DEFAULT_STUN
  };
}

module.exports = {
  createWebrtcIce,
  getIceServers,
  DEFAULT_STUN
};
