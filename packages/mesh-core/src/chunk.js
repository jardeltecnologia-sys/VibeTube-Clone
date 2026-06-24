// Chunked media over the mesh — Stage 2 ("superior ao Bitchat").
//
// The mesh moves small, opaque payloads (the Bitchat model is text-only for this
// very reason: radio frames are tiny). Voice notes and photos don't fit in one
// envelope, so we split a base64 blob into bounded chunks, send each as a normal
// mesh message — so they flood, ACK and store-and-forward like any other — and
// reassemble them on the far side. Chunks stay well under typical WebRTC
// DataChannel and BLE/Wi-Fi-Direct frame limits and survive multiple hops and
// out-of-order arrival.
//
// This module is pure logic (no DOM, no transport) so it is unit-testable in
// Node and reusable in the browser (served at /mesh-core/chunk.js).

'use strict';

// base64 chars per chunk (~2.2 KB of raw bytes once decoded) — comfortably below
// DataChannel/BLE frame ceilings even after the envelope JSON wrapping.
export const DEFAULT_CHUNK_B64 = 3000;
// Hard cap on a single media item carried over the mesh (~512 KB raw). Keeps the
// flood light: voice notes and small photos sail through, multi-MB files don't.
export const MAX_MEDIA_B64 = 700000;

// Split a media descriptor into ordered chunk payloads. Each payload is a plain
// JSON-safe object that carries enough metadata to be reassembled on its own,
// regardless of the order chunks arrive in.
export function splitMedia({ mediaId, type, mime, name, b64 }, chunkSize = DEFAULT_CHUNK_B64) {
  if (!mediaId || typeof b64 !== 'string') throw new Error('splitMedia: mediaId e b64 são obrigatórios');
  if (b64.length > MAX_MEDIA_B64) throw new Error('mídia grande demais para a rede mesh');
  const size = Math.max(1, chunkSize | 0);
  const total = Math.max(1, Math.ceil(b64.length / size));
  const out = [];
  for (let i = 0; i < total; i += 1) {
    out.push({
      mediaId,
      type: type || 'file',
      mime: mime || 'application/octet-stream',
      name: name || '',
      i,
      n: total,
      chunk: b64.slice(i * size, (i + 1) * size),
    });
  }
  return out;
}

// Reassembles chunk payloads (possibly out of order, duplicated, or interleaved
// with other media) back into complete items. Bounded in both count and time so
// a flood of partial media can't exhaust memory.
export class MediaReassembler {
  constructor({ maxPending = 64, ttlMs = 5 * 60 * 1000 } = {}) {
    this.maxPending = maxPending;
    this.ttlMs = ttlMs;
    this.pending = new Map(); // key -> { type, mime, name, n, parts:Map(i->str), ts }
  }

  // Feed one chunk. `key` isolates senders so two people sending media with
  // colliding ids never mix. Returns the complete media descriptor
  // ({ mediaId, type, mime, name, b64 }) once the last missing chunk arrives,
  // otherwise null.
  add(payload, key) {
    if (!payload || !payload.mediaId) return null;
    if (typeof payload.i !== 'number' || typeof payload.n !== 'number' || payload.n < 1) return null;
    this._evictExpired();
    const k = `${key || ''}|${payload.mediaId}`;
    let rec = this.pending.get(k);
    if (!rec) {
      if (this.pending.size >= this.maxPending) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      rec = { type: payload.type, mime: payload.mime, name: payload.name, n: payload.n, parts: new Map(), ts: Date.now() };
      this.pending.set(k, rec);
    }
    rec.ts = Date.now();
    if (payload.i >= 0 && payload.i < rec.n && !rec.parts.has(payload.i)) {
      rec.parts.set(payload.i, typeof payload.chunk === 'string' ? payload.chunk : '');
    }
    if (rec.parts.size < rec.n) return null; // still waiting for chunks
    let b64 = '';
    for (let i = 0; i < rec.n; i += 1) b64 += rec.parts.get(i) || '';
    this.pending.delete(k);
    return { mediaId: payload.mediaId, type: rec.type, mime: rec.mime, name: rec.name, b64 };
  }

  _evictExpired() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, rec] of this.pending) if (rec.ts < cutoff) this.pending.delete(k);
  }
}
