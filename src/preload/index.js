const { ipcRenderer, webFrame } = require('electron');
const { installBlockifyPageHook } = require('./page-hook');

const SPOTIFY_HOSTNAME = 'open.spotify.com';
const AD_BREAK_TEXT = 'Your music will continue after the break';
const AD_CONTENT_IDS_ATTRIBUTE = 'data-blockify-ad-content-ids';

if (
  window.top === window &&
  location.protocol === 'https:' &&
  location.hostname === SPOTIFY_HOSTNAME &&
  !location.port
) {
  const source = `;(${installBlockifyPageHook.toString()})();\n//# sourceURL=blockify-page-hook.js`;
  void webFrame.executeJavaScriptInIsolatedWorld(0, [{ code: source }]).catch(() => {
    // Keep the isolated preload alive if Spotify changes its page-world policy.
  });

  let lastAdContentIds = '';
  let lastMutedState = null;
  let syncTimer = null;
  let muteWatchdog = null;
  let disposed = false;

  function readAdContentIds() {
    const rawValue = document.body?.getAttribute(AD_CONTENT_IDS_ATTRIBUTE) || '[]';
    if (rawValue === lastAdContentIds || rawValue.length > 16_384) {
      return;
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (Array.isArray(parsed)) {
        lastAdContentIds = rawValue;
        ipcRenderer.send('blockify:set-ad-content-ids', parsed.slice(0, 32));
      }
    } catch {
      // Ignore page-provided malformed values; the main process validates again.
    }
  }

  function spotifyShowsAnAd() {
    const panel = document.getElementById('Desktop_PanelContainer_Id');
    if (!panel) {
      return false;
    }

    if (panel?.textContent?.includes(AD_BREAK_TEXT)) {
      return true;
    }

    return Boolean(panel.querySelector([
      '[data-testid="ad-companion-card"]',
      '[data-testid="ad-companion-card-tagline"]',
      'a[data-context-item-type="ad"]'
    ].join(',')));
  }

  function syncPageState() {
    syncTimer = null;
    if (disposed) {
      return;
    }

    readAdContentIds();

    const muted = spotifyShowsAnAd();
    if (muted !== lastMutedState) {
      lastMutedState = muted;
      ipcRenderer.send('blockify:set-muted', muted);
    }
  }

  function scheduleSync() {
    if (disposed || syncTimer !== null) {
      return;
    }
    syncTimer = setTimeout(syncPageState, 250);
  }

  function startObserver() {
    const root = document.documentElement;
    if (!root) {
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
      return;
    }

    const observer = new MutationObserver(scheduleSync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: [
        AD_CONTENT_IDS_ATTRIBUTE,
        'data-context-item-type',
        'data-testid'
      ],
      childList: true,
      subtree: true
    });
    muteWatchdog = setInterval(scheduleSync, 1000);

    window.addEventListener('pagehide', () => {
      disposed = true;
      observer.disconnect();
      if (syncTimer !== null) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      if (muteWatchdog !== null) {
        clearInterval(muteWatchdog);
        muteWatchdog = null;
      }
      ipcRenderer.send('blockify:set-ad-content-ids', []);
      ipcRenderer.send('blockify:set-muted', false);
    }, { once: true });

    syncPageState();
  }

  startObserver();
}
