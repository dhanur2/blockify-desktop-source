# Building

Install Node.js 22.12–22.x and npm 10.x, then run `npm ci`.

- `npm run start` builds the preload bundle and launches the app.
- `npm run verify` builds the preload bundle, syntax-checks source, and runs the
  unit suite.
- `npm run pack` creates an unpacked local build.
- `npm run dist` creates a local Windows NSIS installer.

The CastLabs Electron dependency supports protected-media components. A local
development build is not a substitute for a distributor's signed production
release validation.
