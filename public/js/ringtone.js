// Ringtone for calls — generated with the Web Audio API (no audio file needed),
// plus vibration on mobile. Incoming calls use a LOUD, attention-grabbing
// warbling ring (telephone-style) so a call is impossible to miss even with the
// phone in a pocket; outgoing calls use a soft ringback. Loudness and vibration
// honour the user's notification preferences (Configurações ⚙️), stored in
// localStorage, so anyone who finds it too loud can soften it.

let ctx = null;
let loopTimer = null;
let vibeTimer = null;

function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// ---- user preferences -----------------------------------------------------
// Ring mode defaults to 'loud' so calls are loud out of the box (the user's
// explicit ask). Options: loud | normal | vibrate | silent.
export function ringMode() {
  return localStorage.getItem('speedvox_ring_mode') || 'loud';
}
export function setRingMode(mode) {
  localStorage.setItem('speedvox_ring_mode', mode);
}
function ringGain() {
  switch (ringMode()) {
    case 'loud': return 0.85;   // square wave at this level cuts through noise
    case 'normal': return 0.4;
    default: return 0;          // 'vibrate' / 'silent' -> no audio
  }
}
export function vibrateEnabled() {
  if (ringMode() === 'silent') return false;
  return localStorage.getItem('speedvox_vibrate') !== '0';
}
// In-app sound when a message arrives while the app is open. On by default.
export function messageSoundEnabled() {
  return localStorage.getItem('speedvox_msg_sound') !== '0';
}

// Unlock/warm up the audio engine on a user gesture. Browsers suspend audio
// until the user interacts with the page, which would otherwise make an incoming
// ring silent. Call this on the first tap so the ring is loud when a call lands.
export function unlock() {
  const c = audioCtx();
  if (!c) return;
  try {
    const o = c.createOscillator();
    const g = c.createGain();
    g.gain.value = 0; // silent — just to wake the audio engine
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + 0.02);
  } catch { /* ignore */ }
}

function beep(freq, start, dur, gainVal, type) {
  const c = ctx;
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gainVal, start + 0.03);
  g.gain.setValueAtTime(gainVal, start + dur - 0.04);
  g.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function playPattern(notes) {
  const c = audioCtx();
  if (!c) return;
  let t = c.currentTime + 0.03;
  for (const n of notes) {
    beep(n.f, t, n.d, n.g, n.type);
    t += n.d + (n.gap || 0);
  }
}

// Loud, insistent warbling ring (alternating two close tones, like a real
// phone) finished by a bright high note, repeated quickly. Audio is skipped in
// vibrate/silent modes; vibration is skipped if disabled.
export function startIncoming() {
  stop();
  const g = ringGain();
  const pat = () => {
    if (g <= 0) return;
    playPattern([
      { f: 880,  d: 0.16, g, gap: 0.02, type: 'square' },
      { f: 1100, d: 0.16, g, gap: 0.02, type: 'square' },
      { f: 880,  d: 0.16, g, gap: 0.02, type: 'square' },
      { f: 1100, d: 0.16, g, gap: 0.06, type: 'square' },
      { f: 1320, d: 0.30, g, type: 'triangle' },
    ]);
  };
  pat();
  loopTimer = setInterval(pat, 1600); // ring often -> insistent
  if (vibrateEnabled() && navigator.vibrate) {
    const strong = ringMode() === 'loud';
    const pulse = strong ? [600, 200, 600, 200, 600] : [400, 250, 400];
    const vibe = () => { try { navigator.vibrate(pulse); } catch {} };
    vibe();
    vibeTimer = setInterval(vibe, 1600);
  }
}

// Classic soft ringback (440/480 Hz pair), repeated, no vibration. This is the
// caller's own phone, so it stays soft regardless of the ring-volume setting.
export function startOutgoing() {
  stop();
  const pat = () => playPattern([
    { f: 440, d: 0.4, g: 0.1, gap: 0.18 },
    { f: 480, d: 0.4, g: 0.1 },
  ]);
  pat();
  loopTimer = setInterval(pat, 3000);
}

// Short two-note chime for a message that arrives while the app is open (and the
// chat isn't focused). Honours the message-sound preference.
export function notify() {
  if (!messageSoundEnabled()) return;
  playPattern([
    { f: 880,  d: 0.12, g: 0.3, gap: 0.04, type: 'triangle' },
    { f: 1175, d: 0.16, g: 0.3, type: 'triangle' },
  ]);
}

export function stop() {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  if (vibeTimer) { clearInterval(vibeTimer); vibeTimer = null; }
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch {} }
}
