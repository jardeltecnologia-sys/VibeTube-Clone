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

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

const router = express.Router();

router.post('/', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'arquivo ausente' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size,
  });
});

module.exports = router;
