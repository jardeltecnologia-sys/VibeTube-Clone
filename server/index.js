'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const config = require('./config');
require('./db'); // initialise schema
const realtime = require('./realtime');

const app = express();
app.set('trust proxy', true); // behind Caddy/Cloudflare: use X-Forwarded-For for req.ip

// CORS for the bundled native app (loads from a local origin and must reach the
// API cross-origin). Browsers on the same origin send no Origin header for
// same-origin requests, so this is a no-op for the normal web/PWA.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '2mb' }));

// Simple request logging.
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`);
    }
  });
  next();
});

// Disable HTTP caching for all API routes
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/chats', require('./routes/chats'));
app.use('/api/chats', require('./routes/tasks'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/search', require('./routes/search'));
app.use('/api/status', require('./routes/status'));
app.use('/api/push', require('./routes/push'));
app.use('/api/link', require('./routes/link'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/mesh', require('./routes/mesh'));
app.use('/api/preview', require('./routes/preview'));

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, app: 'speedvox', google: config.google.enabled, time: Date.now() });
});

// WebRTC ICE servers (STUN + optional TURN) for calls and the mesh.
app.get('/api/ice', (req, res) => {
  res.json({ iceServers: config.iceServers });
});

// Uploaded media
if (!fs.existsSync(config.uploadDir)) fs.mkdirSync(config.uploadDir, { recursive: true });
app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d' }));

// Mesh core (Phase 2 shared library) served to the browser as ES modules, so the
// web app and the Capacitor WebView use the SAME code as the backend/tests.
app.use('/mesh-core', express.static(path.join(__dirname, '..', 'packages', 'mesh-core', 'src')));

// Static PWA frontend
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// SPA fallback for client-side routes (but not API/uploads).
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = http.createServer(app);

async function start() {
  await realtime.setup(server);
  server.listen(config.port, () => {
    console.log(`\n  SpeedVox rodando em ${config.publicUrl}`);
    console.log(`  Login com Google: ${config.google.enabled ? 'ativado' : 'desativado (configure .env)'}\n`);
  });
}

start().catch((err) => {
  console.error('Failed to start SpeedVox', err);
  process.exit(1);
});
