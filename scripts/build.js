'use strict';
// Runs in the ephemeral build container (`npm run build`).
// It records where and when the build happened. The running app later compares
// this with its own hostname, which shows that build and runtime are separate.
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');

const info = {
  builtAt: new Date().toISOString(),
  host: os.hostname(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  packageManager: (process.env.npm_config_user_agent || 'npm').split(' ')[0],
  publicFiles: fs.existsSync(publicDir) ? fs.readdirSync(publicDir).length : 0,
};

fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('[liftoff] build recorded on ' + info.host + ' with Node ' + info.node);
