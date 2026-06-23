// Forwarding policy for the mesh routing engine (spec 5.7).
//
// Pure decision function: given an envelope and local state, decide whether this
// node should relay it onward. The actual send + TTL decrement is the caller's
// job (use decrementTTL before re-emitting).

import { isExpired } from './envelope.js';

// Decide whether to forward `env`. Returns true only when ALL hold:
//  - we are not the final destination (we deliver those, we don't relay),
//  - the message hasn't expired,
//  - there are hops left (ttl > 0),
//  - we haven't already seen it (anti-loop / dedup).
export function shouldForward(env, { selfDeviceId, seen, now = Date.now() } = {}) {
  if (!env) return false;
  if (env.toDeviceId && env.toDeviceId === selfDeviceId) return false;
  if (isExpired(env, now)) return false;
  if (typeof env.ttl !== 'number' || env.ttl <= 0) return false;
  if (seen && seen.has(env.messageId, now)) return false;
  return true;
}

// Whether this envelope is addressed to us (we should deliver it locally).
export function isForMe(env, selfDeviceId) {
  if (!env) return false;
  if (!env.toDeviceId) return true; // broadcast / room message
  return env.toDeviceId === selfDeviceId;
}
