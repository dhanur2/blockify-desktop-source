const path = require('node:path');
const { build } = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');

build({
  entryPoints: [path.join(projectRoot, 'src', 'preload', 'index.js')],
  outfile: path.join(projectRoot, 'dist', 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  minify: false,
  legalComments: 'none'
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
