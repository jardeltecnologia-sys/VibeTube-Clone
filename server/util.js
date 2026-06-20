'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');

const id = () => crypto.randomUUID();
const now = () => Date.now();

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, config.jwtSecret, {
    expiresIn: '30d',
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

// Public-safe projection of a user row.
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarUrl: u.avatar_url || null,
    about: u.about || '',
    publicKey: u.public_key || null,
    lastSeen: u.last_seen || null,
  };
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isValidUsername(s) {
  return typeof s === 'string' && /^[a-z0-9_.]{3,24}$/.test(s);
}

module.exports = { id, now, signToken, verifyToken, publicUser, isValidEmail, isValidUsername };
