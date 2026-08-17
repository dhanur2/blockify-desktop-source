# Architecture

The main process owns the BrowserWindow, isolated Spotify session, custom local
protocols, permissions, navigation policy, and media-request filter. It exposes
only narrow IPC commands to the preload script.

The preload runs with context isolation and no Node integration. It observes
Spotify page DOM markers and requests mute state changes through validated IPC.

The page-world hook observes relevant JSON delivered through fetch and
WebSocket, extracts validated media identifiers for tracks marked as ads, and
publishes a bounded list through the DOM bridge. The main process redirects
only matching media requests to a generated one-second silent WAV response.

No remote update URL, publisher key, deployment credential, or release host is
part of this community source distribution.
