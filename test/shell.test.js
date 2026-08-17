'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  MAX_ERROR_MESSAGE_LENGTH,
  SHELL_PAGE_CSP,
  escapeHtml,
  renderShellPage
} = require('../src/renderer/shell');

test('escapeHtml encodes every HTML-significant character', () => {
  assert.equal(
    escapeHtml(`&<>"'`),
    '&amp;&lt;&gt;&quot;&#39;'
  );
  assert.equal(escapeHtml(42), '42');
});

test('renders a loading page with a strict, external-style CSP', () => {
  const html = renderShellPage({ mode: 'loading' });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Blockify<\/title>/);
  assert.match(html, /<h1>Preparing Spotify<\/h1>/);
  assert.match(html, /Setting up protected playback\./);
  assert.match(html, /class="pulse" aria-label="Loading"/);
  assert.doesNotMatch(html, /class="action"/);
  assert.match(
    html,
    new RegExp(`Content-Security-Policy" content="${SHELL_PAGE_CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
  );
  assert.match(html, /<link rel="stylesheet" href="blockify:\/\/app\/shell\.css">/);
  assert.doesNotMatch(html, /unsafe-inline|<style\b/i);
  assert.doesNotMatch(html, /script-src|<script\b/i);
});

test('renders escaped error text and the fixed Spotify retry target', () => {
  const maliciousMessage = `<img src=x onerror="alert('owned')"> & goodbye`;
  const html = renderShellPage({ mode: 'error', message: maliciousMessage });

  assert.match(html, /<h1>Spotify could not be reached<\/h1>/);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(&#39;owned&#39;)&quot;&gt; &amp; goodbye'));
  assert.equal(html.includes(maliciousMessage), false);
  assert.match(html, /<a class="action" href="https:\/\/open\.spotify\.com\/">Try again<\/a>/);
  assert.doesNotMatch(html, /<img src=x|onerror="alert/);
});

test('renders the fixed protected-playback restart target only for its safe mode', () => {
  const html = renderShellPage({
    mode: 'error',
    retryMode: 'protected-playback'
  });

  assert.match(
    html,
    /<a class="action" href="blockify:\/\/app\/retry-protected-playback">Restart and try again<\/a>/
  );
  assert.doesNotMatch(html, /href="https:\/\/open\.spotify\.com\//);
});

test('falls back to safe modes and default error copy', () => {
  const defaultError = renderShellPage({ mode: 'error' });
  assert.match(defaultError, /Check your connection, then try again\./);

  const unknownMode = renderShellPage({ mode: 'unexpected', message: '<unsafe>' });
  assert.match(unknownMode, /<h1>Preparing Spotify<\/h1>/);
  assert.equal(unknownMode.includes('<unsafe>'), false);
  assert.doesNotMatch(unknownMode, /Try again/);
});

test('bounds recovery-page error text before rendering', () => {
  const html = renderShellPage({ mode: 'error', message: 'x'.repeat(10_000) });
  assert.match(html, new RegExp(`<p>x{${MAX_ERROR_MESSAGE_LENGTH}}</p>`));
  assert.doesNotMatch(html, new RegExp(`x{${MAX_ERROR_MESSAGE_LENGTH + 1}}`));
});
