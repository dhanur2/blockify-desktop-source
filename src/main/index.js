const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BaseWindow,
  BrowserWindow,
  components,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  session,
  shell
} = require('electron');
const { installSpotifyBlocker } = require('./blocker');
const { createLocalDiagnostics } = require('./diagnostics');
const { createLocalProtocolHandler } = require('./local-protocol');
const {
  UPDATE_STATUS,
  createDialogUpdateHooks,
  createUpdateRuntime,
  verifyWindowsInstallerVersion
} = require('./updater');
const {
  PILOT_UPDATE_PROTOCOL,
  getPilotUpdateConfiguration
} = require('./pilot-update-config');
const {
  isProtectedPlaybackRetryUrl,
  isSpotifyPlayerUrl,
  parseUrl
} = require('./navigation');
const {
  findDisallowedRuntimeArgument,
  isAllowedNavigationForContents,
  isAllowedPopupForContents,
  isAllowedProtectedMediaPermission,
  isTrustedSpotifyIpcSender
} = require('./security-policy');

const APP_NAME = 'Blockify';
const SPOTIFY_URL = 'https://open.spotify.com/';
const SPOTIFY_SUPPORT_URL = 'https://support.spotify.com/';
const LOADING_URL = 'blockify://app/loading';
const SESSION_PARTITION = 'persist:blockify-spotify';
const NOOP_MEDIA_URL = 'blockify-media://media/noop-1s.wav';
const SMOKE_FIXTURE_URL = 'blockify-media://test/state-fixture';
const COMPONENT_TIMEOUT_MS = 60_000;
const SMOKE_TIMEOUT_MS = 120_000;
const SMOKE_TEST_AUTHORIZED = process.env.BLOCKIFY_ENABLE_SMOKE_TEST === '1';
const IS_DEVELOPMENT = !app.isPackaged && process.argv.includes('--dev');
const IS_SMOKE_TEST = SMOKE_TEST_AUTHORIZED && process.argv.includes('--smoke-test');
const PACKAGED_METADATA = require('../../package.json');
const RELEASE_CHANNEL = PACKAGED_METADATA.blockifyReleaseChannel;
const PILOT_UPDATE_CONFIGURATION = getPilotUpdateConfiguration();
const PRODUCTION_UPDATES_ENABLED = (
  app.isPackaged &&
  RELEASE_CHANNEL === 'production' &&
  !IS_SMOKE_TEST
);
const PILOT_UPDATES_ENABLED = (
  app.isPackaged &&
  RELEASE_CHANNEL === 'pilot' &&
  PACKAGED_METADATA.blockifyUpdateProtocol === PILOT_UPDATE_PROTOCOL &&
  PILOT_UPDATE_CONFIGURATION !== null &&
  !IS_SMOKE_TEST
);
const UPDATES_ENABLED = PRODUCTION_UPDATES_ENABLED || PILOT_UPDATES_ENABLED;
const DISALLOWED_RUNTIME_ARGUMENT = findDisallowedRuntimeArgument(process.argv, {
  isPackaged: app.isPackaged,
  smokeTestAuthorized: SMOKE_TEST_AUTHORIZED
});

app.enableSandbox();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'blockify',
    privileges: {
      secure: true,
      standard: true
    }
  },
  {
    scheme: 'blockify-media',
    privileges: {
      bypassCSP: true,
      corsEnabled: true,
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true
    }
  }
]);

let mainWindow = null;
let startupWindow = null;
let spotifySession = null;
let blocker = null;
let blockedRequestCount = 0;
let smokeTestTimer = null;
let smokeTestStarted = false;
let injectedCssKey = null;
let mainWindowInitialLoad = Promise.resolve();
let initializationStarted = false;
let initializationComplete = false;
let pendingWindowFocus = false;
let widevineResult = { ready: false, status: null };
let diagnostics = null;
let updateRuntime = null;
let updateRuntimeFailed = false;
let shutdownRequested = false;
let authWindow = null;
const hardenedWebContents = new WeakSet();

process.on('uncaughtExceptionMonitor', (error, origin) => {
  diagnostics?.record('main-process-exception', {
    code: error?.code,
    message: error?.message,
    name: error?.name,
    origin
  });
});

function preloadPath() {
  return path.join(app.getAppPath(), 'dist', 'preload.cjs');
}

function createStartupWindow() {
  if (IS_SMOKE_TEST || startupWindow) {
    return startupWindow;
  }

  const window = new BaseWindow({
    backgroundColor: '#121212',
    center: true,
    height: 260,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    title: 'Blockify - Preparing protected playback',
    width: 520
  });
  window.setProgressBar(2, { mode: 'indeterminate' });
  window.on('closed', () => {
    const wasActiveStartupWindow = startupWindow === window;
    if (startupWindow === window) {
      startupWindow = null;
    }
    if (
      wasActiveStartupWindow &&
      initializationStarted &&
      !initializationComplete &&
      !shutdownRequested
    ) {
      app.quit();
    }
  });
  startupWindow = window;
  window.show();
  return window;
}

function closeStartupWindow() {
  if (startupWindow && !startupWindow.isDestroyed()) {
    startupWindow.destroy();
  }
  startupWindow = null;
}

function chromeUserAgent() {
  let platformToken = 'X11; Linux x86_64';
  if (process.platform === 'win32') {
    platformToken = 'Windows NT 10.0; Win64; x64';
  } else if (process.platform === 'darwin') {
    platformToken = 'Macintosh; Intel Mac OS X 10_15_7';
  }

  return [
    `Mozilla/5.0 (${platformToken})`,
    'AppleWebKit/537.36 (KHTML, like Gecko)',
    `Chrome/${process.versions.chrome} Safari/537.36`
  ].join(' ');
}

function senderIsSpotifyPlayer(event) {
  return isTrustedSpotifyIpcSender(event, mainWindow?.webContents);
}

function registerIpcHandlers() {
  ipcMain.on('blockify:set-ad-content-ids', (event, contentIds) => {
    if (!senderIsSpotifyPlayer(event) || !blocker?.isEnabled()) {
      return;
    }

    blocker.setAdContentIds(contentIds);
  });

  ipcMain.on('blockify:set-muted', (event, muted) => {
    if (!senderIsSpotifyPlayer(event) || typeof muted !== 'boolean') {
      return;
    }

    event.sender.setAudioMuted(blocker?.isEnabled() ? muted : false);
  });

}

function registerLocalProtocol(targetSession) {
  const handler = createLocalProtocolHandler({
    includeTestFixture: IS_SMOKE_TEST,
    shellCssPath: path.join(app.getAppPath(), 'src', 'renderer', 'shell.css')
  });
  targetSession.protocol.handle('blockify', handler);
  targetSession.protocol.handle('blockify-media', handler);
}

function configurePermissions(targetSession) {
  targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return isAllowedProtectedMediaPermission(
      webContents,
      permission,
      requestingOrigin,
      mainWindow?.webContents,
      details
    );
  });

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details.requestingUrl || details.securityOrigin || '';
    callback(isAllowedProtectedMediaPermission(
      webContents,
      permission,
      origin,
      mainWindow?.webContents,
      details
    ));
  });
}

function openSpotifySupport() {
  void shell.openExternal(SPOTIFY_SUPPORT_URL).catch((error) => {
    diagnostics?.record('external-open-failed', { message: error?.message });
  });
}

function secureWebContents(contents) {
  if (!contents || hardenedWebContents.has(contents)) {
    return;
  }
  hardenedWebContents.add(contents);

  contents.on('will-attach-webview', (event) => event.preventDefault());

  contents.on('will-navigate', (event, url) => {
    if (isProtectedPlaybackRetryUrl(url)) {
      event.preventDefault();
      const currentUrl = parseUrl(contents.getURL());
      if (
        contents === mainWindow?.webContents &&
        currentUrl?.protocol === 'blockify:' &&
        currentUrl.hostname === 'app' &&
        currentUrl.pathname === '/error' &&
        currentUrl.searchParams.get('retry') === 'protected-playback'
      ) {
        diagnostics?.record('protected-playback-retry');
        app.relaunch();
        app.quit();
      }
      return;
    }

    if (!isAllowedNavigationForContents(url, contents === mainWindow?.webContents)) {
      event.preventDefault();
    }
  });

  contents.on('will-redirect', (event, url) => {
    if (
      isProtectedPlaybackRetryUrl(url) ||
      !isAllowedNavigationForContents(url, contents === mainWindow?.webContents)
    ) {
      event.preventDefault();
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    const isMainContents = contents === mainWindow?.webContents;
    if (!isMainContents) {
      return { action: 'deny' };
    }

    if (isSpotifyPlayerUrl(url)) {
      void loadSpotify();
      return { action: 'deny' };
    }

    if (isAllowedPopupForContents(url, isMainContents)) {
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.focus();
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#121212',
          height: 760,
          show: true,
          width: 560,
          webPreferences: secureWebPreferences()
        }
      };
    }

    return { action: 'deny' };
  });

  contents.on('did-create-window', (childWindow) => {
    if (contents === mainWindow?.webContents) {
      authWindow = childWindow;
      childWindow.once('closed', () => {
        if (authWindow === childWindow) {
          authWindow = null;
        }
      });
    }
    secureWebContents(childWindow.webContents);
  });
}

function secureWebPreferences() {
  return {
    allowRunningInsecureContent: false,
    contextIsolation: true,
    devTools: IS_DEVELOPMENT,
    navigateOnDragDrop: false,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    partition: SESSION_PARTITION,
    preload: preloadPath(),
    safeDialogs: true,
    sandbox: true,
    spellcheck: false,
    webSecurity: true,
    webviewTag: false,
    disableBlinkFeatures: 'Auxclick'
  };
}

function updateBlockedCountMenu() {
  const menuItem = Menu.getApplicationMenu()?.getMenuItemById('blocked-count');
  if (menuItem) {
    menuItem.label = `Ad media requests blocked: ${blockedRequestCount}`;
  }
}

function updateMenuPresentation() {
  if (!UPDATES_ENABLED) {
    return { enabled: false, label: 'Updates unavailable in this build' };
  }
  if (updateRuntimeFailed) {
    return { enabled: false, label: 'Updates unavailable - restart Blockify' };
  }
  if (!updateRuntime) {
    return { enabled: false, label: 'Preparing update service...' };
  }

  const state = updateRuntime.getState();
  const version = state.availableVersion && state.availableVersion !== 'unknown'
    ? ` ${state.availableVersion}`
    : '';
  switch (state.status) {
    case UPDATE_STATUS.CHECKING:
      return { enabled: false, label: 'Checking for updates...' };
    case UPDATE_STATUS.AVAILABLE:
      return { enabled: false, label: `Update${version} available...` };
    case UPDATE_STATUS.DOWNLOADING: {
      const progress = Number.isFinite(state.downloadPercent)
        ? ` (${Math.round(state.downloadPercent)}%)`
        : '';
      return { enabled: false, label: `Downloading update${version}${progress}...` };
    }
    case UPDATE_STATUS.DOWNLOADED:
      return { enabled: true, label: `Restart to install update${version}...` };
    case UPDATE_STATUS.INSTALLING:
      return { enabled: false, label: 'Restarting to install update...' };
    case UPDATE_STATUS.STOPPED:
    case UPDATE_STATUS.DISABLED:
      return { enabled: false, label: 'Updates unavailable in this build' };
    case UPDATE_STATUS.ERROR:
    case UPDATE_STATUS.IDLE:
    default:
      return { enabled: true, label: 'Check for updates...' };
  }
}

function refreshUpdateMenu() {
  const menuItem = Menu.getApplicationMenu()?.getMenuItemById('check-for-updates');
  if (!menuItem) {
    return;
  }
  const presentation = updateMenuPresentation();
  menuItem.enabled = presentation.enabled;
  menuItem.label = presentation.label;
}

function checkForUpdatesFromMenu() {
  if (!updateRuntime) {
    return;
  }
  void updateRuntime.checkNow().catch((error) => {
    diagnostics?.record('update-menu-action-failed', {
      code: error?.code,
      name: error?.name
    });
  });
}

function initializeUpdates() {
  if (!UPDATES_ENABLED || updateRuntime || updateRuntimeFailed) {
    refreshUpdateMenu();
    return;
  }

  try {
    let autoUpdater;
    if (PRODUCTION_UPDATES_ENABLED) {
      // Only production loads electron-updater. Its Authenticode verifier and
      // app-update.yml publisher allowlist remain mandatory on that channel.
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.forceDevUpdateConfig = false;
      // Stock updater messages can contain feed URLs and a local rollout UUID.
      // The state machine records only bounded event names, versions, and codes.
      autoUpdater.logger = Object.freeze({
        debug() {},
        error() {},
        info() {},
        warn() {}
      });
    } else {
      // Pilot builds intentionally do not weaken electron-updater's signature
      // verifier. They use a separate, embedded-key manifest verifier instead.
      const { createPilotUpdater } = require('./pilot-updater');
      autoUpdater = createPilotUpdater({
        app,
        configuration: PILOT_UPDATE_CONFIGURATION
      });
    }

    const dialogHooks = createDialogUpdateHooks({
      appName: PILOT_UPDATES_ENABLED ? `${APP_NAME} Pilot` : APP_NAME,
      dialog,
      getParentWindow: () => mainWindow
    });
    const runtimeOptions = {
      autoUpdater,
      diagnostics,
      enabled: true,
      hooks: {
        ...dialogHooks,
        onStateChange: refreshUpdateMenu
      }
    };
    if (PRODUCTION_UPDATES_ENABLED) {
      runtimeOptions.verifyDownloadedInstaller = verifyWindowsInstallerVersion;
    }
    const runtime = createUpdateRuntime(runtimeOptions);
    updateRuntime = runtime;
    runtime.start();
    refreshUpdateMenu();
  } catch (error) {
    updateRuntimeFailed = true;
    diagnostics?.record('update-runtime-unavailable', {
      code: error?.code,
      name: error?.name
    });
    refreshUpdateMenu();
  }
}

async function clearSpotifyData() {
  if (!mainWindow || !spotifySession) {
    return;
  }

  const result = await dialog.showMessageBox(mainWindow, {
    buttons: ['Cancel', 'Clear data'],
    cancelId: 0,
    defaultId: 0,
    detail: 'This signs you out of Spotify and clears cookies, site storage, service workers, and cached web content. The protected-playback component is retained.',
    message: 'Clear Spotify sign-in and site data?',
    noLink: true,
    title: APP_NAME,
    type: 'warning'
  });
  if (result.response !== 1) {
    return;
  }

  blocker?.clearAdContentIds();
  mainWindow.webContents.setAudioMuted(false);
  try {
    await Promise.all([
      spotifySession.clearCache(),
      spotifySession.clearStorageData()
    ]);
    diagnostics?.record('spotify-data-cleared');
    await loadSpotify();
  } catch (error) {
    diagnostics?.record('spotify-data-clear-failed', { message: error?.message });
    dialog.showErrorBox(APP_NAME, 'Spotify site data could not be completely cleared. Close Blockify and try again.');
  }
}

async function openDiagnosticsFolder() {
  if (!diagnostics?.prepareDirectory()) {
    dialog.showErrorBox(APP_NAME, 'The local diagnostics folder could not be created.');
    return;
  }

  try {
    const errorMessage = await shell.openPath(diagnostics.directory);
    if (errorMessage) {
      dialog.showErrorBox(APP_NAME, `The local diagnostics folder could not be opened: ${errorMessage}`);
    }
  } catch (error) {
    diagnostics.record('diagnostics-folder-open-failed', { message: error?.message });
    dialog.showErrorBox(APP_NAME, 'The local diagnostics folder could not be opened.');
  }
}

async function clearDiagnostics() {
  if (!diagnostics) {
    return;
  }

  const options = {
    buttons: ['Cancel', 'Clear diagnostics'],
    cancelId: 0,
    defaultId: 0,
    detail: 'This removes Blockify\'s bounded operational logs. Spotify cookies and site data are not affected.',
    message: 'Clear local diagnostics?',
    noLink: true,
    title: APP_NAME,
    type: 'warning'
  };
  try {
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 1 && !diagnostics.clear()) {
      dialog.showErrorBox(APP_NAME, 'Some local diagnostic files could not be removed. Close Blockify and try again.');
    }
  } catch (error) {
    diagnostics.record('diagnostics-clear-failed', { message: error?.message });
  }
}

function buildApplicationMenu() {
  const updatePresentation = updateMenuPresentation();
  const template = [
    {
      label: APP_NAME,
      submenu: [
        {
          id: 'blocker-enabled',
          label: 'Block Spotify ads',
          type: 'checkbox',
          checked: blocker?.isEnabled() ?? true,
          click: (item) => {
            blocker?.setEnabled(item.checked);
            mainWindow?.webContents.setAudioMuted(false);
            void clearSpotifyStyles().finally(() => mainWindow?.webContents.reload());
          }
        },
        {
          id: 'blocked-count',
          label: `Ad media requests blocked: ${blockedRequestCount}`,
          enabled: false
        },
        { type: 'separator' },
        {
          label: 'Open Spotify home',
          accelerator: 'Alt+S',
          click: () => void loadSpotify()
        },
        {
          label: 'Reload Spotify',
          accelerator: 'CmdOrCtrl+R',
          click: () => void loadSpotify()
        },
        { type: 'separator' },
        {
          label: 'Clear Spotify sign-in and site data...',
          click: () => void clearSpotifyData()
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Navigate',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => {
            if (mainWindow?.webContents.navigationHistory.canGoBack()) {
              mainWindow.webContents.navigationHistory.goBack();
            }
          }
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => {
            if (mainWindow?.webContents.navigationHistory.canGoForward()) {
              mainWindow.webContents.navigationHistory.goForward();
            }
          }
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          id: 'check-for-updates',
          label: updatePresentation.label,
          enabled: updatePresentation.enabled,
          click: checkForUpdatesFromMenu
        },
        { type: 'separator' },
        {
          label: 'Spotify support',
          click: () => openSpotifySupport()
        },
        {
          label: 'Local diagnostics',
          submenu: [
            {
              label: 'Open diagnostics folder',
              click: () => void openDiagnosticsFolder()
            },
            {
              label: 'Clear local diagnostics...',
              click: () => void clearDiagnostics()
            }
          ]
        },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false
        },
        { role: 'about' }
      ]
    }
  ];

  if (IS_DEVELOPMENT) {
    template.push({
      label: 'Developer',
      submenu: [{ role: 'toggleDevTools' }]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function clearSpotifyStyles() {
  const key = injectedCssKey;
  injectedCssKey = null;
  if (!key || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    await mainWindow.webContents.removeInsertedCSS(key);
  } catch {
    // Navigation can invalidate an inserted CSS key before cleanup runs.
  }
}

async function insertSpotifyStyles(contents) {
  if (!blocker?.isEnabled() || !isSpotifyPlayerUrl(contents.getURL())) {
    return;
  }

  try {
    const css = fs.readFileSync(path.join(app.getAppPath(), 'src', 'renderer', 'spotify.css'), 'utf8');
    injectedCssKey = await contents.insertCSS(css, { cssOrigin: 'user' });
  } catch (error) {
    console.error('[Blockify] Could not apply Spotify styles:', error.message);
  }
}

function finishSmokeTest(result, exitCode = 0) {
  if (!IS_SMOKE_TEST) {
    return;
  }

  if (smokeTestTimer) {
    clearTimeout(smokeTestTimer);
    smokeTestTimer = null;
  }

  console.log(`BLOCKIFY_SMOKE_TEST ${JSON.stringify(result)}`);
  app.exit(exitCode);
}

function waitForCondition(check, label, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      try {
        const value = check();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function runSmokeTest(contents) {
  if (smokeTestStarted) {
    return;
  }
  smokeTestStarted = true;

  try {
    const preferences = contents.getLastWebPreferences();
    const runtimeSecurity = {
      allowRunningInsecureContent: Boolean(preferences.allowRunningInsecureContent),
      auxclickMitigationConfigured: secureWebPreferences().disableBlinkFeatures === 'Auxclick',
      contextIsolation: Boolean(preferences.contextIsolation),
      devTools: Boolean(preferences.devTools),
      nodeIntegration: Boolean(preferences.nodeIntegration),
      nodeIntegrationInSubFrames: Boolean(preferences.nodeIntegrationInSubFrames),
      nodeIntegrationInWorker: Boolean(preferences.nodeIntegrationInWorker),
      sandbox: Boolean(preferences.sandbox),
      webSecurity: Boolean(preferences.webSecurity),
      webviewTag: Boolean(preferences.webviewTag)
    };
    const bootstrap = await contents.executeJavaScript(`(async () => {
      const localResponse = await fetch('${NOOP_MEDIA_URL}');
      const localMediaBytes = (await localResponse.arrayBuffer()).byteLength;
      const rangeResponse = await fetch('${NOOP_MEDIA_URL}', {
        headers: { Range: 'bytes=0-63' }
      });
      const rangeBytes = (await rangeResponse.arrayBuffer()).byteLength;
      const fixtureResponse = await fetch('${SMOKE_FIXTURE_URL}');
      await fixtureResponse.json();
      return {
        hookInstalled: Boolean(window.__blockifyElectronHook),
        hostname: location.hostname,
        localMediaBytes,
        rangeBytes,
        rangeContent: rangeResponse.headers.get('content-range'),
        rangeStatus: rangeResponse.status,
        rendererNodeGlobalsAbsent: typeof require === 'undefined' && typeof process === 'undefined',
        title: document.title
      };
    })()`);
    const runtimeSecurityHardened = Boolean(
      runtimeSecurity.allowRunningInsecureContent === false &&
      runtimeSecurity.auxclickMitigationConfigured &&
      runtimeSecurity.contextIsolation === true &&
      runtimeSecurity.devTools === false &&
      runtimeSecurity.nodeIntegration === false &&
      runtimeSecurity.nodeIntegrationInSubFrames === false &&
      runtimeSecurity.nodeIntegrationInWorker === false &&
      runtimeSecurity.sandbox === true &&
      runtimeSecurity.webSecurity === true &&
      runtimeSecurity.webviewTag === false &&
      bootstrap.rendererNodeGlobalsAbsent
    );

    await waitForCondition(
      () => blocker.getAdContentIds().includes('smoke_ad_id_12345'),
      'fetch-hook ad ID publication'
    );
    const fetchHookWorking = true;

    await contents.executeJavaScript(`(() => {
      let panel = document.querySelector('[data-blockify-smoke-panel="true"]');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'Desktop_PanelContainer_Id';
        panel.setAttribute('data-blockify-smoke-panel', 'true');
        document.body.prepend(panel);
      }
      const marker = document.createElement('div');
      marker.id = 'blockify-smoke-ad-marker';
      marker.setAttribute('data-testid', 'ad-companion-card');
      panel.appendChild(marker);
    })()`);
    await waitForCondition(() => contents.isAudioMuted(), 'ad marker mute');
    const muteActivated = true;

    const blockedCountBeforeProbe = blockedRequestCount;
    const mediaProbe = await contents.executeJavaScript(`new Promise((resolve) => {
      const media = document.createElement('audio');
      media.id = 'blockify-smoke-media-probe';
      media.preload = 'auto';
      let settled = false;
      const finish = (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          duration: Number.isFinite(media.duration) ? media.duration : null,
          errorCode: media.error?.code || null,
          event,
          readyState: media.readyState
        });
      };
      const timeout = setTimeout(() => finish('timeout'), 8000);
      media.addEventListener('loadedmetadata', () => finish('loadedmetadata'), { once: true });
      media.addEventListener('error', () => finish('error'), { once: true });
      media.src = 'https://blockify-smoke.invalid/media/smoke_ad_id_12345.mp3';
      document.body.appendChild(media);
      media.load();
    })`);
    const networkRedirectWorking = blockedRequestCount > blockedCountBeforeProbe;
    const mediaDecoded = mediaProbe.event === 'loadedmetadata' && mediaProbe.readyState >= 1;

    const blockedCountBeforeStaticProbe = blockedRequestCount;
    const staticMediaProbe = await contents.executeJavaScript(`new Promise((resolve) => {
      const media = document.createElement('audio');
      media.id = 'blockify-smoke-static-media-probe';
      media.preload = 'auto';
      let settled = false;
      const finish = (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          duration: Number.isFinite(media.duration) ? media.duration : null,
          errorCode: media.error?.code || null,
          event,
          readyState: media.readyState
        });
      };
      const timeout = setTimeout(() => finish('timeout'), 8000);
      media.addEventListener('loadedmetadata', () => finish('loadedmetadata'), { once: true });
      media.addEventListener('error', () => finish('error'), { once: true });
      media.src = 'https://adstudio-assets.scdn.co/mp3/blockify-static-route-smoke.mp3';
      document.body.appendChild(media);
      media.load();
    })`);
    const staticAdRouteWorking = blockedRequestCount > blockedCountBeforeStaticProbe;
    const staticMediaDecoded = staticMediaProbe.event === 'loadedmetadata' &&
      staticMediaProbe.readyState >= 1;

    await contents.executeJavaScript(`(() => {
      document.getElementById('blockify-smoke-ad-marker')?.remove();
      document.getElementById('blockify-smoke-media-probe')?.remove();
      document.getElementById('blockify-smoke-static-media-probe')?.remove();
      document.querySelector('[data-blockify-smoke-panel="true"]')?.remove();
    })()`);
    await waitForCondition(() => !contents.isAudioMuted(), 'mute restoration');
    blocker.clearAdContentIds();

    const checks = {
      ...bootstrap,
      fetchHookWorking,
      mediaDecoded,
      mediaProbe,
      muteActivated,
      muteRestored: true,
      networkRedirectWorking,
      runtimeSecurity,
      runtimeSecurityHardened,
      staticAdRouteWorking,
      staticMediaDecoded,
      staticMediaProbe,
      widevineReady: widevineResult.ready,
      widevineStatus: widevineResult.status
    };
    const ok = Boolean(
      checks.hookInstalled &&
      checks.localMediaBytes > 0 &&
      checks.rangeStatus === 206 &&
      checks.rangeBytes === 64 &&
      checks.rangeContent?.startsWith('bytes 0-63/') &&
      checks.fetchHookWorking &&
      checks.mediaDecoded &&
      checks.muteActivated &&
      checks.muteRestored &&
      checks.networkRedirectWorking &&
      checks.staticAdRouteWorking &&
      checks.staticMediaDecoded &&
      checks.runtimeSecurityHardened &&
      checks.widevineReady
    );
    finishSmokeTest({ ok, ...checks }, ok ? 0 : 1);
  } catch (error) {
    finishSmokeTest({ ok: false, error: error.message }, 1);
  }
}

function attachSmokeTest(contents) {
  if (!IS_SMOKE_TEST) {
    return;
  }

  smokeTestTimer = setTimeout(() => {
    finishSmokeTest({ ok: false, error: 'Timed out completing the live smoke test' }, 1);
  }, SMOKE_TIMEOUT_MS);

  contents.on('did-finish-load', () => {
    if (isSpotifyPlayerUrl(contents.getURL())) {
      void runSmokeTest(contents);
    }
  });
}

function safeLoadErrorMessage(errorCode, errorDescription) {
  const description = String(errorDescription || 'Network error').replaceAll('_', ' ').slice(0, 140);
  const code = String(errorCode || '').replace(/[\r\n\t]/gu, ' ').slice(0, 32);
  return code ? `${description} (${code})` : description;
}

async function showLoadError(errorCode, errorDescription, options = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || IS_SMOKE_TEST) {
    return;
  }

  const message = encodeURIComponent(safeLoadErrorMessage(errorCode, errorDescription));
  const retry = options.retryMode === 'protected-playback'
    ? '&retry=protected-playback'
    : '';
  try {
    await mainWindow.loadURL(`blockify://app/error?message=${message}${retry}`);
  } catch (error) {
    console.error('[Blockify] Could not show the recovery page:', error.message);
  }
}

async function loadSpotify() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  try {
    await mainWindow.loadURL(SPOTIFY_URL);
    return true;
  } catch (error) {
    diagnostics?.record('spotify-load-failed', {
      code: error?.errno ?? error?.code,
      description: error?.message
    });
    if (IS_SMOKE_TEST) {
      finishSmokeTest({ ok: false, error: error.message }, 1);
    } else if (error?.code !== 'ERR_ABORTED') {
      await showLoadError(error?.errno, error?.message);
    }
    return false;
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (startupWindow && !startupWindow.isDestroyed()) {
      startupWindow.show();
      startupWindow.focus();
    }
    pendingWindowFocus = true;
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  pendingWindowFocus = false;
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }
  if (!spotifySession || !blocker) {
    pendingWindowFocus = true;
    return null;
  }

  const window = new BrowserWindow({
    autoHideMenuBar: false,
    backgroundColor: '#121212',
    height: 860,
    minHeight: 640,
    minWidth: 800,
    show: false,
    title: APP_NAME,
    width: 1280,
    webPreferences: secureWebPreferences()
  });

  mainWindow = window;
  let unresponsivePromptOpen = false;
  secureWebContents(window.webContents);
  attachSmokeTest(window.webContents);

  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      injectedCssKey = null;
      blocker?.clearAdContentIds();
      window.webContents.setAudioMuted(false);
    }
  });

  window.webContents.on('dom-ready', () => {
    void insertSpotifyStyles(window.webContents);
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !isSpotifyPlayerUrl(validatedURL)) {
      return;
    }
    diagnostics?.record('spotify-load-failed', {
      code: errorCode,
      description: errorDescription
    });
    if (IS_SMOKE_TEST) {
      finishSmokeTest({
        ok: false,
        errorCode,
        errorDescription,
        url: validatedURL
      }, 1);
      return;
    }
    void showLoadError(errorCode, errorDescription);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics?.record('renderer-gone', {
      exitCode: details.exitCode,
      reason: details.reason
    });
    if (!window.isDestroyed()) {
      void showLoadError(undefined, `Spotify renderer stopped: ${details.reason}`);
    }
  });

  window.on('unresponsive', () => {
    if (unresponsivePromptOpen || window.isDestroyed()) {
      return;
    }
    unresponsivePromptOpen = true;
    diagnostics?.record('renderer-unresponsive');
    void dialog.showMessageBox(window, {
      buttons: ['Wait', 'Reload'],
      cancelId: 0,
      defaultId: 1,
      message: 'Spotify is not responding.',
      noLink: true,
      title: APP_NAME,
      type: 'warning'
    }).then((result) => {
      if (result.response === 1 && !window.isDestroyed()) {
        void loadSpotify();
      }
    }).catch((error) => {
      diagnostics?.record('unresponsive-dialog-failed', { message: error?.message });
    }).finally(() => {
      unresponsivePromptOpen = false;
    });
  });

  window.on('responsive', () => {
    diagnostics?.record('renderer-responsive');
  });

  window.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    window.setTitle(title ? `${title} - ${APP_NAME}` : APP_NAME);
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
      injectedCssKey = null;
    }
  });

  if (!IS_SMOKE_TEST) {
    window.once('ready-to-show', () => window.show());
  }

  mainWindowInitialLoad = window.loadURL(LOADING_URL).catch((error) => {
    if (error?.code !== 'ERR_ABORTED') {
      console.error('[Blockify] Could not show the startup page:', error.message);
    }
  });
  buildApplicationMenu();
  return window;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function prepareWidevine() {
  if (!components?.whenReady) {
    return {
      ready: false,
      status: null,
      warning: 'This Electron build has no protected-playback component updater.'
    };
  }

  try {
    await withTimeout(components.whenReady(), COMPONENT_TIMEOUT_MS, 'Protected playback setup');
    return { ready: true, status: components.status() };
  } catch (error) {
    return { ready: false, status: components.status?.() || null, warning: error.message };
  }
}

async function initialize() {
  if (initializationStarted) {
    return;
  }
  initializationStarted = true;
  nativeTheme.themeSource = 'dark';
  app.setAppUserModelId('com.getblockify.desktop');
  diagnostics = createLocalDiagnostics({
    appVersion: app.getVersion(),
    directory: path.join(app.getPath('userData'), 'diagnostics')
  });
  diagnostics.record('app-started', {
    development: IS_DEVELOPMENT,
    packaged: app.isPackaged,
    smokeTest: IS_SMOKE_TEST
  });

  spotifySession = session.fromPartition(SESSION_PARTITION);
  spotifySession.setUserAgent(chromeUserAgent());
  configurePermissions(spotifySession);
  registerLocalProtocol(spotifySession);

  blocker = installSpotifyBlocker(spotifySession, {
    redirectURL: NOOP_MEDIA_URL,
    onRedirect: ({ details, reason }) => {
      blockedRequestCount += 1;
      updateBlockedCountMenu();
      diagnostics?.record('spotify-ad-media-blocked', { reason });
      if (IS_DEVELOPMENT || IS_SMOKE_TEST) {
        const hostname = parseUrl(details.url)?.hostname || 'unknown host';
        console.log(`[Blockify] Intercepted ${reason} from ${hostname}`);
      }
    }
  });

  registerIpcHandlers();
  createStartupWindow();
  widevineResult = await prepareWidevine();
  diagnostics.record('protected-playback-status', {
    ready: widevineResult.ready,
    warning: widevineResult.warning
  });
  if (!widevineResult.ready) {
    console.warn(`[Blockify] Protected playback setup warning: ${widevineResult.warning}`);
  }
  if (shutdownRequested) {
    return;
  }
  createMainWindow();
  initializeUpdates();
  await mainWindowInitialLoad;
  if (shutdownRequested) {
    return;
  }
  initializationComplete = true;
  closeStartupWindow();
  if (pendingWindowFocus && !IS_SMOKE_TEST) {
    focusMainWindow();
  }

  if (widevineResult.ready) {
    await loadSpotify();
  } else if (IS_SMOKE_TEST) {
    finishSmokeTest({ ok: false, error: widevineResult.warning }, 1);
  } else {
    await showLoadError(undefined, widevineResult.warning, {
      retryMode: 'protected-playback'
    });
  }
}

if (DISALLOWED_RUNTIME_ARGUMENT) {
  console.error(`[Blockify] Refusing unsafe packaged runtime switch: --${DISALLOWED_RUNTIME_ARGUMENT}`);
  app.exit(2);
} else if (!app.requestSingleInstanceLock()) {
  if (IS_SMOKE_TEST) {
    console.log('BLOCKIFY_SMOKE_TEST {"ok":false,"error":"Another Blockify instance owns this profile"}');
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  app.on('web-contents-created', (_event, contents) => {
    secureWebContents(contents);
  });

  app.on('child-process-gone', (_event, details) => {
    diagnostics?.record('child-process-gone', {
      exitCode: details.exitCode,
      name: details.name,
      reason: details.reason,
      serviceName: details.serviceName,
      type: details.type
    });
  });

  app.on('second-instance', () => {
    diagnostics?.record('second-instance-focused');
    if ((!mainWindow || mainWindow.isDestroyed()) && initializationComplete) {
      createMainWindow();
      void mainWindowInitialLoad.then(loadSpotify);
    } else {
      focusMainWindow();
    }
  });

  app.whenReady().then(initialize).catch((error) => {
    diagnostics?.record('startup-failed', {
      code: error?.code,
      message: error?.message,
      name: error?.name
    });
    console.error('[Blockify] Startup failed:', error);
    finishSmokeTest({ ok: false, error: error.message }, 1);
    if (!IS_SMOKE_TEST) {
      dialog.showErrorBox('Blockify could not start', error.message);
      app.quit();
    }
  });
}

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
  } else if (initializationComplete) {
    createMainWindow();
    void mainWindowInitialLoad.then(loadSpotify);
  } else {
    pendingWindowFocus = true;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  shutdownRequested = true;
  updateRuntime?.stop();
  diagnostics?.record('app-stopping');
});
