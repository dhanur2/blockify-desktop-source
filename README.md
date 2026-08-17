# Blockify Desktop

Blockify Desktop is a community-maintained Electron shell for Spotify Web. It
uses an isolated preload bridge, page-world media-state observation, and a
session-scoped request filter to handle detected ad media locally.

## What this repository contains

This is a clean, source-only community export. It intentionally excludes:

- release binaries, signing identities, tokens, private keys, and local build
  caches;
- infrastructure, update hosts, SSH configuration, publisher accounts, and
  deployment automation;
- original extension archives and their assets.

Remote updates are disabled in this source distribution. Anyone distributing a
modified build must operate their own reviewed signing and update process.

## Quick start

Prerequisites: Node.js 22.12–22.x and npm 10.x.

```powershell
npm ci
npm run start
```

Run the source checks with:

```powershell
npm run verify
```

To create a local Windows NSIS package, run `npm run dist`. A distributor is
responsible for code-signing, rights review, and testing its own release.

## Security and privacy

The app opens `https://open.spotify.com/` in a persistent, isolated Electron
session. Spotify authentication data stays in the app's local Chromium profile.
See [Privacy](docs/PRIVACY.md), [Threat model](docs/THREAT_MODEL.md), and
[Security policy](SECURITY.md).

## License

Copyright (C) 2026 Blockify contributors. This project is source-available
under the [PolyForm Noncommercial License 1.0.0](LICENSE).

Commercial use, commercial distribution, and commercial services based on
this software require a separate written license from the licensor. This is
not an OSI-approved open-source license. See [NOTICE](NOTICE),
[third-party notices](THIRD_PARTY_NOTICES.md), and
[trademark guidance](TRADEMARKS.md).
