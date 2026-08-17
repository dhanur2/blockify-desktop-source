'use strict';

const {
  isInternalAppUrl,
  isSpotifyPlayerUrl,
  isTrustedAppNavigation,
  isTrustedPopupUrl
} = require('./navigation');

const DISALLOWED_PACKAGED_SWITCHES = new Set([
  'allow-file-access-from-files',
  'allow-insecure-localhost',
  'allow-running-insecure-content',
  'debug',
  'debug-brk',
  'dev',
  'disable-features',
  'disable-gpu-sandbox',
  'disable-seccomp-filter-sandbox',
  'disable-setuid-sandbox',
  'disable-site-isolation-for-policy',
  'disable-site-isolation-trials',
  'disable-web-security',
  'enable-features',
  'enable-logging',
  'experimental-web-platform-features',
  'host-resolver-rules',
  'host-rules',
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  'ignore-ssl-errors',
  'ignore-urlfetcher-cert-requests',
  'inspect',
  'inspect-brk',
  'js-flags',
  'no-sandbox',
  'no-zygote',
  'proxy-bypass-list',
  'proxy-pac-url',
  'proxy-server',
  'remote-debugging-address',
  'remote-debugging-pipe',
  'remote-debugging-port',
  'single-process',
  'unsafely-treat-insecure-origin-as-secure'
]);

function argumentSwitch(value) {
  if (typeof value !== 'string' || !value.startsWith('--')) {
    return null;
  }
  return value.slice(2).split('=', 1)[0].trim().toLowerCase() || null;
}

function findDisallowedRuntimeArgument(argv, options = {}) {
  if (!options.isPackaged || !Array.isArray(argv)) {
    return null;
  }

  for (const argument of argv.slice(1)) {
    const switchName = argumentSwitch(argument);
    if (!switchName) {
      continue;
    }

    if (DISALLOWED_PACKAGED_SWITCHES.has(switchName)) {
      return switchName;
    }

    if (
      (switchName === 'smoke-test' || switchName === 'user-data-dir') &&
      !options.smokeTestAuthorized
    ) {
      return switchName;
    }
  }

  return null;
}

function isTrustedSpotifyIpcSender(event, expectedContents) {
  if (
    !event ||
    !expectedContents ||
    event.sender !== expectedContents ||
    !event.senderFrame ||
    event.senderFrame !== expectedContents.mainFrame
  ) {
    return false;
  }

  return isSpotifyPlayerUrl(event.senderFrame.url);
}

function isAllowedProtectedMediaPermission(
  requestingContents,
  permission,
  requestingOrigin,
  expectedContents,
  details = {}
) {
  if (
    requestingContents !== expectedContents ||
    permission !== 'mediaKeySystem' ||
    details.isMainFrame !== true ||
    !isSpotifyPlayerUrl(requestingOrigin)
  ) {
    return false;
  }

  if (details.embeddingOrigin && !isSpotifyPlayerUrl(details.embeddingOrigin)) {
    return false;
  }
  if (details.securityOrigin && !isSpotifyPlayerUrl(details.securityOrigin)) {
    return false;
  }

  return true;
}

function isAllowedNavigationForContents(value, isMainContents) {
  if (isInternalAppUrl(value) && !isMainContents) {
    return false;
  }
  return isTrustedAppNavigation(value);
}

function isAllowedPopupForContents(value, isMainContents) {
  return Boolean(isMainContents && isTrustedPopupUrl(value));
}

module.exports = {
  DISALLOWED_PACKAGED_SWITCHES,
  argumentSwitch,
  findDisallowedRuntimeArgument,
  isAllowedNavigationForContents,
  isAllowedPopupForContents,
  isAllowedProtectedMediaPermission,
  isTrustedSpotifyIpcSender
};
