// Shared WebRTC quality tuning for 1:1 and group calls.
// The goal is WhatsApp-like resilience on mobile data: clean audio (echo/noise
// suppression + Opus in-band FEC and DTX for lossy networks) and adaptive video
// capped so a call never saturates a cellular link.

// getUserMedia constraints. Mono audio with the browser DSP chain on; video
// aims for 720p from the front camera but degrades gracefully on weak devices.
export function getAudioConstraints() {
  const studio = localStorage.getItem('speedvox_studio_audio') === '1';
  if (studio) {
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    };
  }
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
}

export const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

export function videoConstraints(media) {
  if (media !== 'video') return false;
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
    facingMode: 'user',
  };
}

export function mediaConstraints(media) {
  return { audio: getAudioConstraints(), video: videoConstraints(media) };
}

// Enable Opus in-band FEC (forward error correction) and DTX on an SDP before it
// becomes the local description. FEC lets the decoder reconstruct lost packets —
// the single biggest win for call quality on flaky mobile networks.
export function tuneAudioSdp(sdp) {
  if (!sdp) return sdp;
  const lines = sdp.split('\r\n');
  let pt = null;
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (m) { pt = m[1]; break; }
  }
  if (!pt) return sdp;

  let fmtpIndex = -1;
  let rtpmapIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(`a=fmtp:${pt}`)) fmtpIndex = i;
    if (lines[i].startsWith(`a=rtpmap:${pt} opus`)) rtpmapIndex = i;
  }

  const studio = localStorage.getItem('speedvox_studio_audio') === '1';
  const ftr = studio ? 'stereo=1;maxaveragebitrate=510000;useinbandfec=1' : 'useinbandfec=1;usedtx=1';

  if (fmtpIndex !== -1) {
    if (studio) {
      lines[fmtpIndex] = `a=fmtp:${pt} ${ftr}`;
    } else {
      let l = lines[fmtpIndex];
      if (!/useinbandfec=1/.test(l)) l += ';useinbandfec=1';
      if (!/usedtx=1/.test(l)) l += ';usedtx=1';
      lines[fmtpIndex] = l;
    }
  } else if (rtpmapIndex !== -1) {
    lines.splice(rtpmapIndex + 1, 0, `a=fmtp:${pt} ${ftr}`);
  }
  return lines.join('\r\n');
}

// Cap the outgoing video bitrate (kbps) so calls stay smooth on mobile data.
// Audio is left uncapped (Opus is already light at ~24-32 kbps).
export async function capVideoBitrate(pc, maxKbps = 1200) {
  for (const sender of pc.getSenders()) {
    if (sender.track && sender.track.kind === 'video') {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = maxKbps * 1000;
      try { await sender.setParameters(params); } catch { /* not fatal */ }
    }
  }
}
