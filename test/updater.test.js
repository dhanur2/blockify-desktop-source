'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  UPDATE_STATUS,
  createDialogUpdateHooks,
  createUpdateRuntime,
  normalizedWindowsProductVersion,
  readWindowsInstallerProductVersion,
  safeUpdateInfo,
  sanitizeErrorCode,
  sanitizeVersion,
  verifyWindowsInstallerVersion
} = require('../src/main/updater');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.quitCalls = [];
    this.checkResult = Promise.resolve(null);
    this.downloadResult = Promise.resolve([]);
    this.quitResult = undefined;
  }

  checkForUpdates() {
    this.checkCalls += 1;
    return this.checkResult;
  }

  downloadUpdate() {
    this.downloadCalls += 1;
    return this.downloadResult;
  }

  quitAndInstall(...args) {
    this.quitCalls.push(args);
    if (this.quitEventError) {
      this.emit('error', this.quitEventError);
      return undefined;
    }
    if (this.quitError) {
      throw this.quitError;
    }
    return this.quitResult;
  }
}

class FakeTimers {
  constructor() {
    this.tasks = [];
  }

  setTimeout = (callback, delay) => {
    const handle = {
      callback,
      cancelled: false,
      delay,
      unref() {}
    };
    this.tasks.push(handle);
    return handle;
  };

  clearTimeout = (handle) => {
    if (handle) {
      handle.cancelled = true;
    }
  };

  pending() {
    return this.tasks.filter((task) => !task.cancelled);
  }

  runNext() {
    const index = this.tasks.findIndex((task) => !task.cancelled);
    assert.notEqual(index, -1, 'expected a pending timer');
    const [task] = this.tasks.splice(index, 1);
    task.cancelled = true;
    task.callback();
    return task.delay;
  }
}

function makeRuntime(overrides = {}) {
  const autoUpdater = overrides.autoUpdater || new FakeUpdater();
  const timers = overrides.timers || new FakeTimers();
  const runtime = createUpdateRuntime({
    autoCheck: true,
    autoUpdater,
    checkIntervalMs: 6 * 60 * 60 * 1_000,
    checkTimeoutMs: 120_000,
    clock: () => new Date('2026-08-15T00:00:00.000Z'),
    deferredIntervalMs: 24 * 60 * 60 * 1_000,
    downloadTimeoutMs: 1_800_000,
    enabled: true,
    initialDelayMs: 30_000,
    initialJitterMs: 30_000,
    random: () => 0.5,
    retryDelayMs: 900_000,
    timers,
    ...overrides
  });
  return { autoUpdater, runtime, timers };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('sanitizes all updater-controlled metadata before it reaches state, UX, or logs', () => {
  assert.equal(sanitizeVersion('2.0.1-beta.3'), '2.0.1-beta.3');
  assert.equal(sanitizeVersion('https://updates.example/private?token=secret'), 'unknown');
  assert.deepEqual(
    safeUpdateInfo({
      files: [{ url: 'https://updates.example/private' }],
      releaseNotes: '<script>unsafe</script>',
      version: '2.0.1'
    }),
    { version: '2.0.1' }
  );
  assert.equal(sanitizeErrorCode({ code: 'ERR_HTTP_503' }), 'ERR_HTTP_503');
  assert.equal(
    sanitizeErrorCode({
      code: 'https://updates.example/?token=secret',
      name: 'NetworkError'
    }),
    'NETWORKERROR'
  );
});

test('verifies the signed installer ProductVersion against the offered stable version', async () => {
  assert.equal(normalizedWindowsProductVersion('1.9.6.0'), '1.9.6');
  assert.equal(normalizedWindowsProductVersion('01.009.0006'), '1.9.6');
  assert.equal(normalizedWindowsProductVersion('1.9.6-beta.1'), null);
  assert.equal(await verifyWindowsInstallerVersion({
    expectedVersion: '2.0.0',
    filePath: 'C:\\updates\\Blockify.exe',
    readProductVersion: async () => '2.0.0.0'
  }), null);
  assert.match(await verifyWindowsInstallerVersion({
    expectedVersion: '2.0.0',
    filePath: 'C:\\updates\\Blockify.exe',
    readProductVersion: async () => '1.9.6'
  }), /does not match offered version 2\.0\.0/);
  assert.match(await verifyWindowsInstallerVersion({
    expectedVersion: '2.0.0-beta.1',
    filePath: 'C:\\updates\\Blockify.exe',
    readProductVersion: async () => '2.0.0'
  }), /not a stable Windows product version/);
});

test('reads installer version with fixed PowerShell invocation and no shell interpolation', async () => {
  let invocation;
  const version = await readWindowsInstallerProductVersion(
    'C:\\Update Cache\\Blockify 2.0.0.exe',
    {
      environment: {
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--require=unsafe',
        SystemRoot: 'C:\\Windows'
      },
      execFile: (executable, args, options, callback) => {
        invocation = { executable, args, options };
        callback(null, '2.0.0.0', '');
      }
    }
  );
  assert.equal(version, '2.0.0.0');
  assert.equal(
    invocation.executable,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  );
  assert.deepEqual(invocation.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-NonInteractive']);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.BLOCKIFY_UPDATE_INSTALLER_PATH, 'C:\\Update Cache\\Blockify 2.0.0.exe');
  assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
  assert.equal(invocation.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(invocation.options.shell, undefined);
  await assert.rejects(
    readWindowsInstallerProductVersion('relative.exe', {
      environment: { SystemRoot: 'C:\\Windows' },
      execFile: () => assert.fail('must not execute')
    }),
    { code: 'ERR_UPDATER_VERSION_PATH' }
  );
});

test('is fail-closed when production enablement is omitted', async () => {
  const runtime = createUpdateRuntime();
  assert.equal(runtime.start().status, UPDATE_STATUS.DISABLED);
  assert.deepEqual(await runtime.checkNow(), {
    started: false,
    reason: 'disabled',
    state: runtime.getState()
  });
});

test('starts idempotently with secure updater defaults and a jittered startup check', () => {
  const { autoUpdater, runtime, timers } = makeRuntime();
  const first = runtime.start();
  const second = runtime.start();

  assert.strictEqual(first, second);
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(autoUpdater.allowDowngrade, false);
  assert.equal(autoUpdater.allowPrerelease, false);
  assert.equal(autoUpdater.disableWebInstaller, true);
  assert.equal(autoUpdater.logger, null);
  assert.equal(autoUpdater.listenerCount('update-available'), 1);
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].delay, 45_000);
  assert.equal(runtime.getState().nextCheckAt, '2026-08-15T00:00:45.000Z');

  runtime.stop();
});

test('deduplicates checks and reports a manual up-to-date result', async () => {
  const notifications = [];
  const { autoUpdater, runtime, timers } = makeRuntime({
    hooks: {
      onNoUpdate: (payload) => notifications.push(payload)
    }
  });
  runtime.start();

  const first = await runtime.checkNow();
  const duplicate = await runtime.checkNow();
  assert.equal(first.started, true);
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.reason, 'busy');
  assert.equal(autoUpdater.checkCalls, 1);
  assert.equal(runtime.getState().status, UPDATE_STATUS.CHECKING);

  autoUpdater.emit('update-not-available', { version: '1.9.6' });
  await settle();
  assert.equal(runtime.getState().status, UPDATE_STATUS.IDLE);
  assert.equal(runtime.getState().lastCheckedAt, '2026-08-15T00:00:00.000Z');
  assert.deepEqual(notifications, [{ manual: true }]);
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].delay, 6 * 60 * 60 * 1_000);

  runtime.stop();
});

test('downloads and restarts only after two explicit user decisions', async () => {
  const prompts = [];
  const states = [];
  const { autoUpdater, runtime } = makeRuntime({
    hooks: {
      onStateChange: (state) => states.push(state),
      onUpdateAvailable: ({ update }) => {
        prompts.push(`download:${update.version}`);
        return 'download';
      },
      onUpdateDownloaded: ({ update }) => {
        prompts.push(`restart:${update.version}`);
        return 'restart';
      }
    }
  });
  runtime.start();

  await runtime.checkNow();
  autoUpdater.emit('update-available', {
    files: [{ url: 'https://private.example/update.exe?token=secret' }],
    version: '2.0.0'
  });
  await settle();
  assert.equal(autoUpdater.downloadCalls, 1);
  assert.equal(runtime.getState().status, UPDATE_STATUS.DOWNLOADING);

  autoUpdater.emit('download-progress', { percent: 48.88, transferred: 100, total: 200 });
  assert.equal(runtime.getState().downloadPercent, 48.9);
  autoUpdater.emit('download-progress', { percent: 200 });
  assert.equal(runtime.getState().downloadPercent, 100);

  autoUpdater.emit('update-downloaded', {
    downloadedFile: 'C:\\private\\update.exe',
    version: '2.0.0'
  });
  await settle();
  assert.deepEqual(prompts, ['download:2.0.0', 'restart:2.0.0']);
  assert.deepEqual(autoUpdater.quitCalls, [[true, true]]);
  assert.equal(runtime.getState().status, UPDATE_STATUS.INSTALLING);
  assert.ok(states.some((state) => state.status === UPDATE_STATUS.DOWNLOADED));

  runtime.stop();
});

test('runs installer version verification only after the built-in Authenticode verifier', async () => {
  const calls = [];
  const updater = new FakeUpdater();
  const originalVerifier = async (publisherNames, filePath) => {
    calls.push({ step: 'signature', publisherNames, filePath });
    return null;
  };
  updater.verifyUpdateCodeSignature = originalVerifier;
  const { runtime } = makeRuntime({
    autoUpdater: updater,
    hooks: { onUpdateAvailable: () => 'download' },
    verifyDownloadedInstaller: async (context) => {
      calls.push({ step: 'version', ...context });
      return null;
    }
  });
  runtime.start();
  await runtime.checkNow();
  updater.emit('update-available', { version: '2.0.0' });
  await settle();

  const result = await updater.verifyUpdateCodeSignature(
    ['CN=Publisher, O=Publisher Ltd., C=US'],
    'C:\\updates\\Blockify-2.0.0.exe'
  );
  assert.equal(result, null);
  assert.deepEqual(calls.map(({ step }) => step), ['signature', 'version']);
  assert.equal(calls[1].expectedVersion, '2.0.0');
  assert.equal(calls[1].filePath, 'C:\\updates\\Blockify-2.0.0.exe');

  runtime.stop();
  assert.strictEqual(updater.verifyUpdateCodeSignature, originalVerifier);
});

test('never runs ProductVersion verification when Authenticode fails', async () => {
  let versionChecks = 0;
  const updater = new FakeUpdater();
  updater.verifyUpdateCodeSignature = async () => 'wrong publisher';
  const { runtime } = makeRuntime({
    autoUpdater: updater,
    hooks: { onUpdateAvailable: () => 'download' },
    verifyDownloadedInstaller: async () => {
      versionChecks += 1;
      return null;
    }
  });
  runtime.start();
  await runtime.checkNow();
  updater.emit('update-available', { version: '2.0.0' });
  await settle();

  assert.equal(
    await updater.verifyUpdateCodeSignature([], 'C:\\updates\\Blockify-2.0.0.exe'),
    'wrong publisher'
  );
  assert.equal(versionChecks, 0);
  runtime.stop();
});

test('deferring a download is sticky for background checks but manual checks can revisit it', async () => {
  let promptCount = 0;
  const { autoUpdater, runtime } = makeRuntime({
    hooks: {
      onUpdateAvailable: () => {
        promptCount += 1;
        return 'later';
      }
    }
  });
  runtime.start();

  await runtime.checkInBackground();
  autoUpdater.emit('update-available', { version: '2.1.0' });
  await settle();
  assert.equal(promptCount, 1);
  assert.equal(autoUpdater.downloadCalls, 0);
  assert.equal(runtime.getState().status, UPDATE_STATUS.IDLE);

  await runtime.checkInBackground();
  autoUpdater.emit('update-available', { version: '2.1.0' });
  await settle();
  assert.equal(promptCount, 1, 'the same deferred version must not nag in the background');

  await runtime.checkNow();
  autoUpdater.emit('update-available', { version: '2.1.0' });
  await settle();
  assert.equal(promptCount, 2, 'a manual Help-menu check must revisit the choice');
  assert.equal(autoUpdater.downloadCalls, 0);

  runtime.stop();
});

test('Later after download leaves the ready update visible and manually revisitable', async () => {
  let restartPrompts = 0;
  const { autoUpdater, runtime } = makeRuntime({
    hooks: {
      onUpdateAvailable: () => 'download',
      onUpdateDownloaded: () => {
        restartPrompts += 1;
        return 'later';
      }
    }
  });
  runtime.start();

  await runtime.checkNow();
  autoUpdater.emit('update-available', { version: '2.2.0' });
  await settle();
  autoUpdater.emit('update-downloaded', { version: '2.2.0' });
  await settle();
  assert.equal(runtime.getState().status, UPDATE_STATUS.DOWNLOADED);
  assert.equal(runtime.getState().availableVersion, '2.2.0');
  assert.equal(autoUpdater.quitCalls.length, 0);

  const revisit = await runtime.checkNow();
  await settle();
  assert.equal(revisit.reason, 'restart-deferred');
  assert.equal(restartPrompts, 2);
  assert.equal(runtime.getState().status, UPDATE_STATUS.DOWNLOADED);

  runtime.stop();
});

test('deduplicates event and Promise failures and never records an error URL or message', async () => {
  const records = [];
  const surfacedErrors = [];
  const updater = new FakeUpdater();
  let rejectCheck;
  updater.checkResult = new Promise((_resolve, reject) => {
    rejectCheck = reject;
  });
  const { runtime } = makeRuntime({
    autoUpdater: updater,
    diagnostics: {
      record: (event, details) => records.push({ event, details })
    },
    hooks: {
      onError: (payload) => surfacedErrors.push(payload)
    }
  });
  runtime.start();

  await runtime.checkNow();
  const error = Object.assign(
    new Error('request failed at https://updates.example/private?token=secret'),
    { code: 'ERR_NETWORK' }
  );
  updater.emit('error', error);
  rejectCheck(error);
  await settle();

  const errorRecords = records.filter(({ event }) => event === 'update-error');
  assert.equal(errorRecords.length, 1);
  assert.deepEqual(errorRecords[0].details, {
    code: 'ERR_NETWORK',
    manual: true,
    phase: 'check'
  });
  assert.doesNotMatch(JSON.stringify(records), /https?:|token|secret|request failed/iu);
  assert.deepEqual(surfacedErrors, [{ code: 'ERR_NETWORK', manual: true, phase: 'check' }]);

  runtime.stop();
});

test('times out a stuck check, schedules a retry, and keeps startup non-blocking', async () => {
  const updater = new FakeUpdater();
  updater.checkResult = new Promise(() => {});
  const { runtime, timers } = makeRuntime({ autoUpdater: updater });
  runtime.start();

  const result = await runtime.checkNow();
  assert.equal(result.started, true);
  assert.equal(timers.runNext(), 120_000);
  assert.equal(runtime.getState().status, UPDATE_STATUS.ERROR);
  assert.equal(runtime.getState().errorCode, 'CHECK_TIMEOUT');
  assert.equal(runtime.getState().nextCheckAt, '2026-08-15T00:15:00.000Z');
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].delay, 900_000);

  timers.runNext();
  assert.equal(updater.checkCalls, 2);
  assert.equal(runtime.getState().status, UPDATE_STATUS.CHECKING);

  runtime.stop();
});

test('ignores unsolicited or mismatched downloaded events without restart authority', async () => {
  const records = [];
  const { autoUpdater, runtime } = makeRuntime({
    diagnostics: {
      record: (event, details) => records.push({ event, details })
    },
    hooks: {
      onUpdateAvailable: () => 'download'
    }
  });
  runtime.start();

  autoUpdater.emit('update-downloaded', { version: '99.0.0' });
  assert.equal(autoUpdater.quitCalls.length, 0);
  assert.equal(runtime.getState().status, UPDATE_STATUS.IDLE);

  await runtime.checkNow();
  autoUpdater.emit('update-available', { version: '2.3.0' });
  await settle();
  autoUpdater.emit('update-downloaded', { version: '9.9.9' });
  await settle();
  assert.equal(autoUpdater.quitCalls.length, 0);
  assert.equal(runtime.getState().status, UPDATE_STATUS.DOWNLOADING);
  assert.ok(records.some(({ event, details }) => (
    event === 'update-event-ignored' && details.reason === 'version-mismatch'
  )));

  runtime.stop();
});

test('recovers to downloaded state if installation cannot be launched', async () => {
  const errors = [];
  const updater = new FakeUpdater();
  updater.quitError = Object.assign(new Error('cannot launch'), { code: 'ERR_LAUNCH' });
  const { runtime } = makeRuntime({
    autoUpdater: updater,
    hooks: {
      onError: (payload) => errors.push(payload),
      onUpdateAvailable: () => 'download',
      onUpdateDownloaded: () => 'later'
    }
  });
  runtime.start();

  await runtime.checkNow();
  updater.emit('update-available', { version: '2.4.0' });
  await settle();
  updater.emit('update-downloaded', { version: '2.4.0' });
  await settle();
  const result = runtime.restartAndInstall();
  await settle();

  assert.equal(result.started, true);
  assert.equal(runtime.getState().status, UPDATE_STATUS.DOWNLOADED);
  assert.equal(runtime.getState().errorCode, 'ERR_LAUNCH');
  assert.deepEqual(errors, [{ code: 'ERR_LAUNCH', manual: true, phase: 'install' }]);

  runtime.stop();
});

test('recovers when electron-updater reports an install launch error by event', async () => {
  const updater = new FakeUpdater();
  updater.quitEventError = Object.assign(new Error('cannot launch'), { code: 'ERR_LAUNCH_EVENT' });
  const { runtime } = makeRuntime({
    autoUpdater: updater,
    hooks: {
      onUpdateAvailable: () => 'download',
      onUpdateDownloaded: () => 'restart'
    }
  });
  runtime.start();

  await runtime.checkNow();
  updater.emit('update-available', { version: '2.4.1' });
  await settle();
  updater.emit('update-downloaded', { version: '2.4.1' });
  await settle();

  assert.equal(runtime.getState().status, UPDATE_STATUS.DOWNLOADED);
  assert.equal(runtime.getState().errorCode, 'ERR_LAUNCH_EVENT');
  assert.deepEqual(updater.quitCalls, [[true, true]]);

  runtime.stop();
});

test('stop removes listeners, cancels work, and makes stale events inert', async () => {
  const { autoUpdater, runtime, timers } = makeRuntime();
  runtime.start();
  await runtime.checkNow();
  const state = runtime.stop();

  assert.equal(state.status, UPDATE_STATUS.STOPPED);
  assert.equal(state.running, false);
  assert.equal(timers.pending().length, 0);
  assert.equal(autoUpdater.listenerCount('update-available'), 0);
  autoUpdater.emit('update-available', { version: '5.0.0' });
  assert.equal(runtime.getState().status, UPDATE_STATUS.STOPPED);
  assert.equal((await runtime.checkNow()).reason, 'not-running');
});

test('dialog hooks present safe manual/background UX and return explicit decisions', async () => {
  const calls = [];
  const responses = [0, 1, 0, 0];
  const parent = { isDestroyed: () => false };
  const hooks = createDialogUpdateHooks({
    appName: 'Blockify\nInjected',
    dialog: {
      showMessageBox: (...args) => {
        calls.push(args);
        return Promise.resolve({ response: responses.shift() });
      }
    },
    getParentWindow: () => parent
  });

  assert.equal(
    await hooks.onUpdateAvailable({ update: { version: '2.5.0' } }),
    'download'
  );
  assert.equal(
    await hooks.onUpdateDownloaded({ update: { version: '2.5.0' } }),
    'later'
  );
  await hooks.onNoUpdate({ manual: false });
  await hooks.onError({ code: 'ERR_NETWORK', manual: false, phase: 'check' });
  assert.equal(calls.length, 2, 'background no-update and error states stay silent');

  await hooks.onNoUpdate({ manual: true });
  await hooks.onError({
    code: 'https://updates.example/?token=secret',
    manual: true,
    phase: 'check'
  });
  await hooks.onError({ code: 'ERR_DOWNLOAD', manual: false, phase: 'download' });
  assert.equal(calls.length, 5, 'a consented download failure remains visible');
  assert.ok(calls.every(([actualParent]) => actualParent === parent));
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /https?:|token|secret/iu);
  assert.doesNotMatch(serialized, /Blockify\\nInjected/u);
});
