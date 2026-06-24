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
const SHOOT_INTERVAL = 5;
const SHOT_EVENT_MS = 2500;
const SHOT_COOLDOWN_MS = 15000;
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
    const problem = player.problem;

    if (!Number.isFinite(numericAnswer) || !problem) {
      ack?.({ ok: true });
      return;
    }

    if (numericAnswer !== problem.answer) {
      ack?.({ ok: true });
      return;
    }

    advancePlayer(room, player);
    emitRoom(room);
    ack?.({ ok: true });
  });

  socket.on('game:shoot', (ack) => {
    const room = getSocketRoom(socket);
    const shooter = room?.players.get(socket.id);

    if (!room || !shooter || room.state !== 'playing') {
      ack?.({ ok: false, error: 'No active game.' });
      return;
    }

    const target = getOpponent(room, shooter.id);
    if (!target) {
      ack?.({ ok: false, error: 'No opponent to shoot.' });
      return;
    }

    if (!shooter.shootAvailable || !isLosing(shooter, target)) {
      ack?.({ ok: false, error: 'Shoot is only available to the losing player.' });
      return;
    }

    if (Date.now() < room.nextShotAt) {
      ack?.({ ok: false, error: 'Shoot is on cooldown.' });
      return;
    }

    shooter.shootAvailable = false;
    shooter.nextShootScore = shooter.score + SHOOT_INTERVAL;
    room.nextShotAt = Date.now() + SHOT_COOLDOWN_MS;
    target.penaltyReturnProblem = target.penaltyReturnProblem || target.problem;
    target.problem = makePenaltyProblem(room.rng);
    target.penaltyActive = true;
    room.shot = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      shooterId: shooter.id,
      targetId: target.id,
      shooterName: shooter.name,
      targetName: target.name,
      expiresAt: Date.now() + SHOT_EVENT_MS
    };

    const shotId = room.shot.id;
    setTimeout(() => {
      if (room.shot?.id === shotId) {
        room.shot = null;
        emitRoom(room);
      }
    }, SHOT_EVENT_MS);

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
  room.nextShotAt = 0;

  players.forEach((player) => {
    player.score = 0;
    player.problemIndex = 0;
    player.ready = false;
    player.shootAvailable = false;
    player.nextShootScore = SHOOT_INTERVAL;
    player.penaltyActive = false;
    player.penaltyReturnProblem = null;
    player.problem = getProblem(room, 0);
  });

  clearRoomTimer(room);
  room.timer = setTimeout(() => finishRound(room, 'time'), ROUND_SECONDS * 1000);
  emitRoom(room);
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
  player.problem = getProblem(room, player.problemIndex);

  if (player.score >= player.nextShootScore) {
    player.shootAvailable = true;
  }
}

function finishRound(room, reason) {
  clearRoomTimer(room);
  room.state = 'finished';
  room.finishedReason = reason;
  room.endsAt = Date.now();
  room.players.forEach((player) => {
    player.ready = false;
    player.problem = null;
    player.penaltyActive = false;
    player.penaltyReturnProblem = null;
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
  room.nextShotAt = 0;
  room.seed = Math.floor(Math.random() * 2 ** 32);
  room.rng = mulberry32(room.seed);
  room.problemSet = makeProblemSet(room.rng);
  room.players.forEach((player) => {
    player.score = 0;
    player.problemIndex = 0;
    player.ready = false;
    player.shootAvailable = false;
    player.nextShootScore = SHOOT_INTERVAL;
    player.penaltyActive = false;
    player.penaltyReturnProblem = null;
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
    canShoot: player.id === viewerId && room.state === 'playing' && player.shootAvailable && isLosing(player, getOpponent(room, player.id)),
    isYou: player.id === viewerId,
    problem: player.id === viewerId ? publicProblem(player.problem) : null
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
    nextShotAt: room.nextShotAt,
    players
  };
}

function publicShot(shot, viewerId) {
  if (!shot) {
    return null;
  }

  return {
    id: shot.id,
    shooterName: shot.shooterName,
    targetName: shot.targetName,
    isShooter: shot.shooterId === viewerId,
    isTarget: shot.targetId === viewerId,
    expiresAt: shot.expiresAt
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
    nextShotAt: 0,
    timer: null,
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
    shootAvailable: false,
    nextShootScore: SHOOT_INTERVAL,
    penaltyActive: false,
    penaltyReturnProblem: null,
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

function publicProblem(problem) {
  if (!problem) {
    return null;
  }

  return { text: problem.text, penalty: Boolean(problem.penalty) };
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
