import { monitorEventLoopDelay } from 'node:perf_hooks';

const HISTORY_SIZE = 120; // two minutes at one sample per second
const LOOP_RESOLUTION_MS = 20;

const history = [];
const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });

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

export function startSampler() {
  loop.enable();
  sample();
  return setInterval(sample, 1000);
}

// Samples newer than `since` (a millisecond timestamp). Without it, the whole window.
export function samplesSince(since) {
  const t = Number(since);
  return Number.isFinite(t) && t > 0 ? history.filter((s) => s.t > t) : history.slice();
}
