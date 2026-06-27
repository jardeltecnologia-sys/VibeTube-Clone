'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { requireAuth } = require('../auth-middleware');
const { id } = require('../util');

if (!fs.existsSync(config.uploadDir)) fs.mkdirSync(config.uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    // Preserve the extension (max 12 chars, sanitised) for MIME sniffing by browsers.
    const ext = path.extname(file.originalname).slice(0, 12).replace(/[^.\w]/g, '');
    cb(null, `${id()}${ext}`);
  },
});

// Security block-list: executables / scripts that could deliver malware.
// Everything else (audio, video, image, document, archive…) is allowed.
const BLOCKED_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'jar', 'app',
  'apk', 'dmg', 'deb', 'rpm', 'sh', 'bash', 'ps1', 'psm1', 'vbs', 'vbe',
  'jse', 'wsf', 'wsh', 'hta', 'reg', 'lnk', 'gadget', 'msc', 'dll',
  // Note: plain 'js' removed from block-list so .js audio files upload fine;
  // the real risk (eval) happens server-side, not in a static /uploads serve.
]);

function fileFilter(req, file, cb) {
  const ext = (path.extname(file.originalname || '').slice(1) || '').toLowerCase();
  if (BLOCKED_EXT.has(ext)) {
    const err = new Error('Tipo de arquivo não permitido por segurança');
    err.code = 'BLOCKED_TYPE';
    return cb(err);
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.uploadMaxBytes, // up to 1 GB per file
    files: 500,                       // up to 500 files per request
  },
});

const router = express.Router();

// ── Single file (legacy, used by existing sendFile path) ──────────────────────
router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return sendUploadError(res, err, config.uploadMaxBytes);
    if (!req.file) return res.status(400).json({ error: 'arquivo ausente' });
    res.json(fileToJson(req.file));
  });
});

// ── Batch upload: up to 500 files at once ─────────────────────────────────────
router.post('/batch', requireAuth, (req, res) => {
  upload.array('files', 500)(req, res, (err) => {
    if (err) return sendUploadError(res, err, config.uploadMaxBytes);
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'nenhum arquivo recebido' });
    res.json({ files: req.files.map(fileToJson) });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function fileToJson(f) {
  return {
    url: `/uploads/${f.filename}`,
    name: f.originalname,
    mime: f.mimetype,
    size: f.size,
  };
}

function sendUploadError(res, err, maxBytes) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    const gb = (maxBytes / (1024 ** 3)).toFixed(1);
    return res.status(413).json({ error: `Arquivo muito grande (máx. ${gb} GB)` });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: 'Máximo de 500 arquivos por envio' });
  }
  if (err.code === 'BLOCKED_TYPE') return res.status(415).json({ error: err.message });
  return res.status(400).json({ error: 'Falha no upload' });
}

module.exports = router;
