const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_INTERNAL_ERROR_MESSAGE_LENGTH,
  isInternalAppUrl,
  isProtectedPlaybackRetryUrl,
  isSpotifyHost,
  isSpotifyPlayerUrl,
  isTrustedAppNavigation,
  isTrustedPopupUrl,
  parseUrl
} = require('../src/main/navigation');

test('parses URLs without throwing on malformed or non-string input', () => {
  assert.equal(parseUrl('https://open.spotify.com/').hostname, 'open.spotify.com');
  assert.equal(parseUrl('not a URL'), null);
  assert.equal(parseUrl(undefined), null);
});

test('matches Spotify hosts without matching lookalike domains', () => {
  for (const hostname of [
    'spotify.com',
    'accounts.spotify.com',
    'deep.accounts.spotify.com'
  ]) {
    assert.equal(isSpotifyHost(hostname), true, hostname);
  }

  for (const hostname of [
    'evilspotify.com',
    'spotify.com.example.org',
    'spotify.example.com',
    'open.spotify.com.evil.test',
    ''
  ]) {
    assert.equal(isSpotifyHost(hostname), false, hostname);
  }
});

test('recognizes only the Blockify app origin as an internal URL', () => {
  for (const value of [
    'blockify://app/loading',
    'blockify://app/error?message=offline'
  ]) {
    assert.equal(isInternalAppUrl(value), true, value);
    assert.equal(isTrustedAppNavigation(value), true, value);
  }

  for (const value of [
    'blockify://evil/loading',
    'blockify://APP/retry',
    'blockify://app.evil.test/loading',
    'blockify://app@evil.test/loading',
    'blockify://user@app/loading',
    'blockify://app:8443/loading',
    'blockify://app/loading?unexpected=1',
    'blockify://app/error#unexpected',
    'blockify://app/error?unknown=1',
    'blockify://app/error?message=one&message=two',
    'blockify://app/error?retry=arbitrary',
    `blockify://app/error?message=${'x'.repeat(MAX_INTERNAL_ERROR_MESSAGE_LENGTH + 1)}`,
    'blockify://app/unknown',
    'blockify://app/icon.png',
    'blockify:app/loading',
    'https://app/loading',
    'not a URL'
  ]) {
    assert.equal(isInternalAppUrl(value), false, value);
    assert.equal(isTrustedAppNavigation(value), false, value);
  }
});

test('recognizes only the exact protected-playback retry command', () => {
  assert.equal(
    isProtectedPlaybackRetryUrl('blockify://app/retry-protected-playback'),
    true
  );

  for (const value of [
    'blockify://app/retry-protected-playback?again=1',
    'blockify://app/retry-protected-playback#again',
    'blockify://user@app/retry-protected-playback',
    'blockify://evil/retry-protected-playback',
    'blockify://app/retry-protected-playback/extra',
    'https://app/retry-protected-playback',
    'not a URL'
  ]) {
    assert.equal(isProtectedPlaybackRetryUrl(value), false, value);
  }
});

test('allows Spotify and exact OAuth hosts in-app but rejects lookalikes and insecure URLs', () => {
  for (const value of [
    'about:blank',
    'https://open.spotify.com/collection',
    'https://accounts.spotify.com/login',
    'https://accounts.google.com/o/oauth2/auth',
    'https://appleid.apple.com/auth/authorize',
    'https://www.facebook.com/login'
  ]) {
    assert.equal(isTrustedAppNavigation(value), true, value);
  }

  for (const value of [
    'about:blank#unexpected',
    'http://open.spotify.com/',
    'https://open.spotify.com.evil.test/',
    'https://open.spotify.com@evil.test/',
    'https://user@open.spotify.com/',
    'https://open.spotify.com:8443/',
    'https://accounts.google.com.evil.test/',
    'https://accounts.google.example.com/',
    'https://example.com/',
    'javascript:alert(1)',
    'file:///etc/passwd'
  ]) {
    assert.equal(isTrustedAppNavigation(value), false, value);
  }
});

test('allows only HTTPS auth/player targets and blank bootstrap pages as popups', () => {
  for (const value of [
    'about:blank',
    'https://open.spotify.com/',
    'https://accounts.spotify.com/login',
    'https://accounts.google.com/o/oauth2/auth'
  ]) {
    assert.equal(isTrustedPopupUrl(value), true, value);
  }

  for (const value of [
    'blockify://app/loading',
    'blockify://app/error?message=offline',
    'blockify://app/retry-protected-playback',
    'https://user@accounts.spotify.com/login',
    'https://accounts.spotify.com:8443/login',
    'https://example.com/',
    'javascript:alert(1)'
  ]) {
    assert.equal(isTrustedPopupUrl(value), false, value);
  }
});

test('recognizes only the exact HTTPS Spotify player origin', () => {
  assert.equal(isSpotifyPlayerUrl('https://open.spotify.com/collection'), true);
  assert.equal(isSpotifyPlayerUrl('https://OPEN.SPOTIFY.COM/'), true);
  assert.equal(isSpotifyPlayerUrl('http://open.spotify.com/'), false);
  assert.equal(isSpotifyPlayerUrl('https://accounts.spotify.com/'), false);
  assert.equal(isSpotifyPlayerUrl('https://user@open.spotify.com/'), false);
  assert.equal(isSpotifyPlayerUrl('https://open.spotify.com:8443/'), false);
  assert.equal(isSpotifyPlayerUrl('https://sub.open.spotify.com/'), false);
  assert.equal(isSpotifyPlayerUrl('https://open.spotify.com.evil.test/'), false);
  assert.equal(isSpotifyPlayerUrl('not a URL'), false);
});
