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

// ── Upload em PEDAÇOS (arquivos grandes) ──────────────────────────────────────
// Fura o limite de ~100 MB do Cloudflare: o cliente envia o arquivo em pedaços
// de 20 MB e o servidor remonta. Bônus: o nginx só precisa aceitar o tamanho de
// UM pedaço, não o arquivo inteiro. Os pedaços ficam no tmp do sistema (fora do
// /uploads público) e são apagados após a montagem.
const os = require('os');
const CHUNK_TMP = path.join(os.tmpdir(), 'speedvox-chunks');
try { if (!fs.existsSync(CHUNK_TMP)) fs.mkdirSync(CHUNK_TMP, { recursive: true }); } catch { /* ignore */ }
const safeId = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uid = safeId(req.body.uploadId);
      if (!uid) return cb(new Error('uploadId inválido'));
      const dir = path.join(CHUNK_TMP, uid);
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const idx = parseInt(req.body.index, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx > 200000) return cb(new Error('index inválido'));
      cb(null, String(idx));
    },
  }),
  limits: { fileSize: 64 * 1024 * 1024 }, // até 64 MB por pedaço
});

router.post('/chunk', requireAuth, (req, res) => {
  chunkUpload.single('chunk')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Falha ao enviar o pedaço' });
    if (!req.file) return res.status(400).json({ error: 'pedaço ausente' });
    res.json({ ok: true });
  });
});

router.post('/chunk/finish', requireAuth, (req, res) => {
  const uid = safeId(req.body.uploadId);
  const total = parseInt(req.body.total, 10);
  const name = String(req.body.name || 'arquivo');
  const mime = String(req.body.mime || 'application/octet-stream');
  if (!uid || !Number.isInteger(total) || total < 1 || total > 200000) {
    return res.status(400).json({ error: 'parâmetros inválidos' });
  }
  const ext = (path.extname(name).slice(1) || '').toLowerCase();
  if (BLOCKED_EXT.has(ext)) return res.status(415).json({ error: 'Tipo de arquivo não permitido por segurança' });

  const dir = path.join(CHUNK_TMP, uid);
  for (let i = 0; i < total; i++) {
    if (!fs.existsSync(path.join(dir, String(i)))) {
      return res.status(400).json({ error: `pedaço ${i} ausente; reenvie` });
    }
  }
  try {
    const cleanExt = path.extname(name).slice(0, 12).replace(/[^.\w]/g, '');
    const finalName = `${id()}${cleanExt}`;
    const finalPath = path.join(config.uploadDir, finalName);
    fs.writeFileSync(finalPath, Buffer.alloc(0));
    let size = 0;
    for (let i = 0; i < total; i++) {
      const buf = fs.readFileSync(path.join(dir, String(i)));
      fs.appendFileSync(finalPath, buf);
      size += buf.length;
      if (size > config.uploadMaxBytes) {
        try { fs.rmSync(finalPath, { force: true }); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        const gb = (config.uploadMaxBytes / (1024 ** 3)).toFixed(1);
        return res.status(413).json({ error: `Arquivo muito grande (máx. ${gb} GB)` });
      }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    res.json({ url: `/uploads/${finalName}`, name, mime, size });
  } catch (e) {
    res.status(500).json({ error: 'Falha ao montar o arquivo' });
  }
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
