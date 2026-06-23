// VibeTube Mesh Core — platform-independent mesh foundation.
// Phase 2 of the SpeedVox Offline Mode roadmap: identity, signed envelopes,
// end-to-end crypto, deduplication and TTL routing. No transport, no platform
// APIs — just the portable core that Android (and the web diagnostic build)
// build on top of.

export {
  generateDeviceIdentity,
  publicIdentity,
  rotateIdentityKeys,
  deviceIdMatches,
  serializeIdentity,
  deserializeIdentity,
} from './identity.js';

export {
  randomBytes,
  sha256,
  generateSigningKeyPair,
  generateKxKeyPair,
  signBytes,
  verifyBytes,
  encryptMessage,
  decryptMessage,
} from './crypto.js';

export {
  MESH_PROTOCOL_VERSION,
  DEFAULT_TTL,
  DEFAULT_LIFETIME_MS,
  MESSAGE_TYPES,
  createEnvelope,
  signEnvelope,
  verifyEnvelope,
  isExpired,
  decrementTTL,
  serializeMessage,
  deserializeMessage,
} from './envelope.js';

export { createSeenCache, markSeen, hasSeen } from './dedupe.js';
export { shouldForward, isForMe } from './forward.js';

export {
  bytesToB64u,
  b64uToBytes,
  utf8ToBytes,
  bytesToUtf8,
} from './base64.js';
