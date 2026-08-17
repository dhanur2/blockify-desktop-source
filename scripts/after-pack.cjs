const fs = require('node:fs');
const path = require('node:path');
const {
  flipFuses,
  FuseVersion,
  FuseV1Options
} = require('@electron/fuses');

module.exports = async function afterPack(context) {
  const extensions = { darwin: '.app', linux: '', mas: '.app', win32: '.exe' };
  const extension = extensions[context.electronPlatformName];
  if (extension === undefined || context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas') {
    throw new Error(`Unsupported Blockify packaging platform: ${context.electronPlatformName}`);
  }

  const executable = path.join(context.appOutDir, `Blockify${extension}`);
  const staleDevelopmentSignature = path.join(context.appOutDir, 'electron.exe.sig');
  fs.rmSync(staleDevelopmentSignature, { force: true });

  await flipFuses(executable, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // CastLabs ECS does not ship browser_v8_context_snapshot.bin on Windows.
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    // CastLabs EVS supports one exact hardened fuse set. This fuse must remain
    // enabled for free EVS signing; Blockify independently rejects file://
    // navigation, popup, and external-open targets.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    [FuseV1Options.WasmTrapHandlers]: true
  });
};
