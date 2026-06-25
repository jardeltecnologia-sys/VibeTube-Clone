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

// Cross-origin allow-list. The web/PWA is same-origin (needs nothing), but the
// bundled native app loads from a local origin (https://localhost on Android,
// capacitor://localhost on iOS) and must be allowed to reach the API + Socket.IO.
// Extra origins can be added via CORS_ORIGINS (comma-separated).
const CORS_ORIGINS = [
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : []),
];

const config = {
  port: PORT,
  publicUrl: PUBLIC_URL,
  corsOrigins: CORS_ORIGINS,
  jwtSecret: process.env.JWT_SECRET || 'speedvox-dev-secret-change-me',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: `${PUBLIC_URL}/api/auth/google/callback`,
    enabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  },
  dataDir: process.env.SPEEDVOX_DATA_DIR || path.join(__dirname, '..', 'data'),
  uploadDir: process.env.SPEEDVOX_UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
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
  // SMTP for the e-mail confirmation flow. If no host is set, e-mail
  // verification is disabled and sign-up activates immediately (legacy behavior).
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'SpeedVox <noreply@vibetube.com.br>',
    secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
  },
  // Test mode: skip real sending and surface the token to the API (for tests).
  emailTestMode: process.env.EMAIL_TEST_MODE === '1',
  // Anti-abuse: max sign-ups per IP in a 15-minute window. Loopback is exempt
  // (real clients always arrive through the proxy with a forwarded IP). Tuned
  // generously so people behind shared NAT/CGNAT can still register.
  registerMaxPerIp: parseInt(process.env.REGISTER_MAX_PER_IP || '20', 10),
  // Upload guard: max file size and a denylist of dangerous extensions.
  uploadMaxBytes: parseInt(process.env.UPLOAD_MAX_MB || '32', 10) * 1024 * 1024,
  // Group size cap. Practically unlimited (blackout/community scenario): the
  // number is only an anti-abuse guard. Text messaging scales to huge groups;
  // group *calls* are full-mesh and only practical for small groups regardless.
  groupMaxMembers: parseInt(process.env.GROUP_MAX_MEMBERS || '100000', 10),

  // --- VibeTube Mesh / SpeedVox Offline Mode (additive, feature-flagged) ---
  // The offline mesh is an additional layer; these flags never change existing
  // online behavior. Defaults are conservative and safe for production.
  mesh: {
    // Master switch for the mesh backend endpoints (/api/mesh/*).
    enabled: process.env.MESH_ENABLED !== '0',
    // Whether the backend accepts offline message sync batches.
    syncEnabled: process.env.MESH_SYNC_ENABLED !== '0',
    // Whether the Android offline build is considered available (for clients).
    androidEnabled: process.env.MESH_ANDROID_ENABLED !== '0',
    // On Web/PWA, offer only an explainer + diagnostics (no fake BLE mesh).
    webDiagnosticOnly: process.env.MESH_WEB_DIAGNOSTIC_ONLY !== '0',
    // Limits surfaced via /api/mesh/config and enforced by /api/mesh/sync.
    maxMessageBytes: parseInt(process.env.MESH_MAX_MESSAGE_BYTES || '4096', 10),
    maxBatchSize: parseInt(process.env.MESH_MAX_BATCH_SIZE || '100', 10),
    maxTTL: parseInt(process.env.MESH_MAX_TTL || '5', 10),
    maxOfflineRetentionDays: parseInt(process.env.MESH_MAX_OFFLINE_RETENTION_DAYS || '7', 10),
    allowAttachmentsOffline: process.env.MESH_ALLOW_ATTACHMENTS_OFFLINE === '1',
  },
};

// E-mail verification is on when SMTP is configured (or in test mode).
config.emailVerification = Boolean(config.smtp.host) || config.emailTestMode;


// Assemble the ICE server list sent to clients. STUN finds public addresses;
// TURN relays media when peers can't reach each other directly (restrictive
// NAT / mobile CGNAT) — without a TURN, those calls fail to connect.
config.iceServers = (() => {
  const list = [
    { urls: [config.stunUrl, 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ];
  if (config.turnUrl) {
    // Private TURN (recommended for production): set TURN_URL/USERNAME/CREDENTIAL.
    list.push({
      urls: config.turnUrl,
      username: config.turnUsername || undefined,
      credential: config.turnCredential || undefined,
    });
  } else if (process.env.DISABLE_FREE_TURN !== '1') {
    // No private TURN configured: fall back to the free Open Relay TURN so calls
    // still connect across restrictive networks. It's best-effort/rate-limited —
    // run your own coturn for reliability. Disable with DISABLE_FREE_TURN=1.
    const cred = { username: 'openrelayproject', credential: 'openrelayproject' };
    list.push(
      { urls: 'turn:openrelay.metered.ca:80', ...cred },
      { urls: 'turn:openrelay.metered.ca:443', ...cred },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', ...cred }
    );
  }
  return list;
})();

module.exports = config;
