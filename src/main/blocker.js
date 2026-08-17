const MAX_AD_CONTENT_IDS = 32;
const AD_CONTENT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const STATIC_AD_HOSTS = ['2mdn.net', 'amillionads.com'];
const SPOTIFY_AD_ASSET_HOST = 'adstudio-assets.scdn.co';
const SPOTIFY_AD_PATH_PREFIXES = ['/mp3/', '/mp3-ad/'];

function hostnameMatches(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function parseHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function isSpotifyWebUrl(value) {
  const parsed = parseHttpsUrl(value);
  return parsed?.hostname === 'open.spotify.com';
}

function normalizeAdContentIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = new Set();
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.trim();
    if (AD_CONTENT_ID_PATTERN.test(normalized)) {
      unique.add(normalized);
    }

    if (unique.size >= MAX_AD_CONTENT_IDS) {
      break;
    }
  }

  return [...unique];
}

function requestCameFromSpotify(details) {
  const candidateUrls = [details.referrer, details.documentURL, details.frame?.url];

  try {
    candidateUrls.push(details.webContents?.getURL());
  } catch {
    // A WebContents can disappear while a request is in flight.
  }

  return candidateUrls.some((candidate) => isSpotifyWebUrl(candidate));
}

function classifyAdRequest(details, adContentIds) {
  const requestUrl = parseHttpsUrl(details.url);
  if (!requestUrl || !requestCameFromSpotify(details)) {
    return null;
  }

  const resourceType = String(details.resourceType || '').toLowerCase();
  if (resourceType !== 'media') {
    return null;
  }

  if (
    requestUrl.hostname === SPOTIFY_AD_ASSET_HOST &&
    SPOTIFY_AD_PATH_PREFIXES.some((prefix) => requestUrl.pathname.startsWith(prefix))
  ) {
    return 'spotify-ad-asset';
  }

  if (STATIC_AD_HOSTS.some((hostname) => hostnameMatches(requestUrl.hostname, hostname))) {
    return 'known-ad-host';
  }

  const rawUrl = details.url;
  if ([...adContentIds].some((contentId) => rawUrl.includes(contentId))) {
    return 'detected-ad-content';
  }

  return null;
}

function installSpotifyBlocker(spotifySession, options) {
  const { redirectURL, onRedirect = () => {} } = options;
  let enabled = true;
  let adContentIds = new Set();

  const listener = (details, callback) => {
    const reason = enabled ? classifyAdRequest(details, adContentIds) : null;

    if (reason) {
      onRedirect({ details, reason });
      callback({ redirectURL });
      return;
    }

    callback({});
  };

  spotifySession.webRequest.onBeforeRequest(
    { urls: ['https://*/*'] },
    listener
  );

  return Object.freeze({
    clearAdContentIds() {
      adContentIds = new Set();
    },
    getAdContentIds() {
      return [...adContentIds];
    },
    isEnabled() {
      return enabled;
    },
    setAdContentIds(value) {
      adContentIds = new Set(normalizeAdContentIds(value));
      return [...adContentIds];
    },
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) {
        adContentIds = new Set();
      }
      return enabled;
    }
  });
}

module.exports = {
  MAX_AD_CONTENT_IDS,
  SPOTIFY_AD_ASSET_HOST,
  classifyAdRequest,
  hostnameMatches,
  installSpotifyBlocker,
  isSpotifyWebUrl,
  normalizeAdContentIds,
  requestCameFromSpotify
};
