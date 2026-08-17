'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

const UPDATE_STATUS = Object.freeze({
  DISABLED: 'disabled',
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  INSTALLING: 'installing',
  ERROR: 'error',
  STOPPED: 'stopped'
});

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_INITIAL_JITTER_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_DEFERRED_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1_000;
const DEFAULT_CHECK_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;

const ALLOWED_TRANSITIONS = Object.freeze({
  [UPDATE_STATUS.DISABLED]: new Set([UPDATE_STATUS.DISABLED]),
  [UPDATE_STATUS.IDLE]: new Set([
    UPDATE_STATUS.IDLE,
    UPDATE_STATUS.CHECKING,
    UPDATE_STATUS.ERROR,
    UPDATE_STATUS.STOPPED
  ]),
  [UPDATE_STATUS.CHECKING]: new Set([
    UPDATE_STATUS.IDLE,
    UPDATE_STATUS.AVAILABLE,
    UPDATE_STATUS.ERROR,
    UPDATE_STATUS.STOPPED
  ]),
  [UPDATE_STATUS.AVAILABLE]: new Set([
    UPDATE_STATUS.IDLE,
    UPDATE_STATUS.DOWNLOADING,
    UPDATE_STATUS.ERROR,
    UPDATE_STATUS.STOPPED
  ]),
  [UPDATE_STATUS.DOWNLOADING]: new Set([
    UPDATE_STATUS.DOWNLOADING,
    UPDATE_STATUS.DOWNLOADED,
    UPDATE_STATUS.ERROR,
    UPDATE_STATUS.STOPPED
  ]),
  [UPDATE_STATUS.DOWNLOADED]: new Set([
    UPDATE_STATUS.DOWNLOADED,
    UPDATE_STATUS.INSTALLING,
    UPDATE_STATUS.STOPPED
  ]),
  [UPDATE_STATUS.INSTALLING]: new Set([
    UPDATE_STATUS.DOWNLOADED,
    UPDATE_STATUS.STOPPED
  ]),
  [UPDATE_STATUS.ERROR]: new Set([
    UPDATE_STATUS.ERROR,
    UPDATE_STATUS.IDLE,
    UPDATE_STATUS.CHECKING,
    UPDATE_STATUS.STOPPED
  ]),
  [UPDATE_STATUS.STOPPED]: new Set([UPDATE_STATUS.STOPPED])
});

function boundedDuration(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function sanitizeVersion(value) {
  const text = String(value || '').trim();
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(text) ? text : 'unknown';
}

function sanitizeErrorCode(errorOrCode) {
  const values = errorOrCode && typeof errorOrCode === 'object'
    ? [errorOrCode.code, errorOrCode.name]
    : [errorOrCode];
  for (const value of values) {
    const text = String(value || '').trim();
    if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(text)) {
      return text.toUpperCase();
    }
  }
  return 'UPDATE_ERROR';
}

function safeUpdateInfo(info) {
  return Object.freeze({ version: sanitizeVersion(info?.version) });
}

function normalizedWindowsProductVersion(value) {
  const text = String(value || '').trim();
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(text)) {
    return null;
  }
  const parts = text.split('.').map((part) => String(Number(part)));
  if (parts.length === 4 && parts[3] === '0') {
    parts.pop();
  }
  return parts.join('.');
}

function readWindowsInstallerProductVersion(filePath, options = {}) {
  const environment = options.environment || process.env;
  const run = options.execFile || execFile;
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  const normalizedSystemRoot = typeof systemRoot === 'string'
    ? path.win32.normalize(systemRoot)
    : '';
  const systemRootName = path.win32.basename(normalizedSystemRoot).toLowerCase();
  if (
    typeof filePath !== 'string' ||
    !path.win32.isAbsolute(filePath) ||
    typeof systemRoot !== 'string' ||
    !/^[a-z]:\\/iu.test(normalizedSystemRoot) ||
    path.win32.dirname(normalizedSystemRoot) !== path.win32.parse(normalizedSystemRoot).root ||
    !['windows', 'winnt'].includes(systemRootName)
  ) {
    return Promise.reject(Object.assign(new Error('Invalid Windows version-check path.'), {
      code: 'ERR_UPDATER_VERSION_PATH'
    }));
  }

  const powershell = path.win32.join(
    normalizedSystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$version = (Get-Item -LiteralPath $env:BLOCKIFY_UPDATE_INSTALLER_PATH).VersionInfo.ProductVersion',
    'if ([string]::IsNullOrWhiteSpace($version)) { exit 2 }',
    '[Console]::Out.Write($version)'
  ].join('\r\n');
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const childEnvironment = {
    ...environment,
    BLOCKIFY_UPDATE_INSTALLER_PATH: filePath,
    PSModulePath: ''
  };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  delete childEnvironment.NODE_OPTIONS;

  return new Promise((resolve, reject) => {
    run(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
      {
        encoding: 'utf8',
        env: childEnvironment,
        maxBuffer: 4096,
        timeout: 20_000,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(Object.assign(new Error('Windows installer version check failed.'), {
            code: 'ERR_UPDATER_VERSION_CHECK'
          }));
          return;
        }
        const version = String(stdout || '').trim();
        if (!normalizedWindowsProductVersion(version)) {
          reject(Object.assign(new Error('Windows installer version is invalid.'), {
            code: 'ERR_UPDATER_VERSION_INVALID'
          }));
          return;
        }
        resolve(version);
      }
    );
  });
}

async function verifyWindowsInstallerVersion(options = {}) {
  const expectedVersion = normalizedWindowsProductVersion(options.expectedVersion);
  if (!expectedVersion) {
    return 'The offered update version is not a stable Windows product version.';
  }
  try {
    const readProductVersion = options.readProductVersion || readWindowsInstallerProductVersion;
    const actualVersion = normalizedWindowsProductVersion(
      await readProductVersion(options.filePath)
    );
    if (!actualVersion || actualVersion !== expectedVersion) {
      return `Installer ProductVersion ${actualVersion || 'invalid'} does not match offered version ${expectedVersion}.`;
    }
    return null;
  } catch {
    return 'The installer ProductVersion could not be verified.';
  }
}

function normalizeDecision(value, affirmative) {
  return value === true || value === affirmative ? affirmative : 'later';
}

function createDialogUpdateHooks(options) {
  const {
    appName = 'Blockify',
    dialog,
    getParentWindow = () => null
  } = options || {};

  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    throw new TypeError('createDialogUpdateHooks requires Electron dialog.showMessageBox.');
  }

  const safeAppName = String(appName || 'Blockify').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 80) || 'Blockify';

  async function showMessageBox(messageOptions) {
    let parent = null;
    try {
      parent = getParentWindow();
    } catch {
      // A missing window must not prevent update consent from being requested.
    }

    if (parent && (typeof parent.isDestroyed !== 'function' || !parent.isDestroyed())) {
      return dialog.showMessageBox(parent, messageOptions);
    }
    return dialog.showMessageBox(messageOptions);
  }

  return Object.freeze({
    async onUpdateAvailable({ update }) {
      const version = sanitizeVersion(update?.version);
      const result = await showMessageBox({
        buttons: ['Download update', 'Later'],
        cancelId: 1,
        defaultId: 0,
        detail: 'The download runs in the background. Blockify will ask before restarting.',
        message: version === 'unknown'
          ? 'A Blockify update is available.'
          : `Blockify ${version} is available.`,
        noLink: true,
        title: safeAppName,
        type: 'info'
      });
      return result?.response === 0 ? 'download' : 'later';
    },

    async onUpdateDownloaded({ update }) {
      const version = sanitizeVersion(update?.version);
      const result = await showMessageBox({
        buttons: ['Restart and update', 'Later'],
        cancelId: 1,
        defaultId: 0,
        detail: 'Playback will stop briefly while Blockify closes, installs the update, and reopens.',
        message: version === 'unknown'
          ? 'The Blockify update is ready to install.'
          : `Blockify ${version} is ready to install.`,
        noLink: true,
        title: safeAppName,
        type: 'info'
      });
      return result?.response === 0 ? 'restart' : 'later';
    },

    async onNoUpdate({ manual }) {
      if (!manual) {
        return;
      }
      await showMessageBox({
        buttons: ['OK'],
        defaultId: 0,
        message: 'Blockify is up to date.',
        noLink: true,
        title: safeAppName,
        type: 'info'
      });
    },

    async onError({ code, manual, phase }) {
      // Routine scheduled-check failures stay silent. Download/install failures
      // follow an explicit user action and should remain visible.
      if (!manual && phase === 'check') {
        return;
      }
      await showMessageBox({
        buttons: ['OK'],
        defaultId: 0,
        detail: `${phase === 'check' ? 'Check your internet connection and try again.' : 'Try again from the Help menu.'} Error code: ${sanitizeErrorCode(code)}`,
        message: phase === 'check'
          ? 'Blockify could not check for updates.'
          : 'Blockify could not complete the update.',
        noLink: true,
        title: safeAppName,
        type: 'warning'
      });
    }
  });
}

function createUpdateRuntime(options) {
  const configuration = options || {};
  // Fail closed: the embedding process must explicitly establish that this is
  // a packaged, production-channel build before network update checks run.
  const enabled = configuration.enabled === true;
  const autoUpdater = configuration.autoUpdater;

  if (enabled) {
    const requiredMethods = [
      'on',
      'removeListener',
      'checkForUpdates',
      'downloadUpdate',
      'quitAndInstall'
    ];
    for (const method of requiredMethods) {
      if (!autoUpdater || typeof autoUpdater[method] !== 'function') {
        throw new TypeError(`createUpdateRuntime requires autoUpdater.${method}().`);
      }
    }
  }

  const hooks = configuration.hooks || {};
  const diagnostics = configuration.diagnostics;
  const verifyDownloadedInstaller = configuration.verifyDownloadedInstaller;
  const clock = typeof configuration.clock === 'function'
    ? configuration.clock
    : () => new Date();
  const random = typeof configuration.random === 'function'
    ? configuration.random
    : Math.random;
  const timers = configuration.timers || {
    clearTimeout,
    setTimeout
  };
  const autoCheck = configuration.autoCheck !== false;
  const initialDelayMs = boundedDuration(
    configuration.initialDelayMs,
    DEFAULT_INITIAL_DELAY_MS
  );
  const initialJitterMs = boundedDuration(
    configuration.initialJitterMs,
    DEFAULT_INITIAL_JITTER_MS
  );
  const checkIntervalMs = boundedDuration(
    configuration.checkIntervalMs,
    DEFAULT_CHECK_INTERVAL_MS
  );
  const deferredIntervalMs = boundedDuration(
    configuration.deferredIntervalMs,
    DEFAULT_DEFERRED_INTERVAL_MS
  );
  const retryDelayMs = boundedDuration(
    configuration.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS
  );
  const checkTimeoutMs = boundedDuration(
    configuration.checkTimeoutMs,
    DEFAULT_CHECK_TIMEOUT_MS
  );
  const downloadTimeoutMs = boundedDuration(
    configuration.downloadTimeoutMs,
    DEFAULT_DOWNLOAD_TIMEOUT_MS
  );

  let running = false;
  let stopped = false;
  let scheduledTimer = null;
  let operationTimer = null;
  let operationSequence = 0;
  let activeOperation = null;
  let deferredVersion = null;
  let downloadConsent = false;
  let restartPromptPending = false;
  let restartRequested = false;
  let originalCodeSignatureVerifier = null;
  let wrappedCodeSignatureVerifier = null;

  let state = Object.freeze({
    status: enabled ? UPDATE_STATUS.IDLE : UPDATE_STATUS.DISABLED,
    running: false,
    manual: false,
    availableVersion: null,
    downloadPercent: null,
    errorCode: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    sequence: 0
  });

  function nowIso() {
    try {
      const value = clock();
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    } catch {
      return null;
    }
  }

  function futureIso(delayMs) {
    try {
      const value = clock();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) {
        return null;
      }
      return new Date(date.getTime() + delayMs).toISOString();
    } catch {
      return null;
    }
  }

  function startupDelay() {
    let sample = 0;
    try {
      sample = Number(random());
    } catch {
      sample = 0;
    }
    const boundedSample = Number.isFinite(sample)
      ? Math.max(0, Math.min(0.999999999, sample))
      : 0;
    return initialDelayMs + Math.floor(boundedSample * initialJitterMs);
  }

  function record(event, details = {}) {
    try {
      diagnostics?.record?.(event, details);
    } catch {
      // Diagnostics must never break update checks or playback.
    }
  }

  function notifyStateChange() {
    if (typeof hooks.onStateChange !== 'function') {
      return;
    }
    try {
      const result = hooks.onStateChange(state);
      Promise.resolve(result).catch(() => {
        record('update-ux-hook-failed', { hook: 'state-change' });
      });
    } catch {
      record('update-ux-hook-failed', { hook: 'state-change' });
    }
  }

  function transition(status, patch = {}) {
    if (!ALLOWED_TRANSITIONS[state.status]?.has(status)) {
      record('update-transition-rejected', {
        from: state.status,
        to: status
      });
      return false;
    }

    state = Object.freeze({
      ...state,
      ...patch,
      status,
      running,
      sequence: state.sequence + 1
    });
    notifyStateChange();
    return true;
  }

  function clearScheduledTimer() {
    if (scheduledTimer !== null) {
      timers.clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
  }

  function clearOperationTimer() {
    if (operationTimer !== null) {
      timers.clearTimeout(operationTimer);
      operationTimer = null;
    }
  }

  function schedule(delayMs, source) {
    clearScheduledTimer();
    if (
      !running ||
      !autoCheck ||
      ![UPDATE_STATUS.IDLE, UPDATE_STATUS.ERROR].includes(state.status)
    ) {
      return;
    }

    const safeDelay = boundedDuration(delayMs, checkIntervalMs);
    const operationId = operationSequence;
    scheduledTimer = timers.setTimeout(() => {
      scheduledTimer = null;
      if (!running || operationId !== operationSequence) {
        return;
      }
      requestCheck(false, source);
    }, safeDelay);
    scheduledTimer?.unref?.();
    transition(state.status, { nextCheckAt: futureIso(safeDelay) });
  }

  function startOperationTimeout(kind, operationId, delayMs) {
    clearOperationTimer();
    operationTimer = timers.setTimeout(() => {
      operationTimer = null;
      if (!running || activeOperation?.id !== operationId || activeOperation.kind !== kind) {
        return;
      }
      handleFailure(
        { code: kind === 'check' ? 'CHECK_TIMEOUT' : 'DOWNLOAD_TIMEOUT' },
        kind,
        operationId
      );
    }, delayMs);
    operationTimer?.unref?.();
  }

  function safeInvokeHook(name, payload) {
    const hook = hooks[name];
    if (typeof hook !== 'function') {
      return Promise.resolve(undefined);
    }
    try {
      return Promise.resolve(hook(payload)).catch(() => {
        record('update-ux-hook-failed', { hook: name });
        return undefined;
      });
    } catch {
      record('update-ux-hook-failed', { hook: name });
      return Promise.resolve(undefined);
    }
  }

  function ignoreEvent(event, reason = 'unexpected-state') {
    record('update-event-ignored', {
      event,
      reason,
      status: state.status
    });
  }

  function handleFailure(error, phase, operationId = activeOperation?.id) {
    if (!running || !activeOperation || activeOperation.id !== operationId) {
      return;
    }
    if (
      (phase === 'check' && state.status !== UPDATE_STATUS.CHECKING) ||
      (phase === 'download' && state.status !== UPDATE_STATUS.DOWNLOADING)
    ) {
      return;
    }

    const manual = activeOperation.manual;
    const code = sanitizeErrorCode(error);
    clearOperationTimer();
    activeOperation = null;
    downloadConsent = false;
    transition(UPDATE_STATUS.ERROR, {
      downloadPercent: null,
      errorCode: code,
      lastCheckedAt: phase === 'check' ? nowIso() : state.lastCheckedAt,
      manual,
      nextCheckAt: null
    });
    record('update-error', { code, manual, phase });
    void safeInvokeHook('onError', { code, manual, phase });
    schedule(retryDelayMs, 'retry');
  }

  function beginDownload(update, manual) {
    if (!running || state.status !== UPDATE_STATUS.AVAILABLE || downloadConsent) {
      return { started: false, reason: 'not-available', state };
    }

    downloadConsent = true;
    const operationId = ++operationSequence;
    activeOperation = {
      id: operationId,
      kind: 'download',
      manual,
      update
    };
    transition(UPDATE_STATUS.DOWNLOADING, {
      availableVersion: update.version,
      downloadPercent: 0,
      errorCode: null,
      manual,
      nextCheckAt: null
    });
    record('update-download-started', { manual, version: update.version });
    startOperationTimeout('download', operationId, downloadTimeoutMs);

    try {
      const result = autoUpdater.downloadUpdate();
      Promise.resolve(result).catch((error) => {
        handleFailure(error, 'download', operationId);
      });
    } catch (error) {
      handleFailure(error, 'download', operationId);
    }

    return { started: true, reason: 'download-started', state };
  }

  function promptForAvailable(update, manual, checkId) {
    void safeInvokeHook('onUpdateAvailable', { manual, update }).then((decision) => {
      if (
        !running ||
        state.status !== UPDATE_STATUS.AVAILABLE ||
        state.availableVersion !== update.version ||
        operationSequence !== checkId
      ) {
        return;
      }

      if (normalizeDecision(decision, 'download') === 'download') {
        beginDownload(update, manual);
        return;
      }

      deferredVersion = update.version;
      transition(UPDATE_STATUS.IDLE, {
        availableVersion: null,
        downloadPercent: null,
        errorCode: null,
        manual: false,
        nextCheckAt: null
      });
      record('update-deferred', { manual, version: update.version });
      schedule(deferredIntervalMs, 'deferred');
    });
  }

  function promptForRestart(update, manual) {
    if (!running || state.status !== UPDATE_STATUS.DOWNLOADED || restartPromptPending) {
      return Promise.resolve({ started: false, reason: 'not-ready', state });
    }
    restartPromptPending = true;
    return safeInvokeHook('onUpdateDownloaded', { manual, update }).then((decision) => {
      restartPromptPending = false;
      if (!running || state.status !== UPDATE_STATUS.DOWNLOADED) {
        return { started: false, reason: 'state-changed', state };
      }
      if (normalizeDecision(decision, 'restart') === 'restart') {
        return restartAndInstall();
      }
      record('update-restart-deferred', { manual, version: update.version });
      return { started: false, reason: 'restart-deferred', state };
    });
  }

  function requestCheck(manual, source) {
    if (!enabled) {
      return Promise.resolve({ started: false, reason: 'disabled', state });
    }
    if (!running) {
      return Promise.resolve({ started: false, reason: 'not-running', state });
    }
    if (state.status === UPDATE_STATUS.DOWNLOADED) {
      return promptForRestart(
        Object.freeze({ version: state.availableVersion || 'unknown' }),
        manual
      );
    }
    if (![UPDATE_STATUS.IDLE, UPDATE_STATUS.ERROR].includes(state.status)) {
      return Promise.resolve({ started: false, reason: 'busy', state });
    }

    clearScheduledTimer();
    const operationId = ++operationSequence;
    activeOperation = {
      id: operationId,
      kind: 'check',
      manual: Boolean(manual),
      source
    };
    transition(UPDATE_STATUS.CHECKING, {
      availableVersion: null,
      downloadPercent: null,
      errorCode: null,
      manual: Boolean(manual),
      nextCheckAt: null
    });
    record('update-check-started', {
      manual: Boolean(manual),
      source
    });
    startOperationTimeout('check', operationId, checkTimeoutMs);

    try {
      const result = autoUpdater.checkForUpdates();
      Promise.resolve(result).catch((error) => {
        handleFailure(error, 'check', operationId);
      });
    } catch (error) {
      handleFailure(error, 'check', operationId);
    }

    return Promise.resolve({ started: true, reason: 'check-started', state });
  }

  function onCheckingForUpdate() {
    if (!running || state.status !== UPDATE_STATUS.CHECKING) {
      ignoreEvent('checking-for-update');
    }
  }

  function onUpdateAvailable(info) {
    if (
      !running ||
      state.status !== UPDATE_STATUS.CHECKING ||
      activeOperation?.kind !== 'check'
    ) {
      ignoreEvent('update-available');
      return;
    }

    const update = safeUpdateInfo(info);
    const manual = activeOperation.manual;
    const checkId = activeOperation.id;
    clearOperationTimer();
    activeOperation = null;
    transition(UPDATE_STATUS.AVAILABLE, {
      availableVersion: update.version,
      downloadPercent: null,
      errorCode: null,
      lastCheckedAt: nowIso(),
      manual,
      nextCheckAt: null
    });
    record('update-available', { manual, version: update.version });

    if (!manual && deferredVersion === update.version) {
      transition(UPDATE_STATUS.IDLE, {
        availableVersion: null,
        manual: false
      });
      schedule(deferredIntervalMs, 'deferred');
      return;
    }
    if (deferredVersion !== update.version) {
      deferredVersion = null;
    }
    promptForAvailable(update, manual, checkId);
  }

  function onUpdateNotAvailable() {
    if (
      !running ||
      state.status !== UPDATE_STATUS.CHECKING ||
      activeOperation?.kind !== 'check'
    ) {
      ignoreEvent('update-not-available');
      return;
    }

    const manual = activeOperation.manual;
    clearOperationTimer();
    activeOperation = null;
    deferredVersion = null;
    transition(UPDATE_STATUS.IDLE, {
      availableVersion: null,
      downloadPercent: null,
      errorCode: null,
      lastCheckedAt: nowIso(),
      manual: false,
      nextCheckAt: null
    });
    record('update-not-available', { manual });
    void safeInvokeHook('onNoUpdate', { manual });
    schedule(checkIntervalMs, 'scheduled');
  }

  function onDownloadProgress(progress) {
    if (
      !running ||
      state.status !== UPDATE_STATUS.DOWNLOADING ||
      activeOperation?.kind !== 'download' ||
      !downloadConsent
    ) {
      ignoreEvent('download-progress');
      return;
    }

    const rawPercent = Number(progress?.percent);
    if (!Number.isFinite(rawPercent)) {
      return;
    }
    const downloadPercent = Math.max(0, Math.min(100, Math.round(rawPercent * 10) / 10));
    transition(UPDATE_STATUS.DOWNLOADING, { downloadPercent });
  }

  function onUpdateDownloaded(info) {
    if (
      !running ||
      state.status !== UPDATE_STATUS.DOWNLOADING ||
      activeOperation?.kind !== 'download' ||
      !downloadConsent
    ) {
      ignoreEvent('update-downloaded');
      return;
    }

    const expectedUpdate = activeOperation.update;
    const downloadedUpdate = safeUpdateInfo(info);
    if (
      expectedUpdate.version !== 'unknown' &&
      downloadedUpdate.version !== 'unknown' &&
      expectedUpdate.version !== downloadedUpdate.version
    ) {
      ignoreEvent('update-downloaded', 'version-mismatch');
      return;
    }

    const update = Object.freeze({
      version: expectedUpdate.version === 'unknown'
        ? downloadedUpdate.version
        : expectedUpdate.version
    });
    const manual = activeOperation.manual;
    clearOperationTimer();
    activeOperation = null;
    downloadConsent = false;
    transition(UPDATE_STATUS.DOWNLOADED, {
      availableVersion: update.version,
      downloadPercent: 100,
      errorCode: null,
      manual,
      nextCheckAt: null
    });
    record('update-downloaded', { manual, version: update.version });
    void promptForRestart(update, manual);
  }

  function onError(error) {
    if (running && restartRequested && state.status === UPDATE_STATUS.INSTALLING) {
      handleInstallFailure(error);
      return;
    }
    if (!running || !activeOperation) {
      ignoreEvent('error');
      return;
    }
    handleFailure(error, activeOperation.kind, activeOperation.id);
  }

  const listeners = Object.freeze({
    'checking-for-update': onCheckingForUpdate,
    'update-available': onUpdateAvailable,
    'update-not-available': onUpdateNotAvailable,
    'download-progress': onDownloadProgress,
    'update-downloaded': onUpdateDownloaded,
    error: onError
  });

  function start() {
    if (!enabled || running || stopped) {
      return state;
    }

    // electron-updater defaults to downloading immediately. Keep both actions
    // explicitly consent-driven, and rely on its signature/checksum validation.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    // electron-updater defaults to console logging, which can include feed or
    // artifact URLs. Runtime diagnostics below contain only bounded metadata.
    autoUpdater.logger = null;
    if (typeof verifyDownloadedInstaller === 'function') {
      originalCodeSignatureVerifier = autoUpdater.verifyUpdateCodeSignature;
      if (typeof originalCodeSignatureVerifier !== 'function') {
        throw new TypeError('The Windows updater has no Authenticode verifier to harden.');
      }
      wrappedCodeSignatureVerifier = async (publisherNames, filePath) => {
        const signatureError = await originalCodeSignatureVerifier(publisherNames, filePath);
        if (signatureError !== null) {
          return signatureError || 'The installer Authenticode signature was not confirmed.';
        }
        const expectedVersion = activeOperation?.kind === 'download'
          ? activeOperation.update?.version
          : null;
        if (!expectedVersion || expectedVersion === 'unknown') {
          return 'The offered update version context is unavailable.';
        }
        try {
          const versionError = await verifyDownloadedInstaller({
            expectedVersion,
            filePath
          });
          return versionError === null
            ? null
            : String(versionError || 'The installer ProductVersion was not confirmed.').slice(0, 240);
        } catch {
          return 'The installer ProductVersion could not be verified.';
        }
      };
      autoUpdater.verifyUpdateCodeSignature = wrappedCodeSignatureVerifier;
    }
    for (const [event, listener] of Object.entries(listeners)) {
      autoUpdater.on(event, listener);
    }

    running = true;
    transition(UPDATE_STATUS.IDLE, {
      errorCode: null,
      manual: false,
      nextCheckAt: null
    });
    record('update-runtime-started', {
      autoCheck,
      installOnQuit: false
    });
    if (autoCheck) {
      schedule(startupDelay(), 'startup');
    }
    return state;
  }

  function stop() {
    if (!enabled || stopped) {
      return state;
    }
    clearScheduledTimer();
    clearOperationTimer();
    if (running) {
      for (const [event, listener] of Object.entries(listeners)) {
        autoUpdater.removeListener(event, listener);
      }
    }
    if (
      originalCodeSignatureVerifier &&
      autoUpdater.verifyUpdateCodeSignature === wrappedCodeSignatureVerifier
    ) {
      autoUpdater.verifyUpdateCodeSignature = originalCodeSignatureVerifier;
    }
    running = false;
    stopped = true;
    activeOperation = null;
    downloadConsent = false;
    restartPromptPending = false;
    transition(UPDATE_STATUS.STOPPED, {
      manual: false,
      nextCheckAt: null
    });
    record('update-runtime-stopped');
    return state;
  }

  function restartAndInstall() {
    if (!running || state.status !== UPDATE_STATUS.DOWNLOADED || restartRequested) {
      return { started: false, reason: 'not-ready', state };
    }
    restartRequested = true;
    transition(UPDATE_STATUS.INSTALLING, {
      errorCode: null,
      nextCheckAt: null
    });
    record('update-restart-requested', {
      version: state.availableVersion || 'unknown'
    });

    try {
      const result = autoUpdater.quitAndInstall(true, true);
      Promise.resolve(result).catch(handleInstallFailure);
    } catch (error) {
      handleInstallFailure(error);
    }
    return { started: true, reason: 'restart-requested', state };
  }

  function handleInstallFailure(error) {
    if (!restartRequested || state.status !== UPDATE_STATUS.INSTALLING) {
      return;
    }
    restartRequested = false;
    const code = sanitizeErrorCode(error);
    transition(UPDATE_STATUS.DOWNLOADED, { errorCode: code });
    record('update-error', { code, manual: true, phase: 'install' });
    void safeInvokeHook('onError', { code, manual: true, phase: 'install' });
  }

  return Object.freeze({
    checkInBackground: () => requestCheck(false, 'background'),
    checkNow: () => requestCheck(true, 'manual'),
    downloadUpdate: () => beginDownload(
      Object.freeze({ version: state.availableVersion || 'unknown' }),
      true
    ),
    getState: () => state,
    restartAndInstall,
    start,
    stop
  });
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_DEFERRED_INTERVAL_MS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_INITIAL_JITTER_MS,
  DEFAULT_RETRY_DELAY_MS,
  UPDATE_STATUS,
  createDialogUpdateHooks,
  createUpdateRuntime,
  normalizedWindowsProductVersion,
  readWindowsInstallerProductVersion,
  safeUpdateInfo,
  sanitizeErrorCode,
  sanitizeVersion,
  verifyWindowsInstallerVersion
};
