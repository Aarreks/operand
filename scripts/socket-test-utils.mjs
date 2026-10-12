import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

export async function connect(url) {
  const socket = io(url, { transports: ['websocket'], reconnection: false, timeout: 3000 });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  }).catch((error) => { socket.disconnect(); throw error; });
  return socket;
}

export async function ack(socket, event, payload) {
  const args = payload === undefined ? [] : [payload];
  const result = await socket.timeout(3000).emitWithAck(event, ...args);
  assert.equal(result.ok, true, `${event}: ${result.error}`);
  return result;
}

export function update(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room:update', listener);
      reject(new Error('Timed out waiting for room update'));
    }, 3000);
    function listener(room) {
      if (!predicate(room)) return;
      clearTimeout(timer);
      socket.off('room:update', listener);
      resolve(room);
    }
    socket.on('room:update', listener);
  });
}

export async function eventually(predicate) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Condition did not become true within 3 seconds');
}
