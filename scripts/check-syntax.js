const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function javascriptFiles(directory) {
  const entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return javascriptFiles(relative);
    }
    return /\.(?:c?js)$/u.test(entry.name) ? [relative] : [];
  });
}

const files = [
  ...javascriptFiles('src'),
  ...javascriptFiles('scripts'),
  'electron-builder.config.cjs',
  'dist/preload.cjs'
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
