function installBlockifyPageHook() {
  'use strict';

  if (location.hostname !== 'open.spotify.com' || window.__blockifyElectronHook) {
    return;
  }

  const MAX_AD_CONTENT_IDS = 32;
  const MAX_JSON_LENGTH = 8_000_000;
  const knownAdContentIds = new Set();
  let lastPublishedContentIds = '';
  const hookState = Object.freeze({
    installedAt: Date.now(),
    version: '1.9.6'
  });

  Object.defineProperty(window, '__blockifyElectronHook', {
    configurable: false,
    enumerable: false,
    value: hookState,
    writable: false
  });

  function isSafeContentId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
  }

  function publishAdContentIds() {
    if (!document.body) {
      return;
    }

    const serialized = JSON.stringify([...knownAdContentIds].slice(-MAX_AD_CONTENT_IDS));
    if (serialized === lastPublishedContentIds) {
      return;
    }

    lastPublishedContentIds = serialized;
    document.body.setAttribute('data-blockify-ad-content-ids', serialized);
  }

  function rememberContentId(value) {
    if (!isSafeContentId(value)) {
      return;
    }

    knownAdContentIds.delete(value);
    knownAdContentIds.add(value);
    while (knownAdContentIds.size > MAX_AD_CONTENT_IDS) {
      knownAdContentIds.delete(knownAdContentIds.values().next().value);
    }
  }

  function valueMarksTrackAsAd(track) {
    const metadata = track?.metadata || {};
    const candidates = [
      track?.content_type,
      track?.contentType,
      track?.type,
      metadata.content_type,
      metadata.contentType,
      metadata.is_ad,
      metadata.isAd,
      track?.is_ad,
      track?.isAd
    ];

    return candidates.some((value) => {
      if (value === true) {
        return true;
      }
      return typeof value === 'string' && ['AD', 'ADVERTISEMENT', 'TRUE'].includes(value.toUpperCase());
    });
  }

  function collectIdsFromManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
      return;
    }

    const candidateGroups = [
      manifest.file_ids_mp3,
      manifest.file_ids_external,
      manifest.file_ids,
      manifest.alternatives
    ];

    for (const group of candidateGroups) {
      if (!Array.isArray(group)) {
        continue;
      }

      for (const entry of group) {
        if (typeof entry === 'string') {
          rememberContentId(entry);
        } else {
          rememberContentId(entry?.file_id);
          rememberContentId(entry?.fileId);
          rememberContentId(entry?.id);
        }
      }
    }
  }

  function inspectTracks(tracks) {
    if (!Array.isArray(tracks)) {
      return;
    }

    const contentIdsBefore = JSON.stringify([...knownAdContentIds]);
    for (const track of tracks) {
      if (!valueMarksTrackAsAd(track)) {
        continue;
      }

      collectIdsFromManifest(track.manifest);
      rememberContentId(track.file_id);
      rememberContentId(track.fileId);
    }

    if (JSON.stringify([...knownAdContentIds]) !== contentIdsBefore) {
      publishAdContentIds();
    }
  }

  function inspectStateMachine(stateMachine) {
    if (!stateMachine || typeof stateMachine !== 'object') {
      return;
    }

    inspectTracks(stateMachine.tracks);
    inspectTracks(stateMachine.track_list);
    inspectTracks(stateMachine.queue?.tracks);
  }

  function inspectPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    inspectStateMachine(payload.state_machine);
    inspectStateMachine(payload.stateMachine);

    if (Array.isArray(payload.payloads)) {
      for (const entry of payload.payloads) {
        inspectStateMachine(entry?.state_machine);
        inspectStateMachine(entry?.stateMachine);
      }
    }
  }

  function parseJsonSafely(value) {
    if (typeof value !== 'string' || value.length > MAX_JSON_LENGTH) {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function fetchUrl(input) {
    if (typeof input === 'string') {
      return input;
    }
    return typeof input?.url === 'string' ? input.url : '';
  }

  function inspectSocketData(value) {
    if (typeof value === 'string') {
      const payload = parseJsonSafely(value);
      if (payload) {
        inspectPayload(payload);
      }
      return;
    }

    if (typeof Blob === 'function' && value instanceof Blob) {
      if (value.size <= MAX_JSON_LENGTH) {
        value.text().then(inspectSocketData).catch(() => {});
      }
      return;
    }

    if (typeof ArrayBuffer === 'function' && value instanceof ArrayBuffer) {
      if (value.byteLength <= MAX_JSON_LENGTH) {
        try {
          inspectSocketData(new TextDecoder().decode(value));
        } catch {
          // Ignore binary player messages that are not UTF-8 JSON.
        }
      }
    }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = new Proxy(nativeFetch, {
      apply(target, thisArgument, argumentsList) {
        const responsePromise = Reflect.apply(target, thisArgument, argumentsList);
        const url = fetchUrl(argumentsList[0]);

        if (url.includes('/state')) {
          Promise.resolve(responsePromise)
            .then((response) => response.clone().json())
            .then(inspectPayload)
            .catch(() => {});
        }

        return responsePromise;
      }
    });
  }

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, argumentsList) {
        const socket = Reflect.construct(target, argumentsList, target);
        socket.addEventListener('message', (event) => {
          inspectSocketData(event.data);
        });
        return socket;
      }
    });
  }

  if (document.body) {
    publishAdContentIds();
  } else {
    document.addEventListener('DOMContentLoaded', publishAdContentIds, { once: true });
  }

}

module.exports = { installBlockifyPageHook };
