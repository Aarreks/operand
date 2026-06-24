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
const answerForm = document.querySelector('#answerForm');
const answerInput = document.querySelector('#answerInput');
const roomCode = document.querySelector('#roomCode');
const inviteLink = document.querySelector('#inviteLink');
const stateTitle = document.querySelector('#stateTitle');
const players = document.querySelector('#players');
const scoreboard = document.querySelector('#scoreboard');
const problem = document.querySelector('#problem');
const shotBanner = document.querySelector('#shotBanner');
const wheelBox = document.querySelector('#wheelBox');
const wheelSpinner = document.querySelector('#wheelSpinner');
const wheelText = document.querySelector('#wheelText');
const challengeBox = document.querySelector('#challengeBox');
const timer = document.querySelector('#timer');
const timerLabel = document.querySelector('#timerLabel');

let currentRoom = null;
let ticker = null;
let serverClockOffset = 0;
let lastProblemIndex = null;
let lastPenaltyState = false;
let lastChallengeState = false;
let lastShotId = null;
let lastWheelId = null;

const shotAudio = new Audio('/shot.mp3');
shotAudio.preload = 'auto';

const savedName = localStorage.getItem('live-zetamac:name');
if (savedName) {
  nameInput.value = savedName;
}

const pathRoom = getRoomFromPath();
if (pathRoom) {
  roomInput.value = pathRoom;
  nameInput.focus();
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
    lastChallengeState = false;
    lastShotId = null;
    lastWheelId = null;
    history.replaceState(null, '', '/');
    setup.classList.remove('hidden');
    lobby.classList.add('hidden');
    game.classList.add('hidden');
    roomInput.value = '';
    updateCreateVisibility();
  });
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
  renderWheel(room);
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

    const readyText = player.ready ? 'Ready' : room.state === 'playing' ? `Racing · wheel ${player.cycleWeight}` : 'Not ready';
    const readyClass = player.ready || room.state === 'playing' ? '' : ' waiting-pill';
    return `<article class="player-card ${player.isYou ? 'you' : ''}"><p class="player-name">${escapeHtml(player.name)} ${player.isYou ? '(you)' : ''}</p><span class="status-pill${readyClass}">${readyText}</span></article>`;
  }).join('');
}

function renderScoreboard(room) {
  scoreboard.innerHTML = room.players.map((player) => {
    return `<article class="score-card ${player.isYou ? 'you' : ''}"><p class="player-name">${escapeHtml(player.name)}</p><p class="score-value">${player.score}</p><p class="muted">Wheel weight: ${player.cycleWeight}</p></article>`;
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
  const challengeActive = Boolean(you?.shotChallenge);
  problem.textContent = challengeActive ? you.shotChallenge.text : you?.problem?.text || '--';
  problem.classList.toggle('penalty-problem', penaltyActive);
  problem.classList.toggle('challenge-problem', challengeActive);
  challengeBox.classList.toggle('hidden', !challengeActive);
  challengeBox.textContent = challengeActive ? 'Solve to shoot your opponent.' : '';

  if (nextProblemIndex !== lastProblemIndex || penaltyActive !== lastPenaltyState || challengeActive !== lastChallengeState) {
    answerInput.value = '';
    lastProblemIndex = nextProblemIndex;
    lastPenaltyState = penaltyActive;
    lastChallengeState = challengeActive;
  }

  if (room.state === 'playing') {
    answerInput.disabled = false;
    answerInput.focus();
    return;
  }

  answerInput.disabled = true;
}

function renderWheel(room) {
  const wheel = room.wheel;
  wheelBox.classList.toggle('hidden', !wheel);

  if (!wheel) {
    wheelText.textContent = '';
    wheelSpinner.innerHTML = '';
    lastWheelId = null;
    return;
  }

  const isNewWheel = wheel.id !== lastWheelId;
  if (isNewWheel) {
    lastWheelId = wheel.id;
    wheelSpinner.innerHTML = '';
  }

  const weightsText = wheel.weights.map((item) => `${escapeHtml(item.name)}:${item.weight}`).join(' · ');
  const totalWeight = wheel.weights.reduce((sum, item) => sum + item.weight, 0) || 1;

  if (isNewWheel) {
    let offset = 0;
    wheel.weights.forEach((item) => {
      const width = (item.weight / totalWeight) * 100;
      const segment = document.createElement('div');
      segment.className = 'wheel-segment';
      segment.style.left = `${offset}%`;
      segment.style.width = `${width}%`;
      segment.textContent = `${item.name} (${item.weight})`;
      wheelSpinner.appendChild(segment);
      offset += width;
    });

    const initialNeedle = createNeedle(wheel, totalWeight, getServerNow() < wheel.endsAt);
    if (initialNeedle) {
      wheelSpinner.appendChild(initialNeedle);
    }
  } else {
    const spinning = getServerNow() < wheel.endsAt;
    const needle = wheelSpinner.querySelector('.wheel-needle');
    const targetPercent = getNeedlePercent(wheel, totalWeight);
    if (needle) {
      if (spinning) {
        if (!needle.classList.contains('animate')) {
          needle.classList.add('animate');
          void needle.offsetWidth;
        }
      } else {
        needle.classList.remove('animate');
        needle.style.left = `${targetPercent}%`;
      }
      needle.style.setProperty('--needle-left', `${targetPercent}%`);
    }
  }

  const spinningNow = getServerNow() < wheel.endsAt;
  if (wheel.skipped) {
    wheelText.textContent = `Wheel check: no solved problems this cycle. No shot. (${weightsText})`;
  } else if (spinningNow) {
    wheelText.textContent = `Wheel spinning... (${weightsText})`;
  } else {
    const targetName = wheel.targetName || 'Someone';
    wheelText.textContent = `${targetName} is getting popped.`;
  }
}

function getNeedlePercent(wheel, totalWeight) {
  const targetId = wheel.targetId;
  let cursor = 0;
  let targetLeft = 0;

  wheel.weights.forEach((item) => {
    const width = (item.weight / totalWeight) * 100;
    if (item.id === targetId) {
      targetLeft = cursor + width / 2;
    }
    cursor += width;
  });

  return targetLeft;
}

function createNeedle(wheel, totalWeight, spinning) {
  if (wheel.skipped || !wheel.weights.length) {
    return null;
  }

  const needle = document.createElement('div');
  needle.className = 'wheel-needle';

  const targetId = wheel.targetId;
  let cursor = 0;
  let targetLeft = 0;

  wheel.weights.forEach((item) => {
    const width = (item.weight / totalWeight) * 100;
    if (item.id === targetId) {
      targetLeft = cursor + width / 2;
    }
    cursor += width;
  });

  needle.style.setProperty('--needle-left', `${targetLeft}%`);

  if (spinning) {
    needle.classList.add('animate');
    void needle.offsetWidth;
  } else {
    needle.style.left = `${targetLeft}%`;
  }

  return needle;
}

function renderShot(room) {
  const shot = room.shot;
  shotBanner.classList.toggle('hidden', !shot);

  if (!shot) {
    shotBanner.textContent = '';
    return;
  }

  shotBanner.textContent = shot.isTarget
    ? `${shot.finalizerName} shot your problem. Clear the red one to continue.`
    : `${shot.finalizerName} shot ${shot.targetName}.`;

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
  shotAudio.volume = 0;
  shotAudio.currentTime = 0;
  shotAudio.play().then(() => {
    shotAudio.pause();
    shotAudio.currentTime = 0;
    shotAudio.volume = 1;
  }).catch(() => {
    shotAudio.volume = 1;
  });
}

function playGunshot() {
  shotAudio.pause();
  shotAudio.currentTime = 0;
  shotAudio.volume = 1;
  shotAudio.play().catch(() => {});
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
