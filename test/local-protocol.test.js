'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const {
  SILENT_WAV,
  createLocalProtocolHandler,
  parseByteRange
} = require('../src/main/local-protocol');

const MEDIA_BYTES = SILENT_WAV;

let fixtureDirectory;
let handler;
let handlerWithTestFixture;

function protocolRequest(url, { method = 'GET', range } = {}) {
  const headers = new Headers();
  if (range !== undefined) {
    headers.set('Range', range);
  }

  return { headers, method, url };
}

async function responseBytes(response) {
  return Buffer.from(await response.arrayBuffer());
}

before(() => {
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'blockify-protocol-test-'));
  const shellCssPath = path.join(fixtureDirectory, 'shell.css');
  fs.writeFileSync(shellCssPath, 'body { color: white; }', 'utf8');

  const options = { shellCssPath };
  handler = createLocalProtocolHandler(options);
  handlerWithTestFixture = createLocalProtocolHandler({
    ...options,
    includeTestFixture: true
  });
});

after(() => {
  if (!fixtureDirectory) {
    return;
  }

  const resolvedFixtureDirectory = path.resolve(fixtureDirectory);
  const resolvedTempDirectory = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(
    resolvedFixtureDirectory.startsWith(resolvedTempDirectory),
    true,
    'temporary fixture directory must remain inside the OS temp directory'
  );
  fs.rmSync(resolvedFixtureDirectory, { force: true, recursive: true });
});

test('serves the generated silent WAV for GET with playback and CORS headers', async () => {
  const response = handler(protocolRequest('blockify-media://media/noop-1s.wav'));

  assert.equal(response.status, 200);
  assert.deepEqual(await responseBytes(response), MEDIA_BYTES);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://open.spotify.com');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-length'), String(MEDIA_BYTES.length));
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-range'), null);
});

test('supports media CORS preflight and rejects unsupported methods', async () => {
  const preflight = handler(protocolRequest('blockify-media://media/noop-1s.wav', {
    method: 'OPTIONS'
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://open.spotify.com');
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Range');

  const rejected = handler(protocolRequest('blockify-media://media/noop-1s.wav', {
    method: 'POST'
  }));
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assert.equal((await responseBytes(rejected)).length, 0);
});

test('serves media metadata without a body for HEAD', async () => {
  const response = handler(protocolRequest('blockify-media://media/noop-1s.wav', { method: 'HEAD' }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(MEDIA_BYTES.length));
  assert.equal((await responseBytes(response)).length, 0);
});

test('serves closed, open-ended, and suffix byte ranges', async (t) => {
  const lastByte = MEDIA_BYTES.length - 1;
  const cases = [
    {
      expected: MEDIA_BYTES.subarray(2, 6),
      expectedRange: `bytes 2-5/${MEDIA_BYTES.length}`,
      name: 'closed range',
      range: 'bytes=2-5'
    },
    {
      expected: MEDIA_BYTES.subarray(4),
      expectedRange: `bytes 4-${lastByte}/${MEDIA_BYTES.length}`,
      name: 'open-ended range',
      range: 'bytes=4-'
    },
    {
      expected: MEDIA_BYTES.subarray(-3),
      expectedRange: `bytes ${MEDIA_BYTES.length - 3}-${lastByte}/${MEDIA_BYTES.length}`,
      name: 'suffix range',
      range: 'bytes=-3'
    },
    {
      expected: MEDIA_BYTES,
      expectedRange: `bytes 0-${lastByte}/${MEDIA_BYTES.length}`,
      name: 'suffix longer than the resource',
      range: 'bytes=-999999'
    },
    {
      expected: MEDIA_BYTES.subarray(lastByte - 1),
      expectedRange: `bytes ${lastByte - 1}-${lastByte}/${MEDIA_BYTES.length}`,
      name: 'end beyond the resource',
      range: `bytes=${lastByte - 1}-999999`
    }
  ];

  for (const rangeCase of cases) {
    await t.test(rangeCase.name, async () => {
      const response = handler(protocolRequest('blockify-media://media/noop-1s.wav', {
        range: rangeCase.range
      }));

      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), rangeCase.expectedRange);
      assert.equal(response.headers.get('content-length'), String(rangeCase.expected.length));
      assert.deepEqual(await responseBytes(response), rangeCase.expected);
    });
  }
});

test('returns a bodyless partial response for a valid ranged HEAD request', async () => {
  const response = handler(protocolRequest('blockify-media://media/noop-1s.wav', {
    method: 'HEAD',
    range: 'bytes=1-3'
  }));

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 1-3/${MEDIA_BYTES.length}`);
  assert.equal(response.headers.get('content-length'), '3');
  assert.equal((await responseBytes(response)).length, 0);
});

test('rejects malformed and unsatisfiable ranges with 416 and resource size', async (t) => {
  const invalidRanges = [
    'bytes=',
    'bytes=-0',
    `bytes=${MEDIA_BYTES.length}-`,
    'bytes=5-4',
    'bytes=0-1,3-4',
    'items=0-1',
    'BYTES=0-1',
    'bytes= 0-1'
  ];

  for (const range of invalidRanges) {
    await t.test(range, async () => {
      const response = handler(protocolRequest('blockify-media://media/noop-1s.wav', { range }));

      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), `bytes */${MEDIA_BYTES.length}`);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://open.spotify.com');
      assert.equal(response.headers.get('content-type'), 'audio/wav');
      assert.equal((await responseBytes(response)).length, 0);
    });
  }
});

test('parseByteRange accepts valid forms and rejects invalid resource bounds', () => {
  const lastByte = MEDIA_BYTES.length - 1;
  assert.deepEqual(parseByteRange('bytes=0-0', MEDIA_BYTES.length), { start: 0, end: 0 });
  assert.deepEqual(parseByteRange(`bytes=${lastByte}-`, MEDIA_BYTES.length), { start: lastByte, end: lastByte });
  assert.deepEqual(parseByteRange('bytes=-1', MEDIA_BYTES.length), { start: lastByte, end: lastByte });
  assert.equal(parseByteRange('bytes=0-0', 0), null);
  assert.equal(parseByteRange(undefined, MEDIA_BYTES.length), null);
});

test('serves the recovery stylesheet only from the app scheme', async () => {
  const response = handler(protocolRequest('blockify://app/shell.css'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'body { color: white; }');
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');

  const crossScheme = handler(protocolRequest('blockify-media://app/shell.css'));
  assert.equal(crossScheme.status, 404);
});

test('sends local recovery-page CSP and privacy headers and rejects POST', async () => {
  const response = handler(protocolRequest('blockify://app/loading'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline/u);
  assert.match(response.headers.get('content-security-policy'), /style-src 'self'/u);
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), display-capture=()');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');

  const headResponse = handler(protocolRequest('blockify://app/loading', { method: 'HEAD' }));
  assert.equal(headResponse.status, 200);
  assert.equal((await responseBytes(headResponse)).length, 0);
  assert.ok(Number(headResponse.headers.get('content-length')) > 0);

  const rejected = handler(protocolRequest('blockify://app/loading', { method: 'POST' }));
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
});

test('keeps the synthetic state endpoint on the isolated media scheme and behind includeTestFixture', async () => {
  const disabledResponse = handler(protocolRequest('blockify-media://test/state-fixture'));
  assert.equal(disabledResponse.status, 404);
  assert.equal(await disabledResponse.text(), 'Not found');

  const enabledResponse = handlerWithTestFixture(protocolRequest('blockify-media://test/state-fixture'));
  assert.equal(enabledResponse.status, 200);
  assert.equal(enabledResponse.headers.get('cache-control'), 'no-store');
  assert.match(enabledResponse.headers.get('content-type'), /^application\/json\b/);
  assert.deepEqual(await enabledResponse.json(), {
    state_machine: {
      tracks: [{
        content_type: 'AD',
        manifest: { file_ids_mp3: [{ file_id: 'smoke_ad_id_12345' }] }
      }]
    }
  });
});

test('serves only fixed retry targets on the escaped recovery page', async () => {
  const protectedPlaybackResponse = handler(protocolRequest(
    'blockify://app/error?message=offline&retry=protected-playback'
  ));
  const protectedPlaybackHtml = await protectedPlaybackResponse.text();
  assert.match(protectedPlaybackHtml, /href="blockify:\/\/app\/retry-protected-playback"/);

  const arbitraryResponse = handler(protocolRequest(
    'blockify://app/error?retry=https%3A%2F%2Fevil.example'
  ));
  const arbitraryHtml = await arbitraryResponse.text();
  assert.match(arbitraryHtml, /href="https:\/\/open\.spotify\.com\/"/);
  assert.doesNotMatch(arbitraryHtml, /evil\.example/u);
});

test('returns 404 for unknown protocol hosts and app routes, and 400 for invalid URLs', async () => {
  for (const url of [
    'blockify://unknown/noop-1s.wav',
    'blockify://app/unknown',
    'blockify://media/noop-1s.wav',
    'blockify-media://app/loading',
    'blockify-media://media/unknown.wav'
  ]) {
    const response = handler(protocolRequest(url));
    assert.equal(response.status, 404, url);
    assert.equal(await response.text(), 'Not found', url);
  }

  const badResponse = handler(protocolRequest('not a URL'));
  assert.equal(badResponse.status, 400);
  assert.equal(await badResponse.text(), 'Bad request');
});
