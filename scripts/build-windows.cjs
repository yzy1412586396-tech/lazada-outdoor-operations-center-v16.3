// NSIS aborts while including paths over 260 characters. pnpm's transitive
// package directories can exceed that limit even in otherwise short projects.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const builderRequire = createRequire(require.resolve('electron-builder'));
const libEntry = builderRequire.resolve('app-builder-lib');
const paths = require(path.join(path.dirname(libEntry), 'util/pathManager.js'));
const templateRoot = paths.getTemplatePath('');
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'lazada-nsis-'));
fs.cpSync(templateRoot, staging, { recursive: true });
paths.getTemplatePath = (file) => path.join(staging, file);
process.on('exit', () => fs.rmSync(staging, { recursive: true, force: true }));
if (process.platform === 'darwin') {
  process.env.LC_ALL = 'en_US.UTF-8';
  process.env.LANG = 'en_US.UTF-8';
}
process.argv = [process.execPath, require.resolve('electron-builder/out/cli/cli.js'),
  '--win', 'nsis', '--x64', '--publish', 'never', ...process.argv.slice(2)];
require('electron-builder/out/cli/cli.js');
