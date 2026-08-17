const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createLocalDiagnostics,
  normalizeDetails,
  normalizeEventName,
  redactText
} = require('../src/main/diagnostics');

test('redacts URLs, email addresses, and user paths from diagnostic text', () => {
  const source = [
    'failed at https://open.spotify.com/user/secret?token=value',
    'for person@example.com',
    'in C:\\Users\\Private Name\\AppData\\file.txt',
    'or /home/private/.config/blockify',
    'Bearer not-a-real-secret-token'
  ].join('\n');
  const redacted = redactText(source);

  assert.doesNotMatch(
    redacted,
    /spotify\.com|person@example|Private Name|Name\\AppData|\/home\/private|not-a-real/u
  );
  assert.match(redacted, /\[url\]/u);
  assert.match(redacted, /\[email\]/u);
  assert.match(redacted, /\[path\]/u);
  assert.match(redacted, /\[credential\]/u);
});

test('normalizes event names and retains only bounded primitive details', () => {
  assert.equal(normalizeEventName(' Renderer GONE!! '), 'renderer-gone');
  assert.equal(normalizeEventName(''), 'unknown');

  const details = normalizeDetails({
    reason: 'crashed',
    exitCode: -1,
    recoverable: false,
    accessToken: 'must-not-be-written',
    currentUrl: 'https://example.test/private',
    ignored: { secret: true },
    missing: null,
    'invalid key!': 'kept under a normalized key'
  });
  assert.deepEqual(details, {
    reason: 'crashed',
    exitCode: -1,
    recoverable: false,
    invalidkey: 'kept under a normalized key'
  });
});

test('writes bounded local JSONL files, rotates once, and clears both files', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blockify-diagnostics-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const diagnostics = createLocalDiagnostics({
    appVersion: '1.9.6',
    clock: () => new Date('2026-08-14T12:00:00.000Z'),
    directory,
    maxBytes: 360,
    platform: 'win32'
  });

  for (let index = 0; index < 8; index += 1) {
    assert.equal(diagnostics.record('load-failed', {
      attempt: index,
      description: `Cannot open https://example.test/private/${index}`
    }), true);
  }

  assert.equal(fs.existsSync(diagnostics.paths.current), true);
  assert.equal(fs.existsSync(diagnostics.paths.previous), true);
  for (const filePath of Object.values(diagnostics.paths)) {
    const text = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(text, /example\.test/u);
    for (const line of text.trim().split('\n')) {
      const entry = JSON.parse(line);
      assert.equal(entry.version, '1.9.6');
      assert.equal(entry.platform, 'win32');
      assert.equal(entry.timestamp, '2026-08-14T12:00:00.000Z');
    }
  }

  assert.equal(diagnostics.clear(), true);
  assert.equal(fs.existsSync(diagnostics.paths.current), false);
  assert.equal(fs.existsSync(diagnostics.paths.previous), false);
});
