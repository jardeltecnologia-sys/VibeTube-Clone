// Ringtone for calls — generated with the Web Audio API (no audio file needed),
// plus vibration on mobile. Incoming calls use an attention-grabbing melody;
// outgoing calls use a soft ringback. Resilient to browser autoplay limits.

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

function beep(freq, start, dur, gainVal) {
  const c = ctx;
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gainVal, start + 0.04);
  g.gain.setValueAtTime(gainVal, start + dur - 0.05);
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
    beep(n.f, t, n.d, n.g);
    t += n.d + (n.gap || 0);
  }
}

// Ascending three-note chime, repeated, with a vibration pulse.
export function startIncoming() {
  stop();
  const pat = () => playPattern([
    { f: 523.25, d: 0.18, g: 0.22, gap: 0.05 }, // C5
    { f: 659.25, d: 0.18, g: 0.22, gap: 0.05 }, // E5
    { f: 783.99, d: 0.32, g: 0.22 },            // G5
  ]);
  pat();
  loopTimer = setInterval(pat, 2200);
  if (navigator.vibrate) {
    const vibe = () => navigator.vibrate([450, 250, 450]);
    vibe();
    vibeTimer = setInterval(vibe, 2200);
  }
}

// Classic soft ringback (440/480 Hz pair), repeated, no vibration.
export function startOutgoing() {
  stop();
  const pat = () => playPattern([
    { f: 440, d: 0.4, g: 0.1, gap: 0.18 },
    { f: 480, d: 0.4, g: 0.1 },
  ]);
  pat();
  loopTimer = setInterval(pat, 3000);
}

export function stop() {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  if (vibeTimer) { clearInterval(vibeTimer); vibeTimer = null; }
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch {} }
}
