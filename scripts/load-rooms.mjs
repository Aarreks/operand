import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { ack, connect, eventually } from './socket-test-utils.mjs';

const pairs = Number(process.env.LOAD_PAIRS || 25);
const switches = Number(process.env.LOAD_SWITCHES || 20);
assert.ok(Number.isInteger(pairs) && pairs > 0 && pairs <= 100);
assert.ok(Number.isInteger(switches) && switches > 0 && switches <= 100);
const child = fork(new URL('./server-harness.mjs', import.meta.url), [], {
  execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'inherit', 'ipc']
});
const clients = [];
const latency = [];
const responseTimeout = AbortSignal.timeout(60_000);
let inFlight = false;
async function metrics() {
  assert.equal(inFlight, false);
  inFlight = true;
  const response = once(child, 'message', { signal: responseTimeout });
  child.send('metrics');
  const [message] = await response;
  inFlight = false;
  return message.metrics;
}
async function timed(socket, event, payload) {
  const start = performance.now();
  const response = await ack(socket, event, payload);
  latency.push(performance.now() - start);
  return response;
}
const deadline = setTimeout(() => child.kill(), 60_000);
try {
  const [{ url }] = await once(child, 'message', { signal: responseTimeout });
  const before = await metrics();
  const paired = await Promise.all(Array.from({ length: pairs }, async () => {
    const a = await connect(url); clients.push(a);
    const b = await connect(url); clients.push(b);
    const { room } = await timed(a, 'room:create', { name: 'Load A' });
    await timed(b, 'room:join', { roomId: room.id, name: 'Load B' });
    await timed(a, 'game:ready'); await timed(b, 'game:ready');
    return { a, b };
  }));
  const loaded = await metrics();
  await Promise.all(paired.map(async ({ a, b }) => {
    for (let i = 0; i < switches; i++) {
      const { room } = await timed(a, 'room:create', { name: 'Load A' });
      await timed(b, 'room:join', { roomId: room.id, name: 'Load B' });
    }
  }));
  const afterSwitches = await metrics();
  clients.forEach((socket) => socket.disconnect());
  await eventually(async () => (await metrics()).players === 0);
  const afterDisconnect = await metrics();
  latency.sort((a, b) => a - b);
  const percentile = (p) => Number(latency[Math.ceil(latency.length * p) - 1].toFixed(2));
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, pairs, switches,
    acknowledgements: latency.length,
    ackMilliseconds: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) },
    snapshots: { before, loaded, afterSwitches, afterDisconnect }
  }, null, 2));
  assert.equal(afterDisconnect.rooms, 0, 'Abandoned rooms remain after disconnect');
  assert.equal(afterDisconnect.roundTimers, 0, 'Round timers remain after disconnect');
  assert.equal(afterDisconnect.shotTimers, 0, 'Shot timers remain after disconnect');
} finally {
  clearTimeout(deadline);
  clients.forEach((socket) => socket.disconnect());
  child.kill();
}
