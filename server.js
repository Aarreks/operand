import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const ROUND_SECONDS = 120;
const MAX_PLAYERS = 2;
const WHEEL_SPIN_MS = 1200;
const SHOT_EVENT_MS = 2500;
const WHEEL_MIN_WEIGHT = 25;
const WHEEL_MIN_REMAINING_SECONDS = 15;
const INSTANCE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*'
  }
});

const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/r/:roomId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, instanceId: INSTANCE_ID, rooms: rooms.size });
});

app.get('/shot.mp3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'metal-pipe.mp3'));
});

io.on('connection', (socket) => {
  socket.on('room:create', ({ name }, ack) => {
    const roomId = createRoomId();
    joinRoom(socket, roomId, name, ack);
  });

  socket.on('room:join', ({ roomId, name }, ack) => {
    joinRoom(socket, normalizeRoomId(roomId), name, ack);
  });

  socket.on('game:ready', (ack) => {
    const room = getSocketRoom(socket);
    if (!room) {
      ack?.({ ok: false, error: 'Join a room first.' });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      ack?.({ ok: false, error: 'Player not found.' });
      return;
    }

    if (room.state === 'finished') {
      resetRoom(room);
    }

    player.ready = !player.ready;
    emitRoom(room);
    maybeStartRound(room);
    ack?.({ ok: true, ready: player.ready });
  });

  socket.on('answer:update', ({ answer }, ack) => {
    const room = getSocketRoom(socket);
    const player = room?.players.get(socket.id);

    if (!room || !player || room.state !== 'playing') {
      ack?.({ ok: false, error: 'No active game.' });
      return;
    }

    const numericAnswer = Number(answer);
    if (!Number.isFinite(numericAnswer)) {
      ack?.({ ok: true });
      return;
    }

    if (player.shotChallenge) {
      if (Date.now() < player.shotChallenge.readyAt || numericAnswer !== player.shotChallenge.problem.answer) {
        ack?.({ ok: true });
        return;
      }

      completeShotChallenge(room, player);
      emitRoom(room);
      ack?.({ ok: true });
      return;
    }

    const problem = player.problem;
    if (!problem || numericAnswer !== problem.answer) {
      ack?.({ ok: true });
      return;
    }

    advancePlayer(room, player);
    emitRoom(room);
    ack?.({ ok: true });
  });

  socket.on('game:restart', (ack) => {
    const room = getSocketRoom(socket);
    if (!room) {
      ack?.({ ok: false, error: 'Join a room first.' });
      return;
    }

    resetRoom(room);
    emitRoom(room);
    ack?.({ ok: true });
  });

  socket.on('room:leave', (ack) => {
    leaveRoom(socket);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    leaveRoom(socket, true);
  });
});

server.listen(PORT, () => {
  console.log(`Operand running on http://localhost:${PORT}`);
});

function joinRoom(socket, roomId, name, ack) {
  if (!roomId) {
    ack?.({ ok: false, error: 'Room link is missing.' });
    return;
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = makeRoom(roomId);
    rooms.set(roomId, room);
  }

  if (!room.players.has(socket.id) && room.players.size >= MAX_PLAYERS) {
    ack?.({ ok: false, error: 'This race already has two players.' });
    return;
  }

  const existingRoom = getSocketRoom(socket);
  if (existingRoom && existingRoom.id !== room.id) {
    existingRoom.players.delete(socket.id);
    socket.leave(existingRoom.id);
    emitRoom(existingRoom);
  }

  socket.join(room.id);
  socket.data.roomId = room.id;

  if (!room.players.has(socket.id)) {
    room.players.set(socket.id, makePlayer(socket.id, name, room));
  } else {
    room.players.get(socket.id).name = cleanName(name);
  }

  console.log(`join room=${room.id} players=${room.players.size} instance=${INSTANCE_ID}`);
  emitRoom(room);
  ack?.({ ok: true, room: publicRoom(room, socket.id) });
}

function leaveRoom(socket, disconnected = false) {
  const room = getSocketRoom(socket);
  if (!room) {
    return;
  }

  room.players.delete(socket.id);
  socket.leave(room.id);
  socket.data.roomId = null;

  if (room.players.size === 0) {
    clearRoomTimer(room);
    rooms.delete(room.id);
    return;
  }

  if (room.state === 'playing' || room.state === 'finished') {
    room.shot = null;
    room.wheel = null;
    finishRound(room, disconnected ? 'opponent_left' : 'opponent_left');
    return;
  }

  emitRoom(room);
}

function maybeStartRound(room) {
  if (room.state !== 'waiting' || room.players.size !== MAX_PLAYERS) {
    return;
  }

  const players = [...room.players.values()];
  if (!players.every((player) => player.ready)) {
    return;
  }

  room.state = 'playing';
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + ROUND_SECONDS * 1000;
  room.shot = null;
  room.wheel = null;

  players.forEach((player) => {
    player.score = 0;
    player.problemIndex = 0;
    player.ready = false;
    player.cycleWeight = 0;
    player.penaltyActive = false;
    player.penaltyReturnProblem = null;
    player.shotChallenge = null;
    player.problem = getProblem(room, 0);
  });

  clearRoomTimer(room);
  room.timer = setTimeout(() => finishRound(room, 'time'), ROUND_SECONDS * 1000);
  emitRoom(room);
}

function triggerShotCycle(room, markSeconds = 'live') {
  if (room.state !== 'playing' || room.wheel) {
    return;
  }

  const players = [...room.players.values()];
  if (players.length !== MAX_PLAYERS) {
    return;
  }

  const weights = players.map((player) => ({
    id: player.id,
    name: player.name,
    weight: player.cycleWeight
  }));
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
  const remainingSeconds = Math.ceil((room.endsAt - Date.now()) / 1000);
  const meetsRequirements = totalWeight >= WHEEL_MIN_WEIGHT && remainingSeconds >= WHEEL_MIN_REMAINING_SECONDS;
  if (!meetsRequirements) {
    return;
  }

  const target = pickWeightedPlayer(room.rng, players, weights, totalWeight);
  const finalizer = players.find((player) => player.id !== target.id);
  if (!finalizer) {
    return;
  }
  const challenge = makeNegativeProblem(room.rng);
  const wheelEndsAt = Date.now() + WHEEL_SPIN_MS;
  finalizer.shotChallenge = {
    targetId: target.id,
    problem: challenge,
    readyAt: wheelEndsAt
  };

  room.wheel = {
    id: `${Date.now()}-${markSeconds}`,
    skipped: false,
    markSeconds,
    weights,
    targetId: target.id,
    finalizerId: finalizer.id,
    targetName: target.name,
    finalizerName: finalizer.name,
    startedAt: Date.now(),
    endsAt: wheelEndsAt
  };

  players.forEach((player) => {
    player.cycleWeight = 0;
  });
  emitRoom(room);
}

function pickWeightedPlayer(rng, players, weights, totalWeight) {
  let roll = randomInt(rng, 1, totalWeight);
  for (const player of players) {
    const weight = weights.find((item) => item.id === player.id)?.weight || 0;
    roll -= weight;
    if (roll <= 0) {
      return player;
    }
  }

  return players[players.length - 1];
}

function completeShotChallenge(room, finalizer) {
  const challenge = finalizer.shotChallenge;
  if (!challenge) {
    return;
  }

  finalizer.shotChallenge = null;
  finalizer.problemIndex += 1;
  finalizer.score = finalizer.problemIndex;
  addCycleWeight(room, finalizer);
  finalizer.problem = getProblem(room, finalizer.problemIndex);

  const target = room.players.get(challenge.targetId);
  if (!target) {
    room.wheel = null;
    return;
  }

  target.penaltyReturnProblem = target.penaltyReturnProblem || target.problem;
  target.problem = makePenaltyProblem(room.rng);
  target.penaltyActive = true;

  room.shot = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    targetId: target.id,
    targetName: target.name,
    finalizerId: finalizer.id,
    finalizerName: finalizer.name,
    expiresAt: Date.now() + SHOT_EVENT_MS
  };
  room.wheel = null;

  const shotId = room.shot.id;
  setTimeout(() => {
    if (room.shot?.id === shotId) {
      room.shot = null;
      emitRoom(room);
    }
  }, SHOT_EVENT_MS);
}

function advancePlayer(room, player) {
  if (player.penaltyActive) {
    player.penaltyActive = false;
    player.problem = player.penaltyReturnProblem || getProblem(room, player.problemIndex);
    player.penaltyReturnProblem = null;
    return;
  }

  player.problemIndex += 1;
  player.score = player.problemIndex;
  addCycleWeight(room, player);
  player.problem = getProblem(room, player.problemIndex);
  triggerShotCycle(room, 'live');
}

function addCycleWeight(room, player) {
  const opponent = getOpponent(room, player.id);
  player.cycleWeight += opponent && player.score > opponent.score ? 3 : 1;
}

function finishRound(room, reason) {
  clearRoomTimer(room);
  room.state = 'finished';
  room.finishedReason = reason;
  room.endsAt = Date.now();
  room.shot = null;
  room.wheel = null;
  room.players.forEach((player) => {
    player.ready = false;
    player.problem = null;
    player.penaltyActive = false;
    player.penaltyReturnProblem = null;
    player.shotChallenge = null;
    player.cycleWeight = 0;
  });
  emitRoom(room);
}

function resetRoom(room) {
  clearRoomTimer(room);
  room.state = 'waiting';
  room.startedAt = null;
  room.endsAt = null;
  room.finishedReason = null;
  room.shot = null;
  room.wheel = null;
  room.seed = Math.floor(Math.random() * 2 ** 32);
  room.rng = mulberry32(room.seed);
  room.problemSet = makeProblemSet(room.rng);
  room.players.forEach((player) => {
    player.score = 0;
    player.problemIndex = 0;
    player.ready = false;
    player.cycleWeight = 0;
    player.penaltyActive = false;
    player.penaltyReturnProblem = null;
    player.shotChallenge = null;
    player.problem = getProblem(room, 0);
  });
}

function emitRoom(room) {
  room.players.forEach((_player, socketId) => {
    io.to(socketId).emit('room:update', publicRoom(room, socketId));
  });
}

function publicRoom(room, viewerId) {
  const players = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    score: player.score,
    problemIndex: player.problemIndex,
    ready: player.ready,
    cycleWeight: player.cycleWeight,
    isYou: player.id === viewerId,
    problem: player.id === viewerId ? publicProblem(player.problem) : null,
    shotChallenge: player.id === viewerId && player.shotChallenge ? publicProblem(player.shotChallenge.problem) : null
  }));

  return {
    id: room.id,
    state: room.state,
    seconds: ROUND_SECONDS,
    serverNow: Date.now(),
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    finishedReason: room.finishedReason,
    shot: publicShot(room.shot, viewerId),
    wheel: publicWheel(room.wheel, viewerId),
    players
  };
}

function publicShot(shot, viewerId) {
  if (!shot) {
    return null;
  }

  return {
    id: shot.id,
    targetName: shot.targetName,
    finalizerName: shot.finalizerName,
    isTarget: shot.targetId === viewerId,
    isFinalizer: shot.finalizerId === viewerId,
    expiresAt: shot.expiresAt
  };
}

function publicWheel(wheel, viewerId) {
  if (!wheel) {
    return null;
  }

  return {
    id: wheel.id,
    skipped: wheel.skipped,
    markSeconds: wheel.markSeconds,
    weights: wheel.weights,
    targetId: wheel.targetId,
    targetName: wheel.targetName,
    finalizerName: wheel.finalizerName,
    isTarget: wheel.targetId === viewerId,
    isFinalizer: wheel.finalizerId === viewerId,
    startedAt: wheel.startedAt,
    endsAt: wheel.endsAt
  };
}

function makeRoom(roomId) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const rng = mulberry32(seed);
  return {
    id: roomId,
    state: 'waiting',
    seed,
    rng,
    problemSet: makeProblemSet(rng),
    startedAt: null,
    endsAt: null,
    finishedReason: null,
    shot: null,
    wheel: null,
    timer: null,
    shotTimers: [],
    players: new Map()
  };
}

function makePlayer(id, name, room) {
  return {
    id,
    name: cleanName(name),
    score: 0,
    problemIndex: 0,
    ready: false,
    cycleWeight: 0,
    penaltyActive: false,
    penaltyReturnProblem: null,
    shotChallenge: null,
    problem: getProblem(room, 0)
  };
}

function makeProblemSet(rng) {
  return Array.from({ length: 400 }, () => makeProblem(rng));
}

function getProblem(room, index) {
  while (room.problemSet.length <= index) {
    room.problemSet.push(makeProblem(room.rng));
  }

  return room.problemSet[index];
}

function makeProblem(rng) {
  const operations = ['+', '-', '×', '÷'];
  const operation = operations[Math.floor(rng() * operations.length)];

  if (operation === '+') {
    const a = randomInt(rng, 2, 100);
    const b = randomInt(rng, 2, 100);
    return { text: `${a} + ${b}`, answer: a + b };
  }

  if (operation === '-') {
    const a = randomInt(rng, 2, 100);
    const b = randomInt(rng, 2, 100);
    return { text: `${a + b} - ${a}`, answer: b };
  }

  if (operation === '×') {
    const a = randomInt(rng, 2, 12);
    const b = randomInt(rng, 2, 100);
    return { text: `${a} × ${b}`, answer: a * b };
  }

  const divisor = randomInt(rng, 2, 12);
  const answer = randomInt(rng, 2, 100);
  return { text: `${divisor * answer} ÷ ${divisor}`, answer };
}

function makePenaltyProblem(rng) {
  const a = randomInt(rng, 1000, 9999);
  const b = randomInt(rng, 1000, 9999);
  return {
    text: `${a} + ${b}`,
    answer: a + b,
    penalty: true
  };
}

function makeNegativeProblem(rng) {
  const answer = -randomInt(rng, 2, 100);
  const subtractor = randomInt(rng, 101, 199);
  const start = answer + subtractor;
  return {
    text: `${start} - ${subtractor}`,
    answer,
    challenge: true
  };
}

function publicProblem(problem) {
  if (!problem) {
    return null;
  }

  return { text: problem.text, penalty: Boolean(problem.penalty), challenge: Boolean(problem.challenge) };
}

function getOpponent(room, playerId) {
  return [...room.players.values()].find((player) => player.id !== playerId) || null;
}

function isLosing(player, opponent) {
  return Boolean(opponent) && player.score < opponent.score;
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  room.shotTimers.forEach((timer) => clearTimeout(timer));
  room.shotTimers = [];
}

function getSocketRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) {
    return null;
  }

  return rooms.get(roomId) || null;
}

function createRoomId() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  let roomId = '';

  do {
    roomId = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(roomId));

  return roomId;
}

function normalizeRoomId(roomId) {
  return String(roomId || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
}

function cleanName(name) {
  const cleaned = String(name || '').trim().slice(0, 18);
  return cleaned || 'Player';
}

function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function mulberry32(seed) {
  return function next() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
