'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const pkg = require('./package.json');

// The platform decides the port. Honour PORT if it is set, otherwise use 3000.
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const startedAt = Date.now();

// ---------------------------------------------------------------- helpers

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

const build = readJson(path.join(__dirname, 'build-info.json'));

function containerKind() {
  if (fs.existsSync('/run/.containerenv')) return 'Podman';
  if (fs.existsSync('/.dockerenv')) return 'Docker';
  return null;
}

// Memory limit of this container, if the kernel exposes one.
function memoryLimit() {
  try {
    const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
    if (constrained && constrained < 2 ** 53) return { bytes: constrained, source: 'cgroup' };
  } catch {
    /* fall through to the file lookups */
  }
  const v2 = readText('/sys/fs/cgroup/memory.max');
  if (v2 && v2 !== 'max' && Number(v2) > 0) return { bytes: Number(v2), source: 'cgroup v2' };
  const v1 = readText('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (v1 && Number(v1) > 0 && Number(v1) < 2 ** 53) return { bytes: Number(v1), source: 'cgroup v1' };
  return null;
}

// ---------------------------------------------------------------- sampling

const HISTORY_SIZE = 120; // two minutes at one sample per second
const history = [];
const LOOP_RESOLUTION_MS = 20;
const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loop.enable();

let lastCpu = process.cpuUsage();
let lastTick = process.hrtime.bigint();

function sample() {
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const elapsedMicros = Number(now - lastTick) / 1000;
  const usedMicros = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
  const cpuPct = elapsedMicros > 0 ? (usedMicros / elapsedMicros) * 100 : 0;
  lastCpu = cpu;
  lastTick = now;

  const mem = process.memoryUsage();
  history.push({
    t: Date.now(),
    rss: mem.rss,
    heap: mem.heapUsed,
    cpu: Math.round(cpuPct * 10) / 10,
    // The histogram includes the sampling interval itself, so remove it to show real delay.
    lag: Math.round(Math.max(0, loop.percentile(99) / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10,
  });
  loop.reset();
  if (history.length > HISTORY_SIZE) history.shift();
}

sample();
setInterval(sample, 1000);

// ---------------------------------------------------------------- checks

const HEADER_ALLOWLIST = [
  'host',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-server',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
  'accept-encoding',
  'user-agent',
];

function proxyHeaders(req) {
  const seen = {};
  for (const name of HEADER_ALLOWLIST) {
    if (req.headers[name]) seen[name] = String(req.headers[name]);
  }
  return seen;
}

function buildChecks(req) {
  const h = req.headers;
  const deps = pkg.dependencies || {};
  const depList = Object.entries(deps).map(([name, version]) => name + ' ' + version);
  const kind = containerKind();
  const viaProxy = Boolean(h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-forwarded-server'] || h['via']);
  const hostname = os.hostname();

  const checks = [
    {
      id: 'source',
      label: 'Source unpacked',
      state: 'pass',
      detail: pkg.name + ' ' + pkg.version + ' is running from the uploaded files.',
    },
    {
      id: 'detect',
      label: 'Framework signal',
      state: 'pass',
      detail: 'package.json lists ' + (depList.join(', ') || 'no dependencies') + '. The wizard reads this file to choose defaults.',
    },
  ];

  if (!build) {
    checks.push({
      id: 'build',
      label: 'Built separately',
      state: 'wait',
      detail: 'No build record found. The build step may not have run yet.',
    });
  } else if (build.host && build.host !== hostname) {
    checks.push({
      id: 'build',
      label: 'Built separately',
      state: 'pass',
      detail: 'Built in ' + build.host + ', now running in ' + hostname + '.',
    });
  } else {
    checks.push({
      id: 'build',
      label: 'Built separately',
      state: 'wait',
      detail: 'Build and runtime report the same hostname (' + hostname + ').',
    });
  }

  checks.push(
    kind
      ? {
          id: 'container',
          label: 'Running in a container',
          state: 'pass',
          detail: kind + ' container ' + hostname + ' on Node ' + process.version + '.',
        }
      : {
          id: 'container',
          label: 'Running in a container',
          state: 'wait',
          detail: 'No container marker found. This process may be running directly on a host.',
        },
  );

  checks.push(
    viaProxy
      ? {
          id: 'proxy',
          label: 'Behind the proxy',
          state: 'pass',
          detail: 'This request arrived with forwarding headers added by the web server.',
        }
      : {
          id: 'proxy',
          label: 'Behind the proxy',
          state: 'wait',
          detail: 'No forwarding headers on this request. It may have reached the app directly.',
        },
  );

  return checks;
}

// ---------------------------------------------------------------- app

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/api/stats', (req, res) => {
  const mem = process.memoryUsage();
  const limit = memoryLimit();
  res.set('Cache-Control', 'no-store');
  res.json({
    now: Date.now(),
    startedAt,
    app: { name: pkg.name, version: pkg.version },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform + ' ' + process.arch,
      pid: process.pid,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      hostname: os.hostname(),
      container: containerKind(),
      cpus: os.cpus().length,
      nodeEnv: process.env.NODE_ENV || 'not set',
      port: PORT,
    },
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      limit: limit ? limit.bytes : null,
      limitSource: limit ? limit.source : null,
    },
    build,
    checks: buildChecks(req),
    proxy: proxyHeaders(req),
    history,
  });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[liftoff] request failed:', err);
  res.status(500).type('text/plain').send('Something went wrong');
});

const server = app.listen(PORT, HOST, () => {
  console.log('[liftoff] ' + pkg.version + ' listening on ' + HOST + ':' + PORT + ' (Node ' + process.version + ')');
});

function shutdown(signal) {
  console.log('[liftoff] ' + signal + ' received, closing');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[liftoff] unhandled rejection:', reason));
