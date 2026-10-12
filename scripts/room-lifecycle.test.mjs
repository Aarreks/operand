import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { server, roomDiagnostics } from '../server.js';
import { ack, connect, eventually, update } from './socket-test-utils.mjs';

let url;
let clients = [];
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  clients.forEach((socket) => socket.disconnect());
  clients = [];
  await eventually(() => roomDiagnostics().players === 0);
  assert.deepEqual(roomDiagnostics(), { rooms: 0, players: 0, roundTimers: 0, shotTimers: 0 });
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
async function pair() {
  const a = await connect(url);
  clients.push(a);
  const b = await connect(url);
  clients.push(b);
  const { room } = await ack(a, 'room:create', { name: 'Ada' });
  await ack(b, 'room:join', { roomId: room.id, name: 'Grace' });
  return { a, b, id: room.id };
}
async function playing(a, b) {
  await ack(a, 'game:ready');
  const started = update(a, (room) => room.state === 'playing');
  await ack(b, 'game:ready');
  const state = await started;
  assert.equal(roomDiagnostics().roundTimers, 1);
  return state;
}

test('switching during a race finishes the old room, cancels timers and deletes it when the last player leaves', async () => {
  const { a, b, id } = await pair();
  await playing(a, b);
  const opponentLeft = update(b, (room) => room.id === id && room.finishedReason === 'opponent_left');
  const next = await ack(a, 'room:create', { name: 'Ada' });
  const old = await opponentLeft;
  assert.equal(old.state, 'finished');
  assert.equal(old.players.length, 1);
  assert.equal(old.players[0].problem, null);
  assert.equal(roomDiagnostics().roundTimers, 0);
  await ack(b, 'room:join', { roomId: next.room.id, name: 'Grace' });
  assert.equal(roomDiagnostics().rooms, 1);
  await playing(a, b);
});

test('switching alone repeatedly does not retain abandoned rooms; same-room joins do not remove the player', async () => {
  const { a, b } = await pair();
  await ack(b, 'room:leave');
  for (let i = 0; i < 25; i++) {
    const { room } = await ack(a, 'room:create', { name: 'Ada' });
    await ack(a, 'room:join', { roomId: room.id, name: 'Updated' });
    assert.deepEqual(roomDiagnostics(), { rooms: 1, players: 1, roundTimers: 0, shotTimers: 0 });
  }
});

test('a rejected switch to a full room preserves the current room', async () => {
  const { a, b, id } = await pair();
  const c = await connect(url);
  clients.push(c);
  const original = await ack(c, 'room:create', { name: 'Third' });
  const rejected = await c.timeout(3000).emitWithAck('room:join', { roomId: id });
  assert.equal(rejected.ok, false);
  const same = await ack(c, 'room:join', { roomId: original.room.id, name: 'Third' });
  assert.equal(same.room.players.length, 1);
  assert.deepEqual(roomDiagnostics(), { rooms: 2, players: 3, roundTimers: 0, shotTimers: 0 });
  await playing(a, b);
});

test('disconnecting mid-race notifies the survivor and removes the room after the second disconnect', async () => {
  const { a, b, id } = await pair();
  await playing(a, b);
  const finished = update(b, (room) => room.id === id && room.finishedReason === 'opponent_left');
  a.disconnect();
  await finished;
  assert.deepEqual(roomDiagnostics(), { rooms: 1, players: 1, roundTimers: 0, shotTimers: 0 });
  b.disconnect();
  await eventually(() => roomDiagnostics().rooms === 0);
});

test('switching while a shot-expiry timer is active clears that timer too', async () => {
  const { a, b } = await pair();
  let state = await playing(a, b);
  const solve = (problem) => {
    const [left, operator, right] = problem.text.split(' ');
    const x = Number(left); const y = Number(right);
    return operator === '+' ? x + y : operator === '-' ? x - y : operator === '×' ? x * y : x / y;
  };
  // Only Ada earns wheel weight, so she is the selected target; Grace finalizes.
  for (let score = 1; score <= 9; score++) {
    const next = update(a, (room) => room.players.find((p) => p.isYou)?.score === score);
    await ack(a, 'answer:update', { answer: solve(state.players.find((p) => p.isYou).problem) });
    state = await next;
  }
  assert.ok(state.wheel);
  // The public snapshot exposes Grace's challenge only to Grace.
  const finalizer = (await ack(b, 'room:join', { roomId: state.id })).room;
  const challenge = finalizer.players.find((p) => p.isYou).shotChallenge;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, state.wheel.endsAt - Date.now()) + 10));
  await ack(b, 'answer:update', { answer: solve(challenge) });
  assert.equal(roomDiagnostics().shotTimers, 1);
  await ack(a, 'room:create', { name: 'Ada' });
  assert.equal(roomDiagnostics().shotTimers, 0);
  assert.equal(roomDiagnostics().roundTimers, 0);
});
