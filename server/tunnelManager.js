'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const QRCode = require('qrcode');

const CLOUDFLARED_VERSION = '2026.11.1';
const CLOUDFLARED_DOWNLOAD_URL =
  `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`;
const CLOUDFLARED_SHA256 =
  '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35';
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function getLanIpAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;

      let priority = 2;
      const lowerName = name.toLowerCase();
      if (
        lowerName.includes('vethernet') ||
        lowerName.includes('wsl') ||
        lowerName.includes('docker') ||
        lowerName.includes('vmware') ||
        lowerName.includes('virtualbox')
      ) {
        priority = 10;
      } else if (lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('ethernet')) {
        priority = 0;
      }
      if (addr.address.startsWith('192.168.')) priority -= 1;

      candidates.push({ address: addr.address, priority });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

function findCloudflaredInPath(rootDir) {
  const exeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const localBin = path.join(rootDir, 'bin', exeName);
  if (fs.existsSync(localBin)) {
    return localBin;
  }

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, exeName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    const extraDirs = [
      'C:\\Program Files\\cloudflared',
      'C:\\Program Files (x86)\\cloudflared'
    ];
    for (const dir of extraDirs) {
      const candidate = path.join(dir, exeName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function downloadCloudflared(destPath) {
  const binDir = path.dirname(destPath);
  fs.mkdirSync(binDir, { recursive: true });
  const tempPath = `${destPath}.downloading`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(CLOUDFLARED_DOWNLOAD_URL, {
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ao baixar cloudflared`);
    }
    const arrayBuf = await res.arrayBuffer();
    fs.writeFileSync(tempPath, Buffer.from(arrayBuf));

    const digest = sha256File(tempPath);
    if (digest !== CLOUDFLARED_SHA256) {
      throw new Error(
        `Checksum cloudflared inválido (esperado ${CLOUDFLARED_SHA256}, obtido ${digest}).`
      );
    }

    fs.renameSync(tempPath, destPath);
    return destPath;
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Ignore temp cleanup failure.
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function renderQrCode(url) {
  if (!url) return null;
  try {
    return await QRCode.toDataURL(url, {
      margin: 2,
      width: 280,
      color: {
        dark: '#09090f',
        light: '#ffffff'
      }
    });
  } catch {
    return null;
  }
}

function createTunnelManager({ rootDir, port, enabled = true, createHostPairingCode } = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const lanIp = getLanIpAddress();
  const lanUrl = `http://${lanIp}:${port}`;

  let publicUrl = null;
  let status = enabled ? 'starting' : 'disabled';
  let qrCodeDataUrl = null;
  let hostQrCodeDataUrl = null;
  let childProc = null;
  let stopped = false;

  function getGuestUrl() {
    return publicUrl || lanUrl;
  }

  function getHostMobileUrl() {
    const base = publicUrl || lanUrl;
    if (typeof createHostPairingCode === 'function') {
      const pairing = createHostPairingCode();
      if (pairing && pairing.code) {
        return `${base}/?role=host&code=${encodeURIComponent(pairing.code)}`;
      }
    }
    return `${base}/?role=host`;
  }

  async function refreshQrCodes() {
    qrCodeDataUrl = await renderQrCode(getGuestUrl());
    hostQrCodeDataUrl = await renderQrCode(getHostMobileUrl());
  }

  async function start() {
    await refreshQrCodes();
    if (!enabled) {
      return;
    }

    // Run asynchronously without blocking HTTP server startup.
    (async () => {
      try {
        let binaryPath = findCloudflaredInPath(resolvedRoot);
        if (!binaryPath && process.platform === 'win32') {
          status = 'downloading';
          const targetPath = path.join(resolvedRoot, 'bin', 'cloudflared.exe');
          try {
            binaryPath = await downloadCloudflared(targetPath);
          } catch (err) {
            if (!stopped) {
              status = 'lan-only';
              console.warn(`[PaeStream] Túnel Cloudflare indisponível (${err.message}). Usando apenas rede local: ${lanUrl}`);
            }
            return;
          }
        }

        if (!binaryPath || stopped) {
          if (!stopped) status = 'lan-only';
          return;
        }

        status = 'connecting';
        childProc = spawn(
          binaryPath,
          ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          }
        );

        const handleOutput = async (chunk) => {
          const text = chunk.toString('utf8');
          const match = TRYCLOUDFLARE_RE.exec(text);
          if (match && !publicUrl) {
            publicUrl = match[0];
            status = 'online';
            await refreshQrCodes();
            console.log(`\n🌐 [PaeStream] Túnel HTTPS ativo para Convidado: ${publicUrl}`);
            console.log(`📱 [PaeStream] Host Mobile URL: ${getHostMobileUrl()}\n`);
          }
        };

        if (childProc.stdout) childProc.stdout.on('data', handleOutput);
        if (childProc.stderr) childProc.stderr.on('data', handleOutput);

        childProc.on('exit', () => {
          childProc = null;
          if (!stopped && !publicUrl) {
            status = 'lan-only';
          } else if (!stopped && publicUrl) {
            status = 'disconnected';
          }
        });

        childProc.on('error', () => {
          childProc = null;
          if (!stopped) status = 'lan-only';
        });
      } catch {
        if (!stopped) status = 'lan-only';
      }
    })();
  }

  function getPublicInfo() {
    return {
      publicUrl,
      lanUrl,
      guestUrl: getGuestUrl(),
      qrCodeDataUrl,
      status
    };
  }

  function getHostInfo() {
    return {
      ...getPublicInfo(),
      hostMobileUrl: getHostMobileUrl(),
      hostQrCodeDataUrl
    };
  }

  async function stop() {
    stopped = true;
    if (!childProc) return;
    const proc = childProc;
    childProc = null;

    try {
      proc.kill('SIGTERM');
    } catch {
      // Ignore kill failure.
    }

    if (process.platform === 'win32' && proc.pid && proc.exitCode === null) {
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => resolve());
      });
    }
  }

  return {
    start,
    stop,
    getPublicInfo,
    getHostInfo
  };
}

module.exports = {
  createTunnelManager,
  getLanIpAddress
};
