'use strict';

// Minimal in-memory sliding-window rate limiter (per key). Good enough for a
// single-node deploy; for multi-node it would move to Redis.

const buckets = new Map(); // key -> [timestamps]

function check(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    const retryAfter = Math.ceil((windowMs - (now - arr[0])) / 1000);
    buckets.set(key, arr);
    return { allowed: false, retryAfter };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { allowed: true, retryAfter: 0 };
}

// Periodically drop empty buckets so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of buckets) {
    const live = arr.filter((t) => now - t < 60 * 60 * 1000);
    if (live.length) buckets.set(key, live); else buckets.delete(key);
  }
}, 10 * 60 * 1000).unref?.();

module.exports = { check };
