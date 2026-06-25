'use strict';

const express = require('express');
const { requireAuth } = require('../auth-middleware');
const push = require('../push');
const fcm = require('../fcm');

const router = express.Router();

// Public: the VAPID key the client needs to subscribe.
router.get('/vapid', (req, res) => {
  res.json({ publicKey: push.getPublicKey(), enabled: push.isEnabled() });
});

router.use(requireAuth);

router.post('/subscribe', (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'inscrição inválida' });
  }
  push.saveSubscription(req.user.id, subscription);
  res.json({ ok: true });
});

router.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) push.removeSubscription(endpoint);
  res.json({ ok: true });
});

// Native Android (FCM) token registration — used to ring incoming calls in
// full screen even with the app closed.
router.post('/fcm', (req, res) => {
  const token = req.body && req.body.token;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token inválido' });
  fcm.saveToken(req.user.id, token);
  res.json({ ok: true });
});

module.exports = router;
