import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function num(value) {
  if (value == null || value === 'max') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function containerKind() {
  if (fs.existsSync('/run/.containerenv')) return 'Podman';
  if (fs.existsSync('/.dockerenv')) return 'Docker';
  return null;
}

// Memory limit of this container, if the kernel exposes one.
export function memoryLimit() {
  try {
    const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
    if (constrained && constrained < 2 ** 53) return { bytes: constrained, source: 'cgroup' };
  } catch {
    /* fall through to the file lookups */
  }
  const v2 = num(read('/sys/fs/cgroup/memory.max'));
  if (v2 && v2 > 0) return { bytes: v2, source: 'cgroup v2' };
  const v1 = num(read('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  if (v1 && v1 > 0 && v1 < 2 ** 53) return { bytes: v1, source: 'cgroup v1' };
  return null;
}

// ------------------------------------------------------------ capabilities

const CAP_NAMES = [
  'CHOWN', 'DAC_OVERRIDE', 'DAC_READ_SEARCH', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID',
  'SETPCAP', 'LINUX_IMMUTABLE', 'NET_BIND_SERVICE', 'NET_BROADCAST', 'NET_ADMIN', 'NET_RAW',
  'IPC_LOCK', 'IPC_OWNER', 'SYS_MODULE', 'SYS_RAWIO', 'SYS_CHROOT', 'SYS_PTRACE', 'SYS_PACCT',
  'SYS_ADMIN', 'SYS_BOOT', 'SYS_NICE', 'SYS_RESOURCE', 'SYS_TIME', 'SYS_TTY_CONFIG', 'MKNOD',
  'LEASE', 'AUDIT_WRITE', 'AUDIT_CONTROL', 'SETFCAP', 'MAC_OVERRIDE', 'MAC_ADMIN', 'SYSLOG',
  'WAKE_ALARM', 'BLOCK_SUSPEND', 'AUDIT_READ', 'PERFMON', 'BPF', 'CHECKPOINT_RESTORE',
];

function decodeCaps(hex) {
  if (!hex) return null;
  try {
    const bits = BigInt('0x' + hex);
    const names = [];
    for (let i = 0; i < CAP_NAMES.length; i++) {
      if ((bits >> BigInt(i)) & 1n) names.push(CAP_NAMES[i]);
    }
    return { count: names.length, total: CAP_NAMES.length, names };
  } catch {
    return null;
  }
}

function parseStatus() {
  const raw = read('/proc/self/status');
  if (!raw) return {};
  const out = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

// ------------------------------------------------------------ user namespace

function userNamespace() {
  const raw = read('/proc/self/uid_map');
  if (!raw) return null;
  const maps = raw
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((p) => p.length === 3 && p.every(Number.isFinite));
  if (!maps.length) return null;

  const identity = maps.length === 1 && maps[0][0] === 0 && maps[0][1] === 0 && maps[0][2] >= 4294967295;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  let hostUid = null;
  for (const [inside, outside, count] of maps) {
    if (uid >= inside && uid < inside + count) {
      hostUid = outside + (uid - inside);
      break;
    }
  }
  return { identity, uid, hostUid, ranges: maps.slice(0, 3).map((m) => m.join(' ')) };
}

// ------------------------------------------------------------ cgroups

function cgroupV2() {
  const base = '/sys/fs/cgroup';
  if (!fs.existsSync(path.join(base, 'cgroup.controllers'))) return null;
  const file = (name) => read(path.join(base, name));

  const events = {};
  for (const line of (file('memory.events') || '').split('\n')) {
    const [k, v] = line.split(' ');
    if (k) events[k] = num(v);
  }
  const stat = {};
  for (const line of (file('cpu.stat') || '').split('\n')) {
    const [k, v] = line.split(' ');
    if (k) stat[k] = num(v);
  }
  let cpus = null;
  const cpuMax = file('cpu.max');
  if (cpuMax) {
    const [quota, period] = cpuMax.split(' ');
    if (quota !== 'max' && Number(period) > 0) cpus = Number(quota) / Number(period);
  }
  return {
    version: 2,
    memory: { max: num(file('memory.max')), current: num(file('memory.current')), peak: num(file('memory.peak')) },
    oomKills: events.oom_kill ?? null,
    cpu: { cpus, throttledPeriods: stat.nr_throttled ?? null },
    pids: { max: num(file('pids.max')), current: num(file('pids.current')) },
  };
}

function cgroupV1() {
  const mem = '/sys/fs/cgroup/memory';
  if (!fs.existsSync(mem)) return null;
  const max = num(read(path.join(mem, 'memory.limit_in_bytes')));
  return {
    version: 1,
    memory: {
      max: max && max < 2 ** 53 ? max : null,
      current: num(read(path.join(mem, 'memory.usage_in_bytes'))),
      peak: num(read(path.join(mem, 'memory.max_usage_in_bytes'))),
    },
    oomKills: null,
    cpu: { cpus: null, throttledPeriods: null },
    pids: { max: null, current: null },
  };
}

// ------------------------------------------------------------ filesystem

function writable(dir) {
  const probe = path.join(dir, '.liftoff-probe-' + process.pid);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function disk(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

function countEntries(dir, pattern) {
  try {
    return fs.readdirSync(dir).filter((n) => pattern.test(n)).length;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ public API

export function isolationReport() {
  const status = parseStatus();
  const seccompMode = status.Seccomp != null ? Number(status.Seccomp) : null;
  return {
    container: containerKind(),
    hostname: os.hostname(),
    userNamespace: userNamespace(),
    processesVisible: countEntries('/proc', /^\d+$/),
    pid: process.pid,
    seccomp: seccompMode === 2 ? 'filter' : seccompMode === 1 ? 'strict' : seccompMode === 0 ? 'off' : null,
    noNewPrivs: status.NoNewPrivs != null ? status.NoNewPrivs === '1' : null,
    capabilities: decodeCaps(status.CapEff),
    cgroup: cgroupV2() || cgroupV1(),
    openFiles: countEntries('/proc/self/fd', /^\d+$/),
    threads: status.Threads != null ? Number(status.Threads) : null,
    filesystem: {
      appDirWritable: writable(process.cwd()),
      tmpWritable: writable(os.tmpdir()),
      disk: disk(process.cwd()),
    },
  };
}

const SYSTEM_ENV = new Set([
  'PATH', 'HOME', 'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL', 'TERM', '_', 'LANG', 'USER', 'LOGNAME', 'SHELL',
  'YARN_VERSION', 'NODE_VERSION', 'NODE', 'INIT_CWD', 'EDITOR', 'container', 'TZ',
]);

// Names only. Values are never read into the response.
export function appEnvNames() {
  return Object.keys(process.env)
    .filter((k) => !SYSTEM_ENV.has(k) && !/^(npm_|XDG_|LC_)/.test(k))
    .sort();
}
