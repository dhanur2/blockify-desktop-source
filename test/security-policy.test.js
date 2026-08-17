'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  argumentSwitch,
  findDisallowedRuntimeArgument,
  isAllowedNavigationForContents,
  isAllowedPopupForContents,
  isAllowedProtectedMediaPermission,
  isTrustedSpotifyIpcSender
} = require('../src/main/security-policy');

test('normalizes command-line switches without retaining their values', () => {
  assert.equal(argumentSwitch('--REMOTE-DEBUGGING-PORT=9222'), 'remote-debugging-port');
  assert.equal(argumentSwitch('--no-sandbox'), 'no-sandbox');
  assert.equal(argumentSwitch('--'), null);
  assert.equal(argumentSwitch('value'), null);
  assert.equal(argumentSwitch(undefined), null);
});

test('rejects unsafe Chromium and developer switches only in packaged builds', () => {
  for (const argument of [
    '--allow-running-insecure-content',
    '--dev',
    '--disable-web-security',
    '--enable-features=UnsafeFeature',
    '--host-rules=MAP * 127.0.0.1',
    '--ignore-certificate-errors',
    '--inspect=9229',
    '--js-flags=--expose-gc',
    '--no-sandbox',
    '--proxy-server=http://127.0.0.1:8080',
    '--remote-debugging-port=9222'
  ]) {
    assert.equal(
      findDisallowedRuntimeArgument(['Blockify.exe', argument], { isPackaged: true }),
      argumentSwitch(argument),
      argument
    );
    assert.equal(
      findDisallowedRuntimeArgument(['electron', '.', argument], { isPackaged: false }),
      null,
      `development run: ${argument}`
    );
  }
});

test('allows smoke-only switches only through the explicit test harness gate', () => {
  for (const argument of ['--smoke-test', '--user-data-dir=C:\\temp\\profile']) {
    assert.equal(
      findDisallowedRuntimeArgument(['Blockify.exe', argument], { isPackaged: true }),
      argumentSwitch(argument)
    );
    assert.equal(
      findDisallowedRuntimeArgument(['Blockify.exe', argument], {
        isPackaged: true,
        smokeTestAuthorized: true
      }),
      null
    );
  }
  assert.equal(
    findDisallowedRuntimeArgument(['Blockify.exe', '--force-device-scale-factor=1'], {
      isPackaged: true
    }),
    null
  );
});

test('accepts IPC only from the exact Spotify main frame', () => {
  const mainFrame = { url: 'https://open.spotify.com/collection' };
  const expectedContents = { mainFrame };
  assert.equal(isTrustedSpotifyIpcSender({
    sender: expectedContents,
    senderFrame: mainFrame
  }, expectedContents), true);

  for (const event of [
    { sender: expectedContents },
    { sender: expectedContents, senderFrame: { url: 'https://open.spotify.com/embed' } },
    { sender: expectedContents, senderFrame: { url: 'https://open.spotify.com.evil.test/' } },
    { sender: { mainFrame }, senderFrame: mainFrame },
    null
  ]) {
    assert.equal(isTrustedSpotifyIpcSender(event, expectedContents), false);
  }
});

test('allows protected media permission only for the exact player main frame', () => {
  const expectedContents = {};
  const allowed = (overrides = {}) => isAllowedProtectedMediaPermission(
    overrides.webContents ?? expectedContents,
    overrides.permission ?? 'mediaKeySystem',
    overrides.origin ?? 'https://open.spotify.com/',
    expectedContents,
    overrides.details ?? { isMainFrame: true }
  );

  assert.equal(allowed(), true);
  assert.equal(allowed({ details: {
    embeddingOrigin: 'https://open.spotify.com/',
    isMainFrame: true
  } }), true);
  assert.equal(allowed({ permission: 'camera' }), false);
  assert.equal(allowed({ origin: 'https://accounts.spotify.com/' }), false);
  assert.equal(allowed({ origin: 'https://open.spotify.com.evil.test/' }), false);
  assert.equal(allowed({ webContents: {} }), false);
  assert.equal(allowed({ details: { isMainFrame: false } }), false);
  assert.equal(allowed({ details: {} }), false);
  assert.equal(allowed({ details: {
    embeddingOrigin: 'https://evil.test/',
    isMainFrame: true
  } }), false);
  assert.equal(allowed({ details: {
    isMainFrame: true,
    securityOrigin: 'https://evil.test/'
  } }), false);
});

test('keeps local recovery routes and all popup creation out of child windows', () => {
  assert.equal(isAllowedNavigationForContents('blockify://app/loading', true), true);
  assert.equal(isAllowedNavigationForContents('blockify://app/loading', false), false);
  assert.equal(isAllowedNavigationForContents('https://accounts.spotify.com/login', false), true);
  assert.equal(isAllowedNavigationForContents('https://evil.test/', true), false);

  assert.equal(isAllowedPopupForContents('https://accounts.spotify.com/login', true), true);
  assert.equal(isAllowedPopupForContents('about:blank', true), true);
  assert.equal(isAllowedPopupForContents('https://accounts.spotify.com/login', false), false);
  assert.equal(isAllowedPopupForContents('blockify://app/loading', true), false);
  assert.equal(isAllowedPopupForContents('https://evil.test/', true), false);
});
