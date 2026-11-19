'use strict';

const crypto = require('crypto');
const { timingSafeMatch } = require('./mediaScanner');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_CODES = 20;

function createHostPairing({ getHostToken, ttlMs = DEFAULT_TTL_MS } = {}) {
  /** @type {Map<string, { expiresAt: number, consumed: boolean }>} */
  const codes = new Map();

  function pruneExpired(now = Date.now()) {
    for (const [code, entry] of codes.entries()) {
      if (entry.consumed || entry.expiresAt <= now) {
        codes.delete(code);
      }
    }
  }

  function createCode() {
    pruneExpired();
    while (codes.size >= MAX_ACTIVE_CODES) {
      const oldest = codes.keys().next().value;
      codes.delete(oldest);
    }

    const code = crypto.randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    codes.set(code, { expiresAt, consumed: false });
    return { code, expiresAt };
  }

  function redeemCode(rawCode) {
    pruneExpired();
    if (typeof rawCode !== 'string' || !rawCode.trim()) {
      const err = new Error('Código de pareamento inválido.');
      err.statusCode = 400;
      throw err;
    }

    const code = rawCode.trim();
    const entry = codes.get(code);
    if (!entry || entry.consumed || entry.expiresAt <= Date.now()) {
      const err = new Error('Código de pareamento expirado ou inválido.');
      err.statusCode = 403;
      throw err;
    }

    entry.consumed = true;
    codes.delete(code);

    const hostToken = typeof getHostToken === 'function' ? getHostToken() : null;
    if (typeof hostToken !== 'string' || hostToken.length < 16) {
      const err = new Error('Host token indisponível.');
      err.statusCode = 500;
      throw err;
    }

    return { hostToken, expiresAt: entry.expiresAt };
  }

  function isValidHostToken(token) {
    const valid = typeof getHostToken === 'function' ? getHostToken() : '';
    return timingSafeMatch(token, valid);
  }

  return {
    createCode,
    redeemCode,
    isValidHostToken,
    _debugSize: () => codes.size
  };
}

module.exports = {
  createHostPairing
};
