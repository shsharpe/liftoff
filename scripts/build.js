// Runs in the ephemeral build container (`npm run build`), after `npm install`.
// Uses only Node built-ins, so the build can't fail on a missing toolchain.
//
// It records where and when the build happened (the running app compares that with
// its own hostname to show build and runtime are separate), inventories what npm
// installed, and precompresses the static assets so the server can serve them as-is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { readGit } from '../lib/git.js';

const started = performance.now();
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

// ------------------------------------------------------------ dependency inventory

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue; // nested packages are counted on their own
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    } catch {
      /* broken symlink or race, skip */
    }
  }
  return total;
}

function collectPackages(nodeModules, found) {
  if (!fs.existsSync(nodeModules)) return;
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const dirs = entry.name.startsWith('@')
      ? fs.readdirSync(path.join(nodeModules, entry.name), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(nodeModules, entry.name, e.name))
      : [path.join(nodeModules, entry.name)];

    for (const dir of dirs) {
      const manifest = path.join(dir, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      try {
        const p = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        const license = typeof p.license === 'string' ? p.license : p.license?.type || 'unknown';
        found.push({ name: p.name || path.basename(dir), version: p.version || '?', license, bytes: dirSize(dir) });
      } catch {
        /* unreadable manifest, skip */
      }
      collectPackages(path.join(dir, 'node_modules'), found);
    }
  }
}

function inventory() {
  const found = [];
  collectPackages(path.join(root, 'node_modules'), found);
  if (!found.length) return null;

  const licenses = {};
  for (const p of found) licenses[p.license] = (licenses[p.license] || 0) + 1;
  const topLicenses = Object.entries(licenses).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return {
    count: found.length,
    bytes: found.reduce((sum, p) => sum + p.bytes, 0),
    largest: found.sort((a, b) => b.bytes - a.bytes).slice(0, 8).map(({ name, version, bytes }) => ({ name, version, bytes })),
    licenses: topLicenses.map(([name, count]) => ({ name, count })),
  };
}

// ------------------------------------------------------------ asset precompression

const COMPRESSIBLE = /\.(html|css|js|svg|json)$/;

function precompress() {
  const assets = [];
  for (const file of fs.readdirSync(publicDir)) {
    if (!COMPRESSIBLE.test(file)) continue;
    const full = path.join(publicDir, file);
    const raw = fs.readFileSync(full);
    const br = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
    });
    const gz = zlib.gzipSync(raw, { level: 9 });
    fs.writeFileSync(full + '.br', br);
    fs.writeFileSync(full + '.gz', gz);
    assets.push({ file, raw: raw.length, br: br.length, gz: gz.length });
  }
  return assets.sort((a, b) => b.raw - a.raw);
}

// ------------------------------------------------------------ record

const assets = precompress();
const info = {
  builtAt: new Date().toISOString(),
  host: os.hostname(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  packageManager: (process.env.npm_config_user_agent || 'npm').split(' ')[0],
  git: readGit(root),
  inventory: inventory(),
  assets,
  durationMs: 0,
};
info.durationMs = Math.round(performance.now() - started);

fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');

const rawTotal = assets.reduce((s, a) => s + a.raw, 0);
const brTotal = assets.reduce((s, a) => s + a.br, 0);
console.log(
  '[liftoff] build on ' + info.host + ' with Node ' + info.node + ': ' +
    (info.inventory ? info.inventory.count + ' packages, ' : '') +
    assets.length + ' assets ' + rawTotal + ' -> ' + brTotal + ' bytes (brotli), ' + info.durationMs + ' ms',
);
