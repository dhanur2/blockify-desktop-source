function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const MAX_ERROR_MESSAGE_LENGTH = 200;
const SHELL_PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

function renderShellPage(options = {}) {
  const mode = options.mode === 'error' ? 'error' : 'loading';
  const isError = mode === 'error';
  const heading = isError ? 'Spotify could not be reached' : 'Preparing Spotify';
  const detail = isError
    ? escapeHtml(String(options.message || 'Check your connection, then try again.').slice(
      0,
      MAX_ERROR_MESSAGE_LENGTH
    ))
    : 'Setting up protected playback. The first launch can take a little longer.';
  const retryProtectedPlayback = isError && options.retryMode === 'protected-playback';
  const actionHref = retryProtectedPlayback
    ? 'blockify://app/retry-protected-playback'
    : 'https://open.spotify.com/';
  const actionLabel = retryProtectedPlayback ? 'Restart and try again' : 'Try again';
  const action = isError
    ? `<a class="action" href="${actionHref}">${actionLabel}</a>`
    : '<div class="pulse" aria-label="Loading"><i></i><i></i><i></i></div>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${SHELL_PAGE_CSP}">
  <title>Blockify</title>
  <link rel="stylesheet" href="blockify://app/shell.css">
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">B</div>
    <h1>${heading}</h1>
    <p>${detail}</p>
    ${action}
  </main>
</body>
</html>`;
}

module.exports = { MAX_ERROR_MESSAGE_LENGTH, SHELL_PAGE_CSP, escapeHtml, renderShellPage };
