/**
 * FixPack v2 / Commit 3 — AI Host ready quorum tests.
 *
 * Pin the contract:
 *   - Minimum 3 suspects required.
 *   - Quorum = 3 ready (or all if fewer).
 *   - Custom Mode: suspect count must equal config.playerCount before
 *     quorum can be reached.
 *   - Idempotent: clicking ready twice does NOT inflate the count.
 *   - Race-safe: aiStartInProgress prevents duplicate generation.
 *   - Human Host rooms NEVER use this flow.
 *   - Once started, ready signals are locked.
 *
 * No DB, no network. We exercise the helpers directly (no socket layer).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');

function makeMockIo() {
  const events = [];
  return {
    to(roomId) {
      return { emit(event, payload) { events.push({ roomId, event, payload }); } };
    },
    on() {},
    _events: events,
  };
}

function makeAiLobby({ suspectCount = 3, config = null, mode = 'AI', state = 'LOBBY' } = {}) {
  const players = new Map();
  for (let i = 0; i < suspectCount; i++) {
    const id = 1000 + i;
    players.set(id, {
      id, username: `S${i}`, socketId: `s${i}`, isHost: false, isAlive: true,
    });
  }
  return {
    id: 'AIROOM',
    creatorId: 1000, hostId: 'AI_HOST', mode,
    roleRevealMode: 'normal',
    config,
    players,
    state,
    gameData: null,
    aiReadyPlayers: new Set(),
    aiStartInProgress: false,
  };
}

function makeHumanLobby({ suspectCount = 3, config = null } = {}) {
  const players = new Map();
  // Human host id = 99.
  players.set(99, { id: 99, username: 'host', socketId: 'sH', isHost: true, isAlive: true });
  for (let i = 0; i < suspectCount; i++) {
    const id = 1000 + i;
    players.set(id, {
      id, username: `S${i}`, socketId: `s${i}`, isHost: false, isAlive: true,
    });
  }
  return {
    id: 'HUMANROOM',
    creatorId: 99, hostId: 99, mode: 'HUMAN',
    roleRevealMode: 'normal',
    config,
    players,
    state: 'LOBBY',
    gameData: null,
    aiReadyPlayers: new Set(),
    aiStartInProgress: false,
  };
}

// ---------------------------------------------------------------------------
// 1. _computeAiReadyProgress — pure shape pin
// ---------------------------------------------------------------------------

test('FP2.26 progress fields: ready, total, required, canStart', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 4 });
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.ready, 0);
  assert.equal(p.total, 4);
  assert.equal(p.required, 3);
  assert.equal(p.minSuspects, 3);
  assert.equal(p.canStart, false);
  assert.equal(p.inProgress, false);
});

// ---------------------------------------------------------------------------
// 2. canStart logic
// ---------------------------------------------------------------------------

test('FP2.27 AI room with 2 suspects → canStart NEVER true (below min)', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 2 });
  // Even if both ready up.
  lobby.aiReadyPlayers.add(1000);
  lobby.aiReadyPlayers.add(1001);
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.enoughSuspects, false);
  assert.equal(p.canStart, false);
});

test('FP2.28 AI room with 3 suspects, 2 ready → canStart=false', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 3 });
  lobby.aiReadyPlayers.add(1000);
  lobby.aiReadyPlayers.add(1001);
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.enoughSuspects, true);
  assert.equal(p.enoughReady, false);
  assert.equal(p.canStart, false);
});

test('FP2.29 AI room with 3 suspects, 3 ready → canStart=true', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 3 });
  lobby.aiReadyPlayers.add(1000);
  lobby.aiReadyPlayers.add(1001);
  lobby.aiReadyPlayers.add(1002);
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.canStart, true);
});

test('FP2.30 AI room with 5 suspects, 3 ready → canStart=true (default mode)', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 5 });
  lobby.aiReadyPlayers.add(1000);
  lobby.aiReadyPlayers.add(1001);
  lobby.aiReadyPlayers.add(1002);
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.canStart, true);
});

// ---------------------------------------------------------------------------
// 3. Custom Mode seat gate
// ---------------------------------------------------------------------------

test('FP2.31 Custom AI room playerCount=5, only 3 joined → canStart=false even with 3 ready', () => {
  const gm = new GameManager(makeMockIo(), null);
  const cfg = { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 };
  const lobby = makeAiLobby({ suspectCount: 3, config: cfg });
  lobby.aiReadyPlayers.add(1000);
  lobby.aiReadyPlayers.add(1001);
  lobby.aiReadyPlayers.add(1002);
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.customSeatGate, false);
  assert.equal(p.canStart, false);
  assert.ok(p.customSeatError, 'must surface the seat-gate error so UI can render it');
  assert.ok(p.customSeatError.includes('5'));
  assert.ok(p.customSeatError.includes('3'));
});

test('FP2.32 Custom AI room playerCount=5, 5 joined, 3 ready → canStart=true', () => {
  const gm = new GameManager(makeMockIo(), null);
  const cfg = { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 };
  const lobby = makeAiLobby({ suspectCount: 5, config: cfg });
  lobby.aiReadyPlayers.add(1000);
  lobby.aiReadyPlayers.add(1001);
  lobby.aiReadyPlayers.add(1002);
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.customSeatGate, true);
  assert.equal(p.canStart, true);
});

// ---------------------------------------------------------------------------
// 4. Race-safe — aiStartInProgress lock
// ---------------------------------------------------------------------------

test('FP2.33 aiStartInProgress=true forces canStart=false (lock)', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 3 });
  lobby.aiReadyPlayers.add(1000);
  lobby.aiReadyPlayers.add(1001);
  lobby.aiReadyPlayers.add(1002);
  // Lock the start flag.
  lobby.aiStartInProgress = true;
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.canStart, false, 'lock prevents re-entry');
  assert.equal(p.inProgress, true);
});

// ---------------------------------------------------------------------------
// 5. Idempotent — adding the same id twice doesn't change the count
// ---------------------------------------------------------------------------

test('FP2.34 aiReadyPlayers Set is idempotent — duplicate clicks do not inflate ready count', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 5 });
  lobby.aiReadyPlayers.add(1000);
  lobby.aiReadyPlayers.add(1000);
  lobby.aiReadyPlayers.add(1000);
  assert.equal(lobby.aiReadyPlayers.size, 1);
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.ready, 1);
});

// ---------------------------------------------------------------------------
// 6. Human Host rooms — flow not used here
// ---------------------------------------------------------------------------

test('FP2.35 Human Host room: progress can be computed but is informational only', () => {
  // The handler refuses ai_host_ready in non-AI rooms; the helper itself
  // still returns sensible counters (3 suspects, 0 ready, canStart=false).
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeHumanLobby({ suspectCount: 3 });
  const p = gm._computeAiReadyProgress(lobby);
  assert.equal(p.total, 3);
  assert.equal(p.ready, 0);
  assert.equal(p.canStart, false);
});

// ---------------------------------------------------------------------------
// 7. _aiHostFinalize — privacy + role distribution
// ---------------------------------------------------------------------------

test('FP2.36 _aiHostFinalize enters ROLE_REVEAL with assignRoles + private role cards', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeAiLobby({ suspectCount: 5 });
  // Build a synthetic archive that passes assignRoles defaults.
  const archive = {
    title: 't',
    story: 'القصة دي طويلة كفاية عشان تعدي فحص الـ60 حرف اللي في الفاليديتر.',
    mafiozo: 'كمال (المحاسب)',
    obvious_suspect: 'محمود (الحارس)',
    characters: [
      { name: 'A', role: 'r1', suspicious_detail: 'd1' },
      { name: 'B', role: 'r2', suspicious_detail: 'd2' },
      { name: 'C', role: 'r3', suspicious_detail: 'd3' },
      { name: 'D', role: 'r4', suspicious_detail: 'd4' },
      { name: 'E', role: 'r5', suspicious_detail: 'd5' },
    ],
    clues: ['c1', 'c2', 'c3'],
  };
  gm._aiHostFinalize(lobby, archive, 'gemini');

  assert.equal(lobby.state, 'IN_GAME');
  assert.equal(lobby.gameData.phase, 'ROLE_REVEAL');
  assert.equal(Object.keys(lobby.gameData.roleAssignments).length, 5);
  assert.equal(lobby.gameData.publicCharacterCards.length, 5);

  // Privacy: NEVER broadcast roleAssignments. Inspect captured emits.
  const fullStateEmits = io._events.filter(e => e.event === 'full_state_update');
  for (const ev of fullStateEmits) {
    const json = JSON.stringify(ev.payload);
    assert.equal(json.includes('"gameRole"'), false, 'no gameRole in broadcast');
    assert.equal(json.includes('"roleAssignments"'), false, 'no roleAssignments in broadcast');
  }
  // Private role cards go to specific socket ids.
  const privateEmits = io._events.filter(e => e.event === 'your_role_card');
  assert.equal(privateEmits.length, 5);
  for (const ev of privateEmits) {
    // roomId here is actually the per-socket id we used in the lobby.
    assert.match(ev.roomId, /^s\d/);
  }

  // Cleanup the timer started inside _aiHostFinalize.
  if (lobby.gameData && lobby.gameData.interval) {
    clearInterval(lobby.gameData.interval);
    lobby.gameData.interval = null;
  }
});

// ---------------------------------------------------------------------------
// 8. game_started broadcast (so non-creator clients navigate)
// ---------------------------------------------------------------------------

test('FP2.37 _aiHostFinalize emits game_started to the whole room (no creator-only path)', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeAiLobby({ suspectCount: 3 });
  const archive = {
    title: 't',
    story: 'القصة دي طويلة كفاية عشان تعدي فحص الـ60 حرف اللي في الفاليديتر.',
    mafiozo: 'A',
    obvious_suspect: 'B',
    characters: [
      { name: 'A', role: 'r1', suspicious_detail: 'd1' },
      { name: 'B', role: 'r2', suspicious_detail: 'd2' },
      { name: 'C', role: 'r3', suspicious_detail: 'd3' },
    ],
    clues: ['c1', 'c2', 'c3'],
  };
  gm._aiHostFinalize(lobby, archive, 'fallback');
  const startedEmits = io._events.filter(e => e.event === 'game_started');
  assert.ok(startedEmits.length >= 1, 'game_started must broadcast to the room');
  assert.equal(startedEmits[0].roomId, 'AIROOM');
  if (lobby.gameData && lobby.gameData.interval) {
    clearInterval(lobby.gameData.interval);
    lobby.gameData.interval = null;
  }
});
