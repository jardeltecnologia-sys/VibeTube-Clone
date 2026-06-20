'use strict';

const db = require('./db');
const { verifyToken } = require('./util');

function getTokenFromReq(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

// Express middleware: requires a valid session, attaches req.user.
function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'unauthorized' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

module.exports = { requireAuth, getTokenFromReq };
