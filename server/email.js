'use strict';

// E-mail sending for the sign-up confirmation flow. When SMTP isn't configured
// (or in test mode), sending is a no-op and verification is handled elsewhere.

const nodemailer = require('nodemailer');
const config = require('./config');

let transport = null;
if (config.smtp.host && !config.emailTestMode) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

function isEnabled() {
  return config.emailVerification;
}

function verificationHtml(displayName, link) {
  const name = (displayName || '').replace(/[<>&]/g, '');
  return `<!DOCTYPE html><html><body style="margin:0;background:#0b141a;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;color:#e9edef">
      <h1 style="color:#00a884;font-size:24px;margin:0 0 8px">SpeedVox</h1>
      <p style="font-size:16px;line-height:1.5">Olá${name ? ' ' + name : ''}! Falta um passo para ativar a sua conta.</p>
      <p style="font-size:16px;line-height:1.5">Toque no botão abaixo para confirmar o seu e-mail:</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${link}" style="background:#00a884;color:#04130e;text-decoration:none;font-weight:700;
           padding:14px 28px;border-radius:10px;display:inline-block;font-size:16px">Confirmar meu e-mail</a>
      </p>
      <p style="font-size:13px;color:#8696a0;line-height:1.5">Se o botão não funcionar, copie e cole este link no navegador:<br>
        <a href="${link}" style="color:#53bdeb;word-break:break-all">${link}</a></p>
      <p style="font-size:13px;color:#8696a0">Este link expira em 24 horas. Se você não criou esta conta, ignore este e-mail.</p>
    </div></body></html>`;
}

// Plain-text alternative. Sending a text part alongside the HTML markedly
// improves deliverability (HTML-only messages score higher as spam).
function verificationText(displayName, link) {
  const name = (displayName || '').replace(/[<>&]/g, '');
  return `SpeedVox\n\nOlá${name ? ' ' + name : ''}! Falta um passo para ativar sua conta.\n\n`
    + `Confirme seu e-mail abrindo este link:\n${link}\n\n`
    + `O link expira em 24 horas. Se você não criou esta conta, ignore este e-mail.`;
}

// Send the verification e-mail. Returns true if actually dispatched.
async function sendVerification(to, displayName, link) {
  if (config.emailTestMode || !transport) return false; // test/no-SMTP: handled by caller
  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: 'Confirme seu e-mail — SpeedVox',
    text: verificationText(displayName, link),
    html: verificationHtml(displayName, link),
    // Help deliverability/reputation for this transactional message.
    headers: { 'X-Entity-Ref-ID': 'speedvox-verify' },
  });
  return true;
}

module.exports = { isEnabled, sendVerification };
