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
    const ext = path.extname(file.originalname).slice(0, 12).replace(/[^.\w]/g, '');
    cb(null, `${id()}${ext}`);
  },
});

// "Firewall" for uploads: reject executables/scripts that could be used to
// deliver malware. This is type-based blocking (not antivirus), the same first
// line of defense WhatsApp/Telegram use to stop dangerous attachments.
const BLOCKED_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'jar', 'app',
  'apk', 'dmg', 'deb', 'rpm', 'sh', 'bash', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'hta', 'reg', 'lnk', 'gadget', 'msc', 'dll',
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
  limits: { fileSize: config.uploadMaxBytes },
});

const router = express.Router();

router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.uploadMaxBytes / (1024 * 1024));
        return res.status(413).json({ error: `Arquivo muito grande (máx. ${mb} MB)` });
      }
      if (err.code === 'BLOCKED_TYPE') return res.status(415).json({ error: err.message });
      return res.status(400).json({ error: 'Falha no upload' });
    }
    if (!req.file) return res.status(400).json({ error: 'arquivo ausente' });
    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
    });
  });
});

module.exports = router;
