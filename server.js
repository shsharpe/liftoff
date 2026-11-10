import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

import { readGit } from './lib/git.js';
import { probeDatabase } from './lib/data.js';
import { runProbes } from './lib/network.js';
import * as requestLog from './lib/requestlog.js';
import { startSampler, samplesSince } from './lib/sampler.js';
import { appEnvNames, containerKind, isolationReport, memoryLimit } from './lib/system.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch {
    return null;
  }
};

const pkg = readJson('package.json');
const build = readJson('build-info.json');
const git = build?.git || readGit(root);

// The platform decides the port. Honour PORT if it is set, otherwise use 3000.
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const startedAt = Date.now();

// Optional switches, all set from the App Env tab.
const PASSCODE = process.env.LIFTOFF_PASSCODE || '';
const CRASH_ENABLED = /^(1|on|true|yes)$/i.test(process.env.DEMO_CRASH || '');
const BANNER = (process.env.DEMO_BANNER || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);

const digest = (s) => crypto.createHash('sha256').update(s).digest();
const passcodeDigest = PASSCODE ? digest(PASSCODE) : null;

const FRAMEWORKS = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@nestjs/core', 'NestJS'], ['@remix-run/node', 'Remix'],
  ['@sveltejs/kit', 'SvelteKit'], ['fastify', 'Fastify'], ['express', 'Express'], ['koa', 'Koa'], ['hono', 'Hono'],
];

function detectFramework() {
  const deps = { ...(pkg?.devDependencies || {}), ...(pkg?.dependencies || {}) };
  for (const [name, label] of FRAMEWORKS) {
    if (deps[name]) return { label, version: String(deps[name]).replace(/^[\^~]/, ''), others: Object.keys(pkg.dependencies || {}).length - 1 };
  }
  return null;
}

// ------------------------------------------------------------ app

const app = Fastify({
  trustProxy: true,
  disableRequestLogging: true, // requests are logged once, below, and polling is left out
  logger: {
    level: 'info',
    timestamp: () => ',"time":"' + new Date().toISOString() + '"',
  },
});

await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  // HSTS belongs to the domain, not to one app on it, and there's a window before AutoSSL finishes.
  strictTransportSecurity: false,
  referrerPolicy: { policy: 'no-referrer' },
});

await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

// Passcode gate for everything under /api, except the check that tells the page whether one is needed.
app.addHook('onRequest', async (req, reply) => {
  if (!passcodeDigest) return;
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/') || url === '/api/gate') return;
  const supplied = String(req.headers['x-liftoff-passcode'] || '');
  if (!crypto.timingSafeEqual(digest(supplied), passcodeDigest)) {
    return reply.code(401).send({ error: 'passcode_required' });
  }
});

// One structured line per meaningful request. The page's own GET polling is hidden.
app.addHook('onResponse', async (req, reply) => {
  const url = req.url.split('?')[0];
  if (/\.(css|js|svg|ico|br|gz|map|woff2?)$/.test(url)) return;
  if (req.method === 'GET' && req.headers['x-liftoff-ui'] === '1') return;
  const entry = {
    t: Date.now(),
    method: req.method,
    path: url,
    status: reply.statusCode,
    ms: Math.round(reply.elapsedTime * 10) / 10,
    via: req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] ? 'proxy' : 'direct',
  };
  requestLog.record(entry);
  req.log.info(entry, 'request');
});

// ------------------------------------------------------------ routes

app.get('/healthz', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { ok: true, uptimeSeconds: Math.round(process.uptime()) };
});

app.get('/api/gate', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { required: Boolean(passcodeDigest) };
});

function buildChecks(req) {
  const h = req.headers;
  const hostname = os.hostname();
  const kind = containerKind();
  const fw = detectFramework();
  const viaProxy = Boolean(h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-forwarded-server'] || h['via']);

  const source = git
    ? 'Deployed from Git commit ' + git.commit.slice(0, 7) + (git.branch ? ' on ' + git.branch : '') + '.'
    : pkg.name + ' ' + pkg.version + ' is running from the uploaded files.';

  const checks = [
    { id: 'source', label: 'Source unpacked', state: 'pass', detail: source },
    {
      id: 'detect',
      label: 'Framework signal',
      state: 'pass',
      detail: fw
        ? fw.label + ' ' + fw.version + ' in package.json, plus ' + fw.others + ' other dependencies.'
        : 'No known framework in package.json. The app would deploy without suggested defaults.',
    },
  ];

  if (!build) {
    checks.push({ id: 'build', label: 'Built separately', state: 'wait', detail: 'No build record found. The build step may not have run yet.' });
  } else if (build.host && build.host !== hostname) {
    checks.push({ id: 'build', label: 'Built separately', state: 'pass', detail: 'Built in ' + build.host + ', now running in ' + hostname + '.' });
  } else {
    checks.push({ id: 'build', label: 'Built separately', state: 'wait', detail: 'Build and runtime report the same hostname (' + hostname + ').' });
  }

  checks.push(
    kind
      ? { id: 'container', label: 'Running in a container', state: 'pass', detail: kind + ' container ' + hostname + ' on Node ' + process.version + '.' }
      : { id: 'container', label: 'Running in a container', state: 'wait', detail: 'No container marker found. This process may be running directly on a host.' },
  );

  checks.push(
    viaProxy
      ? { id: 'proxy', label: 'Behind the proxy', state: 'pass', detail: 'This request arrived with forwarding headers added by the web server.' }
      : { id: 'proxy', label: 'Behind the proxy', state: 'wait', detail: 'No forwarding headers on this request. It may have reached the app directly.' },
  );

  return checks;
}

const HEADER_ALLOWLIST = [
  'host', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-server', 'x-forwarded-proto',
  'x-real-ip', 'via', 'accept-encoding', 'user-agent',
];

app.get('/api/stats', async (req, reply) => {
  const mem = process.memoryUsage();
  const limit = memoryLimit();
  const proxy = {};
  for (const name of HEADER_ALLOWLIST) if (req.headers[name]) proxy[name] = String(req.headers[name]);

  reply.header('Cache-Control', 'no-store');
  return {
    now: Date.now(),
    startedAt,
    app: { name: pkg.name, version: pkg.version },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform + ' ' + process.arch,
      pid: process.pid,
      hostname: os.hostname(),
      container: containerKind(),
      cpus: os.cpus().length,
      nodeEnv: process.env.NODE_ENV || 'not set',
      port: PORT,
      framework: detectFramework(),
    },
    git,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      limit: limit ? limit.bytes : null,
      limitSource: limit ? limit.source : null,
    },
    build: build ? { builtAt: build.builtAt, host: build.host, node: build.node, packageManager: build.packageManager } : null,
    checks: buildChecks(req),
    proxy,
    env: { names: appEnvNames() },
    demo: { banner: BANNER, crashEnabled: CRASH_ENABLED },
    history: samplesSince(req.query.since),
  };
});

app.get('/api/isolation', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  return isolationReport();
});

app.get('/api/requests', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { entries: requestLog.recent(30) };
});

app.get('/api/dependencies', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  const direct = Object.entries(pkg.dependencies || {}).map(([name, wanted]) => {
    let installed = null;
    try {
      installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {
      /* not installed */
    }
    return { name, wanted, installed };
  });
  return {
    direct,
    inventory: build?.inventory || null,
    assets: build?.assets || null,
    buildMs: build?.durationMs ?? null,
  };
});

app.get('/api/data', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  return probeDatabase();
});

app.post('/api/network', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  return runProbes();
});

app.post('/api/marker', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
  const id = crypto.randomBytes(3).toString('hex');
  req.log.info({ marker: id }, 'LIFTOFF MARKER ' + id);
  reply.header('Cache-Control', 'no-store');
  return { id };
});

// Stops the process so the platform's recovery can be watched. Off unless DEMO_CRASH is set.
app.post('/api/demo/crash', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async (req, reply) => {
  if (!CRASH_ENABLED) {
    return reply.code(403).send({ error: 'disabled', hint: 'Set DEMO_CRASH=on in App Env, then restart the app.' });
  }
  req.log.warn({ pid: process.pid }, 'demo crash requested, exiting in 400 ms');
  setTimeout(() => process.exit(1), 400);
  reply.code(202);
  return { ok: true, pid: process.pid, startedAt };
});

await app.register(fastifyStatic, {
  root: path.join(root, 'public'),
  preCompressed: true,
  maxAge: '5m',
});

app.setNotFoundHandler((req, reply) => {
  reply.code(404).type('text/plain').send('Not found');
});

// ------------------------------------------------------------ lifecycle

startSampler();

async function shutdown(signal) {
  app.log.info('%s received, closing', signal);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => app.log.error({ reason: String(reason) }, 'unhandled rejection'));

await app.listen({ port: PORT, host: HOST });
app.log.info({ version: pkg.version, node: process.version, port: PORT, git: git?.commit?.slice(0, 7) ?? null }, 'liftoff started');
