'use strict';

// Prévia de links (Open Graph) — usada pra mostrar um cartão bonito quando
// alguém cola um link de notícia numa conversa. O servidor busca a página,
// lê as meta tags (og:title/description/image) e devolve só esse resuminho.
//
// Segurança (anti-SSRF): só http/https; o host é resolvido e qualquer IP
// privado/loopback/link-local é BLOQUEADO; cada redirecionamento é revalidado;
// tempo e tamanho de download são limitados. Assim ninguém usa esse endpoint
// pra fazer o servidor acessar a rede interna.

const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const { requireAuth } = require('../auth-middleware');

const router = express.Router();

const CACHE = new Map();            // url -> { at, data }
const TTL = 60 * 60 * 1000;         // 1 hora
const MAX_BYTES = 512 * 1024;       // baixa no máximo 512 KB do HTML
const TIMEOUT = 6000;               // 6s por requisição
const MAX_HOPS = 4;                 // redirecionamentos
const UA = 'Mozilla/5.0 (compatible; SpeedVoxBot/1.0; +https://chat.vibetube.com.br)';

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80')) return true;            // link-local
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique local
  const mapped = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

async function hostIsSafe(hostname) {
  const h = hostname.toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (net.isIP(h)) return !isPrivateIp(h);
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch { return false; }
}

// Segue redirecionamentos manualmente, revalidando o host a cada salto.
async function fetchSafe(startUrl) {
  let current = startUrl;
  for (let i = 0; i < MAX_HOPS; i++) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('proto');
    if (!(await hostIsSafe(u.hostname))) throw new Error('blocked');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    let r;
    try {
      r = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      });
    } finally { clearTimeout(timer); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      current = new URL(r.headers.get('location'), current).toString();
      continue;
    }
    return { r, finalUrl: current };
  }
  throw new Error('too many redirects');
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .trim();
}

function metaContent(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = [
    new RegExp('<meta[^>]+(?:property|name)=["\']' + k + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'),
    new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + k + '["\']', 'i'),
  ];
  for (const re of res) { const m = html.match(re); if (m) return m[1]; }
  return '';
}

function parseMeta(html, finalUrl) {
  const u = new URL(finalUrl);
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const title = decodeEntities(metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || titleTag);
  const description = decodeEntities(
    metaContent(html, 'og:description') || metaContent(html, 'twitter:description') || metaContent(html, 'description'));
  let image = metaContent(html, 'og:image') || metaContent(html, 'og:image:url') || metaContent(html, 'twitter:image');
  if (image) {
    try { image = new URL(decodeEntities(image), finalUrl).toString(); } catch { image = ''; }
    if (!/^https?:\/\//i.test(image)) image = '';
  }
  const site = decodeEntities(metaContent(html, 'og:site_name')) || u.hostname.replace(/^www\./, '');
  return {
    url: finalUrl,
    title: title.slice(0, 200),
    description: description.slice(0, 300),
    image,
    site: site.slice(0, 80),
  };
}

router.get('/', requireAuth, async (req, res) => {
  const url = String(req.query.url || '');
  let u;
  try { u = new URL(url); } catch { return res.status(400).json({ error: 'url inválida' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return res.status(400).json({ error: 'protocolo inválido' });
  }

  const cached = CACHE.get(url);
  if (cached && Date.now() - cached.at < TTL) return res.json(cached.data);

  const fallback = { url, site: u.hostname.replace(/^www\./, '') };

  try {
    const { r, finalUrl } = await fetchSafe(url);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('html')) { CACHE.set(url, { at: Date.now(), data: fallback }); return res.json(fallback); }

    // Lê no máximo MAX_BYTES do corpo.
    let html = '';
    if (r.body && r.body.getReader) {
      const reader = r.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        html += decoder.decode(value, { stream: true });
        if (received >= MAX_BYTES) { try { reader.cancel(); } catch { /* ignore */ } break; }
      }
    } else {
      html = (await r.text()).slice(0, MAX_BYTES);
    }

    const data = parseMeta(html, finalUrl);
    CACHE.set(url, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    // Em erro (bloqueio, timeout, host inválido), devolve só o domínio — o
    // cartão ainda mostra "de onde" é o link, sem vazar nada.
    res.json(fallback);
  }
});

module.exports = router;
// Exposto apenas para testes (não afeta o uso em produção).
module.exports._test = { parseMeta, isPrivateIp, hostIsSafe, metaContent, firstUrlOk: true };
