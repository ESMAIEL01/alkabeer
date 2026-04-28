/**
 * FixPack v2 / Commit 2 — Public Character Overview phase invariants.
 *
 * Pin the contract:
 *   - PUBLIC_CHARACTER_OVERVIEW is broadcast (full_state_update) to ALL
 *     sockets in the room, not just the host.
 *   - The broadcast carries publicCharacterCards.
 *   - Each card has ONLY the allow-listed public fields; no gameRole.
 *   - The state never contains roleAssignments before FINAL_REVEAL.
 *   - handlePhaseEnd advances PUBLIC_CHARACTER_OVERVIEW → CLUE_REVEAL.
 *   - blind mode does not leak gameRole through the public surface.
 *
 * Mock io captures every emit; we assert against the captured stream.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');

function makeMockIo() {
  const events = [];
  return {
    to(roomId) {
      return {
        emit(event, payload) {
          events.push({ roomId, event, payload });
        },
      };
    },
    on() {},
    _events: events,
  };
}

function makeLobby({ revealMode = 'normal', phase = 'PUBLIC_CHARACTER_OVERVIEW' } = {}) {
  const players = new Map();
  // 1 human host + 4 suspects.
  players.set(101, { id: 101, username: 'host_x', socketId: 's1', isHost: true,  isAlive: true });
  players.set(202, { id: 202, username: 'A',       socketId: 's2', isHost: false, isAlive: true });
  players.set(303, { id: 303, username: 'B',       socketId: 's3', isHost: false, isAlive: true });
  players.set(404, { id: 404, username: 'C',       socketId: 's4', isHost: false, isAlive: true });
  players.set(505, { id: 505, username: 'D',       socketId: 's5', isHost: false, isAlive: true });

  const roleAssignments = {
    202: { playerId: 202, username: 'A', gameRole: 'mafiozo',         storyCharacterName: 'X', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: true },
    303: { playerId: 303, username: 'B', gameRole: 'innocent',        storyCharacterName: 'Y', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: true },
    404: { playerId: 404, username: 'C', gameRole: 'obvious_suspect', storyCharacterName: 'Z', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: true },
    505: { playerId: 505, username: 'D', gameRole: 'innocent',        storyCharacterName: 'W', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: true },
  };

  return {
    id: 'PUB_ROOM',
    creatorId: 101, hostId: 101, mode: 'HUMAN',
    roleRevealMode: revealMode, state: 'IN_GAME',
    players,
    gameData: {
      archiveBase64: '', rawScenario: '',
      decodedArchive: { characters: [], mafiozo: 'X' },
      clues: ['c1', 'c2', 'c3'],
      clueIndex: 0,
      phase,
      timer: 10,
      interval: null,
      isPaused: false,
      votes: {},
      roleRevealMode: revealMode,
      roleAssignments,
      publicCharacterCards: [
        { playerId: 202, username: 'A', storyCharacterName: 'X', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
        { playerId: 303, username: 'B', storyCharacterName: 'Y', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
        { playerId: 404, username: 'C', storyCharacterName: 'Z', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
        { playerId: 505, username: 'D', storyCharacterName: 'W', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
      ],
      votingHistory: [],
      eliminatedIds: [],
      outcome: null,
      lastVoteResult: null,
    },
  };
}

function cleanup(lobby) {
  if (lobby && lobby.gameData && lobby.gameData.interval) {
    clearInterval(lobby.gameData.interval);
    lobby.gameData.interval = null;
  }
}

// ---------------------------------------------------------------------------
// 1. Broadcast contract — full_state_update fires on enterPhase
// ---------------------------------------------------------------------------

test('FP2.18 enterPhase(PUBLIC_CHARACTER_OVERVIEW) broadcasts full_state_update to the room', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeLobby({ phase: 'ROLE_REVEAL' });
  gm.lobbies.set(lobby.id, lobby);

  // Move from ROLE_REVEAL into PUBLIC_CHARACTER_OVERVIEW (the documented flow).
  gm.enterPhase(lobby, 'PUBLIC_CHARACTER_OVERVIEW', 10);

  const fullStateEmits = io._events.filter(e => e.event === 'full_state_update');
  assert.ok(fullStateEmits.length >= 1, 'full_state_update must fire at least once');

  const last = fullStateEmits[fullStateEmits.length - 1];
  assert.equal(last.roomId, 'PUB_ROOM', 'broadcast goes to the room (everyone), not a single socket');
  assert.equal(last.payload.phase, 'PUBLIC_CHARACTER_OVERVIEW');
  cleanup(lobby);
});

test('FP2.19 PUBLIC_CHARACTER_OVERVIEW payload carries publicCharacterCards', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeLobby({ phase: 'ROLE_REVEAL' });
  gm.lobbies.set(lobby.id, lobby);

  gm.enterPhase(lobby, 'PUBLIC_CHARACTER_OVERVIEW', 10);
  const last = io._events.filter(e => e.event === 'full_state_update').slice(-1)[0];
  assert.ok(Array.isArray(last.payload.publicCharacterCards));
  assert.equal(last.payload.publicCharacterCards.length, 4);
  cleanup(lobby);
});

// ---------------------------------------------------------------------------
// 2. Privacy contract — no gameRole, no roleAssignments
// ---------------------------------------------------------------------------

test('FP2.20 PUBLIC_CHARACTER_OVERVIEW publicCharacterCards have ONLY allow-listed keys', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeLobby();
  gm.lobbies.set(lobby.id, lobby);

  const state = gm.buildPublicState(lobby.id);
  const allowed = new Set(['playerId', 'username', 'storyCharacterName', 'storyCharacterRole', 'suspiciousDetail']);
  for (const card of state.publicCharacterCards) {
    for (const k of Object.keys(card)) {
      assert.ok(allowed.has(k), `unexpected key on public card: ${k}`);
    }
    assert.equal('gameRole' in card, false);
  }
  cleanup(lobby);
});

test('FP2.21 PUBLIC_CHARACTER_OVERVIEW state contains NO gameRole anywhere (deep scan)', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeLobby();
  gm.lobbies.set(lobby.id, lobby);

  const state = gm.buildPublicState(lobby.id);
  assert.equal(deepHasKey(state, 'gameRole'), false,
    'no gameRole anywhere in public state during PUBLIC_CHARACTER_OVERVIEW');
  assert.equal(deepHasKey(state, 'roleAssignments'), false,
    'roleAssignments must never appear on the public surface');
  // finalReveal is allowed only at FINAL_REVEAL phase; here it must be undefined.
  assert.equal(state.finalReveal, undefined);
  cleanup(lobby);
});

test('FP2.22 Blind mode does NOT leak gameRole into the public state', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeLobby({ revealMode: 'blind' });
  gm.lobbies.set(lobby.id, lobby);

  const state = gm.buildPublicState(lobby.id);
  assert.equal(deepHasKey(state, 'gameRole'), false);
  assert.equal(state.roleRevealMode, 'blind');
  cleanup(lobby);
});

// ---------------------------------------------------------------------------
// 3. Auto-advance — handlePhaseEnd takes PUBLIC_CHARACTER_OVERVIEW → CLUE_REVEAL
// ---------------------------------------------------------------------------

test('FP2.23 handlePhaseEnd advances PUBLIC_CHARACTER_OVERVIEW → CLUE_REVEAL automatically', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeLobby({ phase: 'PUBLIC_CHARACTER_OVERVIEW' });
  gm.lobbies.set(lobby.id, lobby);

  // Reset captured emits to ignore the initial setup.
  io._events.length = 0;

  // Simulate the timer reaching zero — handlePhaseEnd is what the
  // per-second interval calls.
  gm.handlePhaseEnd(lobby.id);

  assert.equal(lobby.gameData.phase, 'CLUE_REVEAL',
    'PUBLIC_CHARACTER_OVERVIEW must auto-advance to CLUE_REVEAL');
  assert.equal(lobby.gameData.timer, 45, 'CLUE_REVEAL gets a 45s timer');

  // The transition must broadcast the new state to everyone.
  const last = io._events.filter(e => e.event === 'full_state_update').slice(-1)[0];
  assert.ok(last);
  assert.equal(last.payload.phase, 'CLUE_REVEAL');
  cleanup(lobby);
});

test('FP2.24 ROLE_REVEAL → PUBLIC_CHARACTER_OVERVIEW → CLUE_REVEAL — full chain', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeLobby({ phase: 'ROLE_REVEAL' });
  gm.lobbies.set(lobby.id, lobby);

  gm.handlePhaseEnd(lobby.id);
  assert.equal(lobby.gameData.phase, 'PUBLIC_CHARACTER_OVERVIEW');
  assert.equal(lobby.gameData.timer, 10);

  gm.handlePhaseEnd(lobby.id);
  assert.equal(lobby.gameData.phase, 'CLUE_REVEAL');
  assert.equal(lobby.gameData.timer, 45);
  cleanup(lobby);
});

// ---------------------------------------------------------------------------
// 4. The broadcast goes to the room id, not to the host socket
// ---------------------------------------------------------------------------

test('FP2.25 PUBLIC_CHARACTER_OVERVIEW broadcast is room-scoped (everyone receives it)', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeLobby({ phase: 'ROLE_REVEAL' });
  gm.lobbies.set(lobby.id, lobby);

  gm.enterPhase(lobby, 'PUBLIC_CHARACTER_OVERVIEW', 10);

  // Every full_state_update emit must target the room id, never a single
  // socket id. The mock io records the room id used in `io.to(roomId)`.
  const fullStateEmits = io._events.filter(e => e.event === 'full_state_update');
  for (const ev of fullStateEmits) {
    assert.equal(ev.roomId, 'PUB_ROOM',
      'public state must broadcast to the room — never to a single socket');
  }
  cleanup(lobby);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function deepHasKey(obj, key) {
  if (obj === null || obj === undefined) return false;
  if (Array.isArray(obj)) return obj.some(o => deepHasKey(o, key));
  if (typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    if (k === key) return true;
    if (deepHasKey(obj[k], key)) return true;
  }
  return false;
}
