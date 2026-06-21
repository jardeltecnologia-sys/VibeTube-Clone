'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env loader (no external dependency).
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const config = {
  port: PORT,
  publicUrl: PUBLIC_URL,
  jwtSecret: process.env.JWT_SECRET || 'speedvox-dev-secret-change-me',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: `${PUBLIC_URL}/api/auth/google/callback`,
    enabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  },
  dataDir: path.join(__dirname, '..', 'data'),
  uploadDir: path.join(__dirname, '..', 'uploads'),
  // How often to sweep expired (disappearing) messages.
  sweepMs: parseInt(process.env.SWEEP_MS || '15000', 10),
  // Web Push (VAPID). If unset, a key pair is generated and persisted on boot.
  vapidPublic: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivate: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@speedvox.app',
  // WebRTC ICE: STUN is always on; a TURN relay (for restrictive NATs) is optional.
  turnUrl: process.env.TURN_URL || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',
  stunUrl: process.env.STUN_URL || 'stun:stun.l.google.com:19302',
  // How long an unanswered call rings before it counts as missed.
  callRingMs: parseInt(process.env.CALL_RING_MS || '45000', 10),
};

// Assemble the ICE server list sent to clients.
config.iceServers = (() => {
  const list = [{ urls: config.stunUrl }];
  if (config.turnUrl) {
    list.push({
      urls: config.turnUrl,
      username: config.turnUsername || undefined,
      credential: config.turnCredential || undefined,
    });
  }
  return list;
})();

module.exports = config;
