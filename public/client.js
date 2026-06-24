const socket = io();

const setup = document.querySelector('#setup');
const lobby = document.querySelector('#lobby');
const game = document.querySelector('#game');
const joinForm = document.querySelector('#joinForm');
const nameInput = document.querySelector('#nameInput');
const roomInput = document.querySelector('#roomInput');
const createButton = document.querySelector('#createButton');
const copyButton = document.querySelector('#copyButton');
const readyButton = document.querySelector('#readyButton');
const leaveButton = document.querySelector('#leaveButton');
const shootButton = document.querySelector('#shootButton');
const answerForm = document.querySelector('#answerForm');
const answerInput = document.querySelector('#answerInput');
const roomCode = document.querySelector('#roomCode');
const inviteLink = document.querySelector('#inviteLink');
const stateTitle = document.querySelector('#stateTitle');
const players = document.querySelector('#players');
const scoreboard = document.querySelector('#scoreboard');
const problem = document.querySelector('#problem');
const shotBanner = document.querySelector('#shotBanner');
const timer = document.querySelector('#timer');
const timerLabel = document.querySelector('#timerLabel');

let currentRoom = null;
let ticker = null;
let serverClockOffset = 0;
let lastProblemIndex = null;
let lastPenaltyState = false;
let lastShotId = null;

const savedName = localStorage.getItem('live-zetamac:name');
if (savedName) {
  nameInput.value = savedName;
}

const pathRoom = getRoomFromPath();
if (pathRoom) {
  roomInput.value = pathRoom;
}
updateCreateVisibility();

createButton.addEventListener('click', () => {
  persistName();
  socket.emit('room:create', { name: nameInput.value }, handleJoinAck);
});

roomInput.addEventListener('input', updateCreateVisibility);

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  persistName();
  const roomId = extractRoomId(roomInput.value || pathRoom);
  socket.emit('room:join', { roomId, name: nameInput.value }, handleJoinAck);
});

copyButton.addEventListener('click', async () => {
  if (!currentRoom) {
    return;
  }

  await navigator.clipboard.writeText(makeInviteUrl(currentRoom.id));
  copyButton.textContent = 'Copied';
  setTimeout(() => {
    copyButton.textContent = 'Copy invite link';
  }, 1200);
});

readyButton.addEventListener('click', () => {
  unlockShotSound();
  socket.emit('game:ready', showErrorAck);
});

leaveButton.addEventListener('click', () => {
  socket.emit('room:leave', () => {
    currentRoom = null;
    lastProblemIndex = null;
    lastPenaltyState = false;
    lastShotId = null;
    history.replaceState(null, '', '/');
    setup.classList.remove('hidden');
    lobby.classList.add('hidden');
    game.classList.add('hidden');
    roomInput.value = '';
    updateCreateVisibility();
  });
});

shootButton.addEventListener('click', () => {
  unlockShotSound();
  socket.emit('game:shoot', showErrorAck);
});

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'x' || shootButton.classList.contains('hidden')) {
    return;
  }

  event.preventDefault();
  unlockShotSound();
  socket.emit('game:shoot', showErrorAck);
});

answerForm.addEventListener('submit', (event) => event.preventDefault());

answerInput.addEventListener('input', () => {
  const answer = answerInput.value.trim();

  if (!currentRoom || currentRoom.state !== 'playing' || !answer) {
    return;
  }

  socket.emit('answer:update', { answer });
});

socket.on('room:update', (room) => {
  currentRoom = room;
  serverClockOffset = room.serverNow - Date.now();
  renderRoom(room);
});

socket.on('connect_error', () => {
  stateTitle.textContent = 'Connection lost. Refresh and rejoin the room.';
});

if (pathRoom) {
  socket.emit('room:join', { roomId: pathRoom, name: nameInput.value }, handleJoinAck);
}

function handleJoinAck(response) {
  if (!response?.ok) {
    alert(response?.error || 'Unable to join room.');
    return;
  }

  currentRoom = response.room;
  serverClockOffset = currentRoom.serverNow - Date.now();
  history.replaceState(null, '', `/r/${currentRoom.id}`);
  renderRoom(currentRoom);
}

function renderRoom(room) {
  setup.classList.add('hidden');
  lobby.classList.remove('hidden');
  game.classList.toggle('hidden', room.state !== 'playing');
  roomCode.textContent = room.id;
  inviteLink.textContent = makeInviteUrl(room.id);
  renderPlayers(room);
  renderScoreboard(room);
  renderState(room);
  renderProblem(room);
  renderShoot(room);
  renderShot(room);
  startTicker(room);
}

function renderPlayers(room) {
  const slots = [...room.players];
  while (slots.length < 2) {
    slots.push(null);
  }

  players.innerHTML = slots.map((player, index) => {
    if (!player) {
      return `<article class="player-card"><p class="player-name muted">Waiting for player ${index + 1}</p><span class="status-pill waiting-pill">Invite sent</span></article>`;
    }

    const readyText = player.ready ? 'Ready' : room.state === 'playing' ? 'Racing' : 'Not ready';
    const readyClass = player.ready || room.state === 'playing' ? '' : ' waiting-pill';
    return `<article class="player-card ${player.isYou ? 'you' : ''}"><p class="player-name">${escapeHtml(player.name)} ${player.isYou ? '(you)' : ''}</p><span class="status-pill${readyClass}">${readyText}</span></article>`;
  }).join('');
}

function renderScoreboard(room) {
  scoreboard.innerHTML = room.players.map((player) => {
    return `<article class="score-card ${player.isYou ? 'you' : ''}"><p class="player-name">${escapeHtml(player.name)}</p><p class="score-value">${player.score}</p></article>`;
  }).join('');
}

function renderState(room) {
  readyButton.classList.toggle('hidden', room.state === 'playing');

  if (room.state === 'waiting') {
    const you = room.players.find((player) => player.isYou);
    stateTitle.textContent = room.players.length < 2 ? 'Waiting for opponent' : 'Ready up to start';
    readyButton.textContent = you?.ready ? 'Unready' : 'Ready';
    timerLabel.textContent = 'Waiting';
    timer.textContent = String(room.seconds);
    return;
  }

  if (room.state === 'playing') {
    stateTitle.textContent = 'Race live';
    timerLabel.textContent = 'Seconds';
    return;
  }

  stateTitle.textContent = getResultTitle(room);
  timerLabel.textContent = 'Finished';
  timer.textContent = '0';
  readyButton.textContent = 'New round';
}

function renderProblem(room) {
  const you = room.players.find((player) => player.isYou);
  const nextProblemIndex = you?.problemIndex ?? null;
  const penaltyActive = Boolean(you?.problem?.penalty);
  problem.textContent = you?.problem?.text || '--';
  problem.classList.toggle('penalty-problem', penaltyActive);

  if (nextProblemIndex !== lastProblemIndex || penaltyActive !== lastPenaltyState) {
    answerInput.value = '';
    lastProblemIndex = nextProblemIndex;
    lastPenaltyState = penaltyActive;
  }

  if (room.state === 'playing') {
    answerInput.disabled = false;
    answerInput.focus();
    return;
  }

  answerInput.disabled = true;
}

function renderShoot(room) {
  const you = room.players.find((player) => player.isYou);
  const onCooldown = room.nextShotAt && room.nextShotAt > getServerNow();
  shootButton.classList.toggle('hidden', room.state !== 'playing' || !you?.canShoot || onCooldown);
}

function renderShot(room) {
  const shot = room.shot;
  shotBanner.classList.toggle('hidden', !shot);

  if (!shot) {
    shotBanner.textContent = '';
    return;
  }

  shotBanner.textContent = shot.isTarget
    ? `${shot.shooterName} shot your problem. Clear the red one to continue.`
    : `${shot.shooterName} shot ${shot.targetName}.`;

  if (shot.id !== lastShotId) {
    lastShotId = shot.id;
    playGunshot();
  }
}

function startTicker(room) {
  clearInterval(ticker);

  if (room.state !== 'playing' || !room.endsAt) {
    return;
  }

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((room.endsAt - getServerNow()) / 1000));
    timer.textContent = String(remaining);
  };

  tick();
  ticker = setInterval(tick, 250);
}

function getResultTitle(room) {
  if (room.finishedReason === 'opponent_left') {
    return 'Opponent left';
  }

  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  if (sorted.length < 2 || sorted[0].score === sorted[1].score) {
    return 'Tie game';
  }

  return `${sorted[0].name} wins`;
}

function showErrorAck(response) {
  if (!response?.ok) {
    alert(response?.error || 'Action failed.');
  }
}

function persistName() {
  localStorage.setItem('live-zetamac:name', nameInput.value.trim());
}

function updateCreateVisibility() {
  createButton.classList.toggle('hidden', Boolean(roomInput.value.trim()));
}

function unlockShotSound() {
  const audio = new Audio('/shot.mp3');
  audio.volume = 0;
  audio.play().catch(() => {});
}

function playGunshot() {
  const audio = new Audio('/shot.mp3');
  audio.play().catch(() => {});
}

function makeInviteUrl(roomId) {
  return `${window.location.origin}/r/${roomId}`;
}

function getServerNow() {
  return Date.now() + serverClockOffset;
}

function getRoomFromPath() {
  const match = window.location.pathname.match(/^\/r\/([a-z0-9-]+)/i);
  return match ? extractRoomId(match[1]) : '';
}

function extractRoomId(value) {
  const text = String(value || '').trim();
  const urlMatch = text.match(/\/r\/([a-z0-9-]+)/i);
  return (urlMatch ? urlMatch[1] : text).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#039;',
    '"': '&quot;'
  })[char]);
}
