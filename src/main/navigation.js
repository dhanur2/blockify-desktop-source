const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'appleid.apple.com',
  'facebook.com',
  'login.live.com',
  'www.facebook.com'
]);
const MAX_INTERNAL_ERROR_MESSAGE_LENGTH = 200;
const MAX_INTERNAL_URL_LENGTH = 2048;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostnameMatches(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function isSpotifyHost(hostname) {
  return hostnameMatches(hostname, 'spotify.com');
}

function isInternalAppUrl(value) {
  const parsed = parseUrl(value);
  const safeOrigin = parsed?.protocol === 'blockify:' &&
    parsed.hostname === 'app' &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port;
  if (!safeOrigin || parsed.hash || String(value).length > MAX_INTERNAL_URL_LENGTH) {
    return false;
  }

  if (parsed.pathname === '/loading') {
    return !parsed.search;
  }

  if (parsed.pathname === '/retry-protected-playback') {
    return !parsed.search;
  }

  if (parsed.pathname !== '/error') {
    return false;
  }

  const keys = [...parsed.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => key !== 'message' && key !== 'retry')) {
    return false;
  }

  const message = parsed.searchParams.get('message');
  const retry = parsed.searchParams.get('retry');
  return (message === null || message.length <= MAX_INTERNAL_ERROR_MESSAGE_LENGTH) &&
    (retry === null || retry === 'protected-playback');
}

function isProtectedPlaybackRetryUrl(value) {
  const parsed = parseUrl(value);
  return isInternalAppUrl(value) &&
    parsed.pathname === '/retry-protected-playback' &&
    !parsed.search;
}

function isTrustedAppNavigation(value) {
  if (value === 'about:blank') {
    return true;
  }

  const parsed = parseUrl(value);
  if (isInternalAppUrl(value)) {
    return true;
  }

  if (parsed?.protocol !== 'https:') {
    return false;
  }

  if (parsed.username || parsed.password || parsed.port) {
    return false;
  }

  return isSpotifyHost(parsed.hostname) || AUTH_HOSTS.has(parsed.hostname);
}

function isTrustedPopupUrl(value) {
  const parsed = parseUrl(value);
  return value === 'about:blank' ||
    (parsed?.protocol === 'https:' && isTrustedAppNavigation(value));
}

function isSpotifyPlayerUrl(value) {
  const parsed = parseUrl(value);
  return parsed?.protocol === 'https:' &&
    parsed.hostname === 'open.spotify.com' &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port;
}

module.exports = {
  AUTH_HOSTS,
  MAX_INTERNAL_ERROR_MESSAGE_LENGTH,
  MAX_INTERNAL_URL_LENGTH,
  isInternalAppUrl,
  isProtectedPlaybackRetryUrl,
  isSpotifyHost,
  isSpotifyPlayerUrl,
  isTrustedAppNavigation,
  isTrustedPopupUrl,
  parseUrl
};
