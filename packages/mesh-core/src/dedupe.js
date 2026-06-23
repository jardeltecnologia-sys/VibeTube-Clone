// Seen-message cache for anti-loop / duplicate suppression (spec 5.7).
//
// Bounded in both size and age so it can run forever on a phone. Stores only
// messageIds and the time we first saw them.

const DEFAULT_MAX = 5000;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // forget after 1h

export function createSeenCache({ max = DEFAULT_MAX, ttlMs = DEFAULT_TTL_MS } = {}) {
  const map = new Map(); // messageId -> firstSeenAt
  return {
    has(id, now = Date.now()) {
      const t = map.get(id);
      if (t === undefined) return false;
      if (now - t > ttlMs) { map.delete(id); return false; }
      return true;
    },
    mark(id, now = Date.now()) {
      map.set(id, now);
      if (map.size > max) {
        // Drop oldest insertions first (Map preserves insertion order).
        const overflow = map.size - max;
        let i = 0;
        for (const k of map.keys()) { map.delete(k); if (++i >= overflow) break; }
      }
      return id;
    },
    prune(now = Date.now()) {
      for (const [k, t] of map) if (now - t > ttlMs) map.delete(k);
    },
    get size() { return map.size; },
  };
}

// Functional helpers matching the spec's naming.
export function markSeen(cache, messageId, now = Date.now()) {
  return cache.mark(messageId, now);
}

export function hasSeen(cache, messageId, now = Date.now()) {
  return cache.has(messageId, now);
}
