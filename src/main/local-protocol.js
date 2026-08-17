const fs = require('node:fs');
const { renderShellPage, SHELL_PAGE_CSP } = require('../renderer/shell');

const PAGE_CSP = SHELL_PAGE_CSP;
const SILENT_WAV_SAMPLE_RATE = 8_000;
const SILENT_WAV_DURATION_SECONDS = 1;

function createSilentWav() {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataLength = SILENT_WAV_SAMPLE_RATE * SILENT_WAV_DURATION_SECONDS * channels * bytesPerSample;
  const output = Buffer.alloc(44 + dataLength);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataLength, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(SILENT_WAV_SAMPLE_RATE, 24);
  output.writeUInt32LE(SILENT_WAV_SAMPLE_RATE * channels * bytesPerSample, 28);
  output.writeUInt16LE(channels * bytesPerSample, 32);
  output.writeUInt16LE(bitsPerSample, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataLength, 40);
  return output;
}

const SILENT_WAV = createSilentWav();

function methodNotAllowed(allowedMethods, extraHeaders = {}) {
  return new Response(null, {
    headers: {
      Allow: allowedMethods.join(', '),
      'Cache-Control': 'no-store',
      ...extraHeaders
    },
    status: 405
  });
}

function appPageResponse(request, html) {
  const body = Buffer.from(html, 'utf8');
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
      'Content-Security-Policy': PAGE_CSP,
      'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    }
  });
}

function parseByteRange(value, size) {
  if (typeof value !== 'string' || !/^bytes=\d*-\d*$/.test(value) || size <= 0) {
    return null;
  }

  const [rawStart, rawEnd] = value.slice(6).split('-');
  if (!rawStart && !rawEnd) {
    return null;
  }

  let start;
  let end;
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

function mediaResponse(request, media) {
  const baseHeaders = {
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': 'https://open.spotify.com',
    'Cache-Control': 'no-store',
    'Content-Type': 'audio/wav',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff'
  };
  const rangeHeader = request.headers.get('range');
  const range = rangeHeader ? parseByteRange(rangeHeader, media.length) : null;

  if (rangeHeader && !range) {
    return new Response(null, {
      headers: { ...baseHeaders, 'Content-Range': `bytes */${media.length}` },
      status: 416
    });
  }

  const body = range ? media.subarray(range.start, range.end + 1) : media;
  const headers = { ...baseHeaders, 'Content-Length': String(body.length) };
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${media.length}`;
  }

  return new Response(request.method === 'HEAD' ? null : body, {
    headers,
    status: range ? 206 : 200
  });
}

function createLocalProtocolHandler(options) {
  const { includeTestFixture = false, shellCssPath } = options;
  const media = SILENT_WAV;
  const shellCss = fs.readFileSync(shellCssPath);

  return (request) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    if (
      requestUrl.protocol === 'blockify-media:' &&
      requestUrl.hostname === 'media' &&
      requestUrl.pathname === '/noop-1s.wav'
    ) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Headers': 'Range',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Origin': 'https://open.spotify.com',
            'Access-Control-Max-Age': '86400',
            Allow: 'GET, HEAD, OPTIONS',
            'Cache-Control': 'no-store',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'X-Content-Type-Options': 'nosniff'
          },
          status: 204
        });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return methodNotAllowed(['GET', 'HEAD', 'OPTIONS'], {
          'Access-Control-Allow-Origin': 'https://open.spotify.com',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'X-Content-Type-Options': 'nosniff'
        });
      }
      return mediaResponse(request, media);
    }

    if (
      requestUrl.protocol === 'blockify-media:' &&
      includeTestFixture &&
      requestUrl.hostname === 'test' &&
      requestUrl.pathname === '/state-fixture'
    ) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return methodNotAllowed(['GET', 'HEAD'], {
          'Access-Control-Allow-Origin': 'https://open.spotify.com',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'X-Content-Type-Options': 'nosniff'
        });
      }
      const body = JSON.stringify({
        state_machine: {
          tracks: [{
            content_type: 'AD',
            manifest: { file_ids_mp3: [{ file_id: 'smoke_ad_id_12345' }] }
          }]
        }
      });
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: {
          'Access-Control-Allow-Origin': 'https://open.spotify.com',
          'Cache-Control': 'no-store',
          'Content-Length': String(Buffer.byteLength(body)),
          'Content-Type': 'application/json; charset=utf-8',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    }

    if (requestUrl.protocol !== 'blockify:' || requestUrl.hostname !== 'app') {
      return new Response('Not found', { status: 404 });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return methodNotAllowed(['GET', 'HEAD']);
    }

    if (requestUrl.pathname === '/shell.css') {
      return new Response(request.method === 'HEAD' ? null : shellCss, {
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'Content-Length': String(shellCss.length),
          'Content-Type': 'text/css; charset=utf-8',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    }

    if (requestUrl.pathname === '/loading') {
      return appPageResponse(request, renderShellPage({ mode: 'loading' }));
    }

    if (requestUrl.pathname === '/error') {
      return appPageResponse(request, renderShellPage({
        mode: 'error',
        message: requestUrl.searchParams.get('message') || undefined,
        retryMode: requestUrl.searchParams.get('retry') === 'protected-playback'
          ? 'protected-playback'
          : 'spotify'
      }));
    }

    return new Response('Not found', { status: 404 });
  };
}

module.exports = {
  PAGE_CSP,
  SILENT_WAV,
  appPageResponse,
  createSilentWav,
  createLocalProtocolHandler,
  mediaResponse,
  methodNotAllowed,
  parseByteRange
};
