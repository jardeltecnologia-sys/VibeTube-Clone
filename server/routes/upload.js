'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
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
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.uploadMaxBytes / (1024 * 1024));
        return res.status(413).json({ error: `Arquivo muito grande (máx. ${mb} MB)` });
      }
      if (err.code === 'BLOCKED_TYPE') return res.status(415).json({ error: err.message });
      return res.status(400).json({ error: 'Falha no upload' });
    }
    if (!req.file) return res.status(400).json({ error: 'arquivo ausente' });
    const out = {
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
    };
    // Para fotos: gera uma miniatura minúscula e desfocada (data URI ~1 KB).
    // Isso dá a "prévia borrada" estilo WhatsApp antes de baixar a imagem cheia.
    const isImage = (req.file.mimetype || '').startsWith('image/')
      || /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i.test(req.file.originalname || '');
    if (isImage) {
      try {
        const buf = await sharp(path.join(config.uploadDir, req.file.filename))
          .rotate()
          .resize(28, 28, { fit: 'inside' })
          .blur(1.1)
          .jpeg({ quality: 42 })
          .toBuffer();
        out.thumb = `data:image/jpeg;base64,${buf.toString('base64')}`;
      } catch { /* sem miniatura: o app cai num placeholder simples */ }
    }
    res.json(out);
  });
});

module.exports = router;
