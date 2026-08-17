'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const builderConfig = require('../electron-builder.config.cjs');
const packageJson = require('../package.json');
const {
  PILOT_UPDATE_BASE_URL,
  PILOT_UPDATE_ED25519_PUBLIC_KEY,
  PILOT_UPDATE_KEY_ID,
  getPilotUpdateConfiguration
} = require('../src/main/pilot-update-config');

test('community export embeds no remote update authority', () => {
  assert.equal(PILOT_UPDATE_BASE_URL, null);
  assert.equal(PILOT_UPDATE_ED25519_PUBLIC_KEY, null);
  assert.equal(PILOT_UPDATE_KEY_ID, null);
  assert.equal(getPilotUpdateConfiguration(), null);
});

test('community packaging disables publication and remote-update channels', () => {
  assert.equal(builderConfig.publish, null);
  assert.equal(builderConfig.extraMetadata.blockifyReleaseChannel, 'community');
  assert.equal(builderConfig.forceCodeSigning, false);
});

test('community export is source-available for noncommercial use only', () => {
  const license = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8');
  assert.equal(packageJson.license, 'PolyForm-Noncommercial-1.0.0');
  assert.match(license, /PolyForm Noncommercial License 1\.0\.0/);
  assert.match(license, /Any noncommercial purpose is a permitted purpose\./);
  assert.doesNotMatch(license, /GNU GENERAL PUBLIC LICENSE/);
});

test('community export keeps private operational material out of tracked files', () => {
  const root = path.join(__dirname, '..');
  const tracked = listSourceFiles(root);
  const prohibitedPath = /^(?:deployment|vendor|private|artifacts)\//;
  const prohibitedText = /(?:\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-f0-9]{1,4}:[a-f0-9:]{2,}\b|[A-Za-z]:\\(?:Users|OneDrive|Dropbox|secure))/i;

  for (const relativePath of tracked) {
    assert.doesNotMatch(relativePath, prohibitedPath, relativePath);
    if (relativePath.startsWith('test/')) {
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    const content = fs.readFileSync(absolutePath, 'utf8');
    assert.doesNotMatch(content, prohibitedText, relativePath);
  }
});

function listSourceFiles(root) {
  const excludedDirectories = new Set([
    '.git',
    '.tools',
    'artifacts',
    'coverage',
    'dist',
    'node_modules',
    'release'
  ]);
  const files = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, '/');
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name) && !entry.name.startsWith('release-')) {
          visit(absolutePath);
        }
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  visit(root);
  return files;
}
