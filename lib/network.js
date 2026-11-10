import dns from 'node:dns/promises';

// Fixed list on purpose. Callers cannot choose a target, so this can't be used to reach other hosts.
const TARGETS = [
  { id: 'dns', label: 'DNS resolver', kind: 'dns', host: 'example.com' },
  { id: 'npm', label: 'npm registry', kind: 'http', url: 'https://registry.npmjs.org/-/ping' },
  { id: 'github', label: 'GitHub', kind: 'http', url: 'https://api.github.com/' },
  { id: 'docker', label: 'Docker Hub registry', kind: 'http', url: 'https://registry-1.docker.io/v2/' },
];

const TIMEOUT_MS = 4000;

function errorCode(err) {
  return (err && (err.cause?.code || err.code)) || (err && err.name) || 'ERROR';
}

async function probe(target) {
  const started = performance.now();
  try {
    if (target.kind === 'dns') {
      const result = await dns.lookup(target.host);
      return { ok: true, ms: performance.now() - started, detail: 'resolved ' + target.host + ' to ' + result.address };
    }
    const res = await fetch(target.url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel();
    // Any HTTP answer proves the route works. Docker Hub answers 401 here by design.
    return { ok: res.status < 500, ms: performance.now() - started, detail: 'HTTP ' + res.status };
  } catch (err) {
    return { ok: false, ms: performance.now() - started, detail: errorCode(err) };
  }
}

export async function runProbes() {
  const results = await Promise.all(
    TARGETS.map(async (t) => {
      const r = await probe(t);
      return { id: t.id, label: t.label, ok: r.ok, ms: Math.round(r.ms), detail: r.detail };
    }),
  );
  return { ranAt: Date.now(), results };
}
