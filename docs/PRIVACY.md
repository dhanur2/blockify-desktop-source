# Privacy

Blockify Desktop loads Spotify Web directly in a persistent local Electron
profile. That profile can contain Spotify cookies, site storage, caches, and
protected-media component data. The application offers a menu action to clear
Spotify site data.

The code records bounded local diagnostics for operational failures. It does
not implement application telemetry, analytics, or a remote diagnostic upload.
Network requests needed to load Spotify and protected-media components go to
their respective providers under their own policies.

Do not commit user profiles, diagnostics, screenshots, logs, or credentials to
this repository.
