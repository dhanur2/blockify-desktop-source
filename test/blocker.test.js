const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_AD_CONTENT_IDS,
  classifyAdRequest,
  installSpotifyBlocker,
  isSpotifyWebUrl,
  normalizeAdContentIds,
  requestCameFromSpotify
} = require('../src/main/blocker');

function request(url, overrides = {}) {
  return {
    documentURL: 'https://open.spotify.com/',
    resourceType: 'media',
    url,
    ...overrides
  };
}

function createFakeSession() {
  const registrations = [];

  return {
    registrations,
    webRequest: {
      onBeforeRequest(filter, listener) {
        registrations.push({ filter, listener });
      }
    }
  };
}

function invokeListener(listener, details) {
  const callbackResults = [];
  listener(details, (result) => callbackResults.push(result));
  assert.equal(callbackResults.length, 1, 'listener must invoke its callback exactly once');
  return callbackResults[0];
}

test('normalizes, deduplicates, validates, and bounds page-provided ad content IDs', () => {
  const maxLengthId = 'a'.repeat(128);
  const values = [
    ' valid_id_123 ',
    'valid_id_123',
    'abcdefgh',
    'minimum8',
    'seven77',
    maxLengthId,
    'b'.repeat(129),
    '',
    '../not-safe',
    'contains space',
    42,
    null,
    ...Array.from({ length: 40 }, (_, index) => `content_id_${index}`)
  ];

  const result = normalizeAdContentIds(values);
  assert.deepEqual(result.slice(0, 4), [
    'valid_id_123',
    'abcdefgh',
    'minimum8',
    maxLengthId
  ]);
  assert.equal(result.length, MAX_AD_CONTENT_IDS);
  assert.equal(result.includes('../not-safe'), false);
  assert.equal(result.includes('contains space'), false);
  assert.deepEqual(normalizeAdContentIds('valid_id_123'), []);
  assert.deepEqual(normalizeAdContentIds(null), []);
});

test('recognizes only the exact Spotify Web player as a request initiator', () => {
  assert.equal(isSpotifyWebUrl('https://open.spotify.com/'), true);
  assert.equal(isSpotifyWebUrl('http://open.spotify.com/'), false);
  assert.equal(isSpotifyWebUrl('https://accounts.spotify.com/'), false);
  assert.equal(isSpotifyWebUrl('https://open.spotify.com.evil.test/'), false);
  assert.equal(isSpotifyWebUrl('file://open.spotify.com/'), false);

  assert.equal(requestCameFromSpotify(request('https://audio.example/song.mp3')), true);
  assert.equal(requestCameFromSpotify(request('https://audio.example/song.mp3', {
    documentURL: 'https://example.com/',
    referrer: 'https://open.spotify.com/collection'
  })), true);
  assert.equal(requestCameFromSpotify(request('https://audio.example/song.mp3', {
    documentURL: 'https://example.com/',
    frame: { url: 'https://open.spotify.com/embed/track' }
  })), true);
  assert.equal(requestCameFromSpotify(request('https://audio.example/song.mp3', {
    documentURL: 'https://example.com/',
    webContents: { getURL: () => 'https://open.spotify.com/' }
  })), true);
  assert.equal(requestCameFromSpotify(request('https://audio.example/song.mp3', {
    documentURL: 'https://example.com/',
    webContents: { getURL: () => { throw new Error('destroyed'); } }
  })), false);
});

test('redirects static ad hosts and their subdomains without matching lookalikes', () => {
  for (const url of [
    'https://2mdn.net/ad.mp3',
    'https://audio.2mdn.net/ad.mp3',
    'https://cdn.amillionads.com/ad.mp3'
  ]) {
    assert.equal(classifyAdRequest(request(url), new Set()), 'known-ad-host', url);
  }

  for (const url of [
    'https://evil2mdn.net/ad.mp3',
    'https://2mdn.net.evil.test/ad.mp3',
    'https://amillionads.com.evil.test/ad.mp3',
    'http://amillionads.com/ad.mp3',
    'https://securepubads.g.doubleclick.net/path'
  ]) {
    assert.equal(classifyAdRequest(request(url), new Set()), null, url);
  }
});

test('does not blanket-block Spotify CDN media without a detected ad ID', () => {
  for (const url of [
    'https://audio-fa.scdn.co/mp3/example',
    'https://audio4-fa.scdn.co/audio/normal-track',
    'https://scdn.co/mp3/normal-track'
  ]) {
    assert.equal(classifyAdRequest(request(url), new Set()), null, url);
  }
});

test('redirects only the confirmed Spotify Ad Studio MP3 asset route', () => {
  for (const url of [
    'https://adstudio-assets.scdn.co/mp3/confirmed-ad-file',
    'https://adstudio-assets.scdn.co/mp3-ad/confirmed-ad-file'
  ]) {
    assert.equal(classifyAdRequest(request(url), new Set()), 'spotify-ad-asset', url);
  }

  for (const url of [
    'https://audio-ak.spotifycdn.com/audio/ordinary-track',
    'https://adstudio-assets.scdn.co/audio/ordinary-track',
    'https://adstudio-assets.scdn.co/mp3-preview/ordinary-track',
    'https://sub.adstudio-assets.scdn.co/mp3/lookalike',
    'https://adstudio-assets.scdn.co.evil.test/mp3/lookalike'
  ]) {
    assert.equal(classifyAdRequest(request(url), new Set()), null, url);
  }
});

test('redirects detected ad IDs only for Spotify-initiated media requests', () => {
  const ids = new Set(['abcdef1234567890']);
  assert.equal(
    classifyAdRequest(request('https://audio.example/abcdef1234567890.mp3'), ids),
    'detected-ad-content'
  );

  const passThroughRequests = [
    request('https://audio.example/abcdef1234567890.mp3', { resourceType: 'xhr' }),
    request('https://audio.example/abcdef1234567890.mp3', { resourceType: 'script' }),
    request('https://audio.example/abcdef1234567890.mp3', { documentURL: 'https://example.com/' }),
    request('https://audio.example/abcdef1234567890.mp3', { documentURL: 'https://open.spotify.com.evil.test/' }),
    request('ftp://audio.example/abcdef1234567890.mp3'),
    request('not a URL')
  ];

  for (const details of passThroughRequests) {
    assert.equal(classifyAdRequest(details, ids), null, details.url);
  }
});

test('installs one listener and toggles redirects without retaining stale IDs', () => {
  const spotifySession = createFakeSession();
  const redirects = [];
  const blocker = installSpotifyBlocker(spotifySession, {
    redirectURL: 'blockify-media://media/noop-1s.wav',
    onRedirect(event) {
      redirects.push(event);
    }
  });

  assert.equal(spotifySession.registrations.length, 1);
  assert.deepEqual(spotifySession.registrations[0].filter, {
    urls: ['https://*/*']
  });
  assert.equal(blocker.isEnabled(), true);
  assert.deepEqual(blocker.getAdContentIds(), []);

  const listener = spotifySession.registrations[0].listener;
  assert.deepEqual(
    invokeListener(listener, request('https://audio.example/song.mp3')),
    {}
  );

  assert.deepEqual(blocker.setAdContentIds([
    'abcdef1234567890',
    'abcdef1234567890',
    '../invalid'
  ]), ['abcdef1234567890']);
  assert.deepEqual(
    invokeListener(listener, request('https://audio.example/abcdef1234567890.mp3')),
    { redirectURL: 'blockify-media://media/noop-1s.wav' }
  );
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0].reason, 'detected-ad-content');

  assert.equal(blocker.setEnabled(false), false);
  assert.equal(blocker.isEnabled(), false);
  assert.deepEqual(blocker.getAdContentIds(), []);
  assert.deepEqual(
    invokeListener(listener, request('https://audio.2mdn.net/ad.mp3')),
    {}
  );
  assert.equal(redirects.length, 1);

  assert.equal(blocker.setEnabled(true), true);
  assert.deepEqual(
    invokeListener(listener, request('https://audio.example/abcdef1234567890.mp3')),
    {},
    're-enabling must not restore IDs cleared while disabled'
  );
  assert.deepEqual(
    invokeListener(listener, request('https://audio.2mdn.net/ad.mp3')),
    { redirectURL: 'blockify-media://media/noop-1s.wav' }
  );
  assert.equal(redirects.length, 2);
  assert.equal(redirects[1].reason, 'known-ad-host');

  blocker.setAdContentIds(['new_ad_id_123']);
  blocker.clearAdContentIds();
  assert.deepEqual(blocker.getAdContentIds(), []);
});
