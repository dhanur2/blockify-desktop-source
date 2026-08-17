'use strict';

// Community source builds intentionally ship with remote pilot updates
// disabled. A distributor that enables an update channel must add its own
// independently reviewed configuration and signing process; this repository
// never selects or embeds a release host or signing authority.
const PILOT_UPDATE_PROTOCOL = 'ed25519-manifest-v1';
const PILOT_UPDATE_BASE_URL = null;
const PILOT_UPDATE_ED25519_PUBLIC_KEY = null;
const PILOT_UPDATE_KEY_ID = null;

function isRawEd25519PublicKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, 'base64url').length === 32;
  } catch {
    return false;
  }
}

function isPinnedHttpsBaseUrl(value) {
  if (typeof value !== 'string' || value !== value.trim()) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname.endsWith('/') &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

function getPilotUpdateConfiguration() {
  return null;
}

module.exports = {
  PILOT_UPDATE_BASE_URL,
  PILOT_UPDATE_ED25519_PUBLIC_KEY,
  PILOT_UPDATE_KEY_ID,
  PILOT_UPDATE_PROTOCOL,
  getPilotUpdateConfiguration,
  isPinnedHttpsBaseUrl,
  isRawEd25519PublicKey
};
