'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const { installBlockifyPageHook } = require('../src/preload/page-hook');

const GLOBAL_NAMES = ['window', 'document', 'location'];
let savedGlobals;

function saveGlobals() {
  savedGlobals = Object.fromEntries(
    GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
}

function restoreGlobals() {
  if (!savedGlobals) {
    return;
  }

  for (const name of GLOBAL_NAMES) {
    const descriptor = savedGlobals[name];
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
  savedGlobals = undefined;
}

afterEach(restoreGlobals);

function installGlobals({ fetch, WebSocket, hostname = 'open.spotify.com', withBody = true } = {}) {
  saveGlobals();

  const attributeWrites = [];
  const domListeners = new Map();
  const body = {
    attributes: new Map(),
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
      attributeWrites.push({ name, value });
    }
  };
  const document = {
    body: withBody ? body : null,
    addEventListener(type, listener, options) {
      domListeners.set(type, { listener, options });
    }
  };
  const window = { fetch, WebSocket };

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window, writable: true },
    document: { configurable: true, value: document, writable: true },
    location: { configurable: true, value: { hostname }, writable: true }
  });

  return {
    attributeWrites,
    body,
    document,
    domListeners,
    publishedIds() {
      const serialized = body.attributes.get('data-blockify-ad-content-ids');
      return serialized === undefined ? undefined : JSON.parse(serialized);
    },
    window
  };
}

function mockJsonResponse(payload, { reject = false, throwOnClone = false } = {}) {
  return {
    clone() {
      if (throwOnClone) {
        throw new Error('clone failed');
      }
      return {
        json() {
          return reject ? Promise.reject(new Error('invalid JSON')) : Promise.resolve(payload);
        }
      };
    }
  };
}

function adTrack(id, extra = {}) {
  return {
    content_type: 'AD',
    file_id: id,
    ...extra
  };
}

async function settleAsyncInspection() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('installs only on Spotify and remains idempotent', () => {
  const elsewhere = installGlobals({ hostname: 'example.com' });
  installBlockifyPageHook();
  assert.equal(elsewhere.window.__blockifyElectronHook, undefined);
  assert.equal(elsewhere.attributeWrites.length, 0);

  restoreGlobals();
  const spotify = installGlobals();
  installBlockifyPageHook();
  const installedHook = spotify.window.__blockifyElectronHook;
  installBlockifyPageHook();

  assert.equal(installedHook.version, '1.9.6');
  assert.ok(Object.isFrozen(installedHook));
  assert.deepEqual(spotify.publishedIds(), []);
  assert.equal(spotify.attributeWrites.length, 1);
});

test('fetch inspection detects supported ad payload shapes without changing the response', async () => {
  const payload = {
    state_machine: {
      tracks: [
        {
          metadata: { is_ad: true },
          manifest: { file_ids_mp3: [{ file_id: 'FETCH_AD_0001' }] }
        },
        {
          type: 'track',
          file_id: 'ORDINARY_TRACK_0001',
          manifest: { file_ids: ['ORDINARY_FILE_0001'] }
        }
      ],
      queue: {
        tracks: [
          {
            metadata: { contentType: 'advertisement' },
            manifest: { alternatives: [{ id: 'FETCH_AD_0002' }] }
          }
        ]
      }
    },
    payloads: [
      {
        stateMachine: {
          track_list: [{ isAd: 'true', fileId: 'FETCH_AD_0003' }]
        }
      }
    ]
  };
  const response = mockJsonResponse(payload);
  const nativePromise = Promise.resolve(response);
  const calls = [];
  function nativeFetch(...args) {
    calls.push(args);
    return nativePromise;
  }
  const harness = installGlobals({ fetch: nativeFetch });
  installBlockifyPageHook();

  const request = { url: 'https://open.spotify.com/api/state?market=from_token' };
  const returnedPromise = harness.window.fetch(request, { credentials: 'include' });

  assert.strictEqual(returnedPromise, nativePromise);
  assert.deepEqual(calls, [[request, { credentials: 'include' }]]);
  await returnedPromise;
  await settleAsyncInspection();
  assert.deepEqual(harness.publishedIds(), [
    'FETCH_AD_0001',
    'FETCH_AD_0002',
    'FETCH_AD_0003'
  ]);
});

test('fetch inspection ignores non-state responses, non-ads, unsafe IDs, and parsing failures', async () => {
  const responses = [
    mockJsonResponse({ state_machine: { tracks: [adTrack('IGNORED_URL_0001')] } }),
    mockJsonResponse({
      stateMachine: {
        tracks: [
          { type: 'track', fileId: 'NON_AD_TRACK_0001' },
          adTrack('short'),
          adTrack('../unsafe-content-id'),
          adTrack('x'.repeat(129))
        ]
      }
    }),
    mockJsonResponse(null, { reject: true }),
    mockJsonResponse(null, { throwOnClone: true })
  ];
  function nativeFetch() {
    return Promise.resolve(responses.shift());
  }
  const harness = installGlobals({ fetch: nativeFetch });
  installBlockifyPageHook();

  await harness.window.fetch('https://open.spotify.com/api/profile');
  await harness.window.fetch('https://open.spotify.com/api/state');
  await harness.window.fetch('https://open.spotify.com/api/state?bad=json');
  await harness.window.fetch('https://open.spotify.com/api/state?clone=fails');
  await settleAsyncInspection();

  assert.deepEqual(harness.publishedIds(), []);
  assert.equal(harness.attributeWrites.length, 1);
});

test('WebSocket inspection detects string, Blob, and ArrayBuffer ads safely', async () => {
  const sockets = [];
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    emitMessage(data) {
      this.listeners.get('message')?.({ data });
    }
  }

  const harness = installGlobals({ WebSocket: FakeWebSocket });
  installBlockifyPageHook();
  const socket = new harness.window.WebSocket('wss://dealer.spotify.com/', ['json']);

  assert.strictEqual(socket, sockets[0]);
  assert.equal(socket.url, 'wss://dealer.spotify.com/');
  assert.deepEqual(socket.protocols, ['json']);

  socket.emitMessage('{ definitely not JSON');
  socket.emitMessage({ state_machine: { tracks: [adTrack('OBJECT_IGNORED_01')] } });
  socket.emitMessage(' '.repeat(8_000_001));
  assert.deepEqual(harness.publishedIds(), []);

  socket.emitMessage(JSON.stringify({
    payloads: [
      {
        state_machine: {
          queue: {
            tracks: [
              {
                metadata: { isAd: true },
                manifest: {
                  file_ids_external: [
                    'WEBSOCKET_AD_0001',
                    { fileId: 'WEBSOCKET_AD_0002' }
                  ]
                }
              }
            ]
          }
        }
      }
    ]
  }));

  assert.deepEqual(harness.publishedIds(), [
    'WEBSOCKET_AD_0001',
    'WEBSOCKET_AD_0002'
  ]);

  socket.emitMessage(new Blob([JSON.stringify({
    stateMachine: { tracks: [adTrack('WEBSOCKET_BLOB_001')] }
  })]));
  const binaryPayload = new TextEncoder().encode(JSON.stringify({
    state_machine: { tracks: [adTrack('WEBSOCKET_BUFFER_1')] }
  })).buffer;
  socket.emitMessage(binaryPayload);
  await settleAsyncInspection();

  assert.deepEqual(harness.publishedIds(), [
    'WEBSOCKET_AD_0001',
    'WEBSOCKET_AD_0002',
    'WEBSOCKET_BUFFER_1',
    'WEBSOCKET_BLOB_001'
  ]);
});

test('retains and publishes only the 32 most recently observed ad content IDs', () => {
  class FakeWebSocket {
    addEventListener(type, listener) {
      if (type === 'message') {
        this.onMessage = listener;
      }
    }

    emit(payload) {
      this.onMessage({ data: JSON.stringify(payload) });
    }
  }

  const harness = installGlobals({ WebSocket: FakeWebSocket });
  installBlockifyPageHook();
  const socket = new harness.window.WebSocket('wss://dealer.spotify.com/');
  const ids = Array.from({ length: 36 }, (_, index) => `AD_CONTENT_${String(index).padStart(3, '0')}`);
  const payload = {
    state_machine: {
      tracks: [
        {
          contentType: 'advertisement',
          manifest: { file_ids: ids }
        }
      ]
    }
  };

  socket.emit(payload);
  assert.deepEqual(harness.publishedIds(), ids.slice(4));
  assert.equal(harness.attributeWrites.length, 2);

  socket.emit(payload);
  assert.deepEqual(harness.publishedIds(), ids.slice(4));
  assert.equal(harness.attributeWrites.length, 2, 'unchanged IDs should not be republished');

  socket.emit({ state_machine: { tracks: [adTrack('AD_CONTENT_036')] } });
  assert.deepEqual(harness.publishedIds(), [...ids.slice(5), 'AD_CONTENT_036']);
  assert.equal(harness.attributeWrites.length, 3);
});

test('defers the initial publication until DOMContentLoaded when body is unavailable', () => {
  const harness = installGlobals({ withBody: false });
  installBlockifyPageHook();

  assert.equal(harness.attributeWrites.length, 0);
  const registration = harness.domListeners.get('DOMContentLoaded');
  assert.deepEqual(registration.options, { once: true });

  harness.document.body = harness.body;
  registration.listener();
  assert.deepEqual(harness.publishedIds(), []);
});
