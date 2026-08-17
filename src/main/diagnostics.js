const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_DETAIL_FIELDS = 12;
const MAX_TEXT_LENGTH = 180;

function redactText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[url]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Z0-9._~+/=-]+/giu, '[credential]')
    .replace(/\b[A-Z]:\\[^\r\n"'<>]*/giu, '[path]')
    .replace(/\/(?:Users|home)\/[^\r\n"'<>]*/giu, '[path]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email]')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function normalizeEventName(value) {
  const normalized = String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
  return normalized || 'unknown';
}

function normalizeDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, MAX_DETAIL_FIELDS)) {
    const key = String(rawKey).replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 32);
    if (
      !key ||
      /token|secret|password|cookie|authorization|url|path|account|contentid/iu.test(key) ||
      rawValue === undefined ||
      rawValue === null
    ) {
      continue;
    }

    if (typeof rawValue === 'boolean' || typeof rawValue === 'number') {
      normalized[key] = rawValue;
    } else if (typeof rawValue === 'string') {
      normalized[key] = redactText(rawValue);
    }
  }
  return normalized;
}

function createLocalDiagnostics(options) {
  const {
    appVersion,
    directory,
    maxBytes = DEFAULT_MAX_BYTES,
    platform = process.platform,
    clock = () => new Date()
  } = options;
  const currentPath = path.join(directory, 'blockify.log');
  const previousPath = path.join(directory, 'blockify.previous.log');

  function ensureDirectory() {
    const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error('Diagnostics directory is not a regular directory.');
      }
      return;
    }
    fs.mkdirSync(directory, { recursive: true });
  }

  function rotateIfNeeded(nextLineBytes) {
    const current = fs.lstatSync(currentPath, { throwIfNoEntry: false });
    if (current && (!current.isFile() || current.isSymbolicLink())) {
      throw new Error('Diagnostics log is not a regular file.');
    }
    if (!current || current.size + nextLineBytes <= maxBytes) {
      return;
    }

    fs.rmSync(previousPath, { force: true });
    fs.renameSync(currentPath, previousPath);
  }

  function record(event, details = {}) {
    try {
      const entry = {
        timestamp: clock().toISOString(),
        event: normalizeEventName(event),
        version: redactText(appVersion),
        platform: redactText(platform),
        details: normalizeDetails(details)
      };
      const line = `${JSON.stringify(entry)}\n`;
      ensureDirectory();
      rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(currentPath, line, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      // Diagnostics must never interfere with startup, playback, or shutdown.
      return false;
    }
  }

  function clear() {
    let cleared = true;
    for (const filePath of [currentPath, previousPath]) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        cleared = false;
      }
    }
    return cleared;
  }

  function prepareDirectory() {
    try {
      ensureDirectory();
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    clear,
    directory,
    paths: Object.freeze({ current: currentPath, previous: previousPath }),
    prepareDirectory,
    record
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  MAX_DETAIL_FIELDS,
  MAX_TEXT_LENGTH,
  createLocalDiagnostics,
  normalizeDetails,
  normalizeEventName,
  redactText
};
