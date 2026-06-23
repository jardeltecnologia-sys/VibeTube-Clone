// Runtime environment resolution for SpeedVox.
//
// The web/PWA build talks to its own origin (relative URLs). The bundled native
// app (Capacitor APK) loads its assets from a LOCAL origin (https://localhost),
// so it must reach the SpeedVox server over an ABSOLUTE base URL. This module is
// the single source of truth for that base.
//
//   API_BASE === ''                      -> normal web/PWA (same-origin, relative)
//   API_BASE === 'https://host'          -> native app talking to a remote server
//
// The native build injects `window.SPEEDVOX_SERVER` (see the APK workflow). If it
// is absent but we detect a native platform, we fall back to production.

function resolveBase() {
  try {
    if (typeof window !== 'undefined' && window.SPEEDVOX_SERVER) {
      return String(window.SPEEDVOX_SERVER).replace(/\/$/, '');
    }
    const cap = typeof window !== 'undefined' && window.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
      return 'https://chat.vibetube.com.br';
    }
  } catch { /* ignore */ }
  return '';
}

export const API_BASE = resolveBase();

// True when running inside the bundled native shell (assets served locally).
export function isNative() {
  try { return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
  catch { return false; }
}

// Absolute URL for an API/asset path that lives on the server.
export function apiUrl(path) {
  if (!path) return API_BASE || '';
  if (/^https?:\/\//i.test(path)) return path;       // already absolute
  return API_BASE + (path.startsWith('/') ? path : `/${path}`);
}

// Absolute URL for server-hosted media (avatars, uploads). Leaves data: and
// absolute URLs untouched; rewrites server-relative paths for the native app.
export function mediaUrl(u) {
  if (!u) return u;
  if (/^(https?:|data:|blob:)/i.test(u)) return u;
  return apiUrl(u);
}
