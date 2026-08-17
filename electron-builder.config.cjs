const path = require('node:path');

module.exports = {
  appId: 'org.blockify.desktop',
  executableName: 'Blockify',
  productName: 'Blockify',
  copyright: 'Copyright (c) 2026 Blockify contributors',
  asar: true,
  npmRebuild: false,
  forceCodeSigning: false,
  extraMetadata: {
    author: { name: 'Blockify contributors' },
    blockifyReleaseChannel: 'community'
  },
  publish: null,
  artifactName: 'Blockify-${version}-${os}-${arch}.${ext}',
  directories: {
    output: 'release'
  },
  files: [
    'dist/preload.cjs',
    'src/main/**/*',
    'src/renderer/**/*',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'TRADEMARKS.md',
    'package.json'
  ],
  electronDownload: {
    mirror: 'https://github.com/castlabs/electron-releases/releases/download/'
  },
  afterPack: path.join(__dirname, 'scripts', 'after-pack.cjs'),
  win: {
    requestedExecutionLevel: 'asInvoker',
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    perMachine: false,
    shortcutName: 'Blockify',
    uninstallDisplayName: 'Blockify ${version}',
    license: 'LICENSE'
  }
};
