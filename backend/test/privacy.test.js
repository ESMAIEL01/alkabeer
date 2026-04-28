/**
 * Privacy regression tests.
 *
 * Pins the gameRole-leak contract:
 *   1. buildPublicState before FINAL_REVEAL contains no gameRole anywhere.
 *   2. publicCharacterCards carry only the allow-listed public fields.
 *   3. Blind-mode private role card OMITS the gameRole key (not just nulls it).
 *   4. Normal-mode private role card carries only the local player's role.
 *   5. vote_result payload exposes only the boolean wasMafiozo, never the role string.
 *   6. finalReveal carrying role identity appears ONLY when phase === FINAL_REVEAL.
 *
 * If any of these regress, this file fails BEFORE production.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');

function makeMockIo() {
  const events = [];
  return {
    to() { return { emit(event, payload) { events.push({ event, payload }); } }; },
    on() {},
    _events: events,
  };
}

function makeLobby({ revealMode = 'normal', phase = 'CLUE_REVEAL' } = {}) {
  const players = new Map();
  players.set(101, { id: 101, username: 'host_ccc', socketId: 's1', isHost: true,  isAlive: true });
  players.set(202, { id: 202, username: 'A',        socketId: 's2', isHost: false, isAlive: true });
  players.set(303, { id: 303, username: 'B',        socketId: 's3', isHost: false, isAlive: true });
  players.set(404, { id: 404, username: 'C',        socketId: 's4', isHost: false, isAlive: true });

  const roleAssignments = {
    202: { playerId: 202, username: 'A', gameRole: 'mafiozo',         storyCharacterName: 'X', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: true },
    303: { playerId: 303, username: 'B', gameRole: 'innocent',        storyCharacterName: 'Y', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: true },
    404: { playerId: 404, username: 'C', gameRole: 'obvious_suspect', storyCharacterName: 'Z', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: true },
  };

  return {
    id: 'ROOMX',
    creatorId: 101, hostId: 101, mode: 'AI',
    roleRevealMode: revealMode, state: 'IN_GAME',
    players,
    gameData: {
      archiveBase64: '', rawScenario: '',
      decodedArchive: { characters: [], mafiozo: 'X' },
      clues: ['c1', 'c2', 'c3'],
      clueIndex: 0,
      phase,
      timer: 0,
      interval: null,
      isPaused: false,
      votes: {},
      roleRevealMode: revealMode,
      roleAssignments,
      publicCharacterCards: [
        { playerId: 202, username: 'A', storyCharacterName: 'X', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
        { playerId: 303, username: 'B', storyCharacterName: 'Y', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
        { playerId: 404, username: 'C', storyCharacterName: 'Z', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
      ],
      votingHistory: [],
      eliminatedIds: [],
      outcome: null,
      lastVoteResult: null,
    },
  };
}

/**
 * Recursively scan an object for any property named 'gameRole'. Used to
 * assert that broadcast payloads cannot leak the field anywhere — not just
 * at the top level. We exclude the legitimate FINAL_REVEAL path explicitly
 * in the test that allows it.
 */
function containsGameRole(obj) {
  if (obj === null || obj === undefined) return false;
  if (Array.isArray(obj)) return obj.some(containsGameRole);
  if (typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    if (k === 'gameRole') return true;
    if (containsGameRole(obj[k])) return true;
  }
  return false;
}

function cleanup(lobby) {
  if (lobby && lobby.gameData && lobby.gameData.interval) {
    clearInterval(lobby.gameData.interval);
    lobby.gameData.interval = null;
  }
}

// ---------------------------------------------------------------------------

test('1. buildPublicState before FINAL_REVEAL contains no gameRole anywhere', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeLobby({ phase: 'CLUE_REVEAL' });
  gm.lobbies.set('ROOMX', lobby);

  const state = gm.buildPublicState('ROOMX');
  assert.ok(state, 'state exists');
  assert.equal(containsGameRole(state), false,
    'no gameRole anywhere in buildPublicState payload');

  // Belt-and-suspenders: per-player projection is sanitized too.
  for (const p of state.players) {
    assert.equal('gameRole' in p, false, `player ${p.id} has no gameRole`);
    assert.equal('role' in p, false,     `player ${p.id} has no role`);
    assert.equal('storyCharacterName' in p, false,
      `player ${p.id} has no storyCharacterName (lives in publicCharacterCards)`);
  }

  // finalReveal must not be present pre-FINAL_REVEAL.
  assert.equal(state.finalReveal, undefined,
    'finalReveal must be undefined before phase === FINAL_REVEAL');
});

test('2. publicCharacterCards carry only the allow-listed public fields', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeLobby({ phase: 'PUBLIC_CHARACTER_OVERVIEW' });
  gm.lobbies.set('ROOMX', lobby);

  const state = gm.buildPublicState('ROOMX');
  const allowed = new Set(['playerId', 'username', 'storyCharacterName', 'storyCharacterRole', 'suspiciousDetail']);
  assert.ok(Array.isArray(state.publicCharacterCards));
  assert.ok(state.publicCharacterCards.length > 0);

  for (const card of state.publicCharacterCards) {
    for (const k of Object.keys(card)) {
      assert.ok(allowed.has(k), `unexpected key on public character card: ${k}`);
    }
    assert.equal('gameRole' in card, false);
    assert.equal('role' in card, false);
  }
});

test('3. Blind-mode private role card OMITS the gameRole key entirely', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeLobby({ revealMode: 'blind' });

  const card = gm.buildPrivateRoleCard(lobby, lobby.gameData.roleAssignments[202]);
  // hasOwnProperty: confirm the KEY itself is absent — not just nullish.
  assert.equal(Object.prototype.hasOwnProperty.call(card, 'gameRole'), false,
    'gameRole key must not exist on the wire in blind mode');
  assert.equal(Object.prototype.hasOwnProperty.call(card, 'roleLabelArabic'), false,
    'roleLabelArabic key must not exist on the wire in blind mode');
  assert.equal(card.mode, 'blind');
  // Public-safe fields still present.
  assert.equal(card.playerId, 202);
  assert.equal(card.username, 'A');
});

test('4. Normal-mode private role card carries only the local player\'s gameRole', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeLobby({ revealMode: 'normal' });

  const cardA = gm.buildPrivateRoleCard(lobby, lobby.gameData.roleAssignments[202]);
  assert.equal(cardA.mode, 'normal');
  assert.equal(cardA.gameRole, 'mafiozo');
  assert.equal(cardA.playerId, 202);
  assert.equal(cardA.username, 'A');

  const cardB = gm.buildPrivateRoleCard(lobby, lobby.gameData.roleAssignments[303]);
  assert.equal(cardB.gameRole, 'innocent');
  assert.equal(cardB.playerId, 303);

  // Cross-leak guard: A's card must not carry B's identity, and vice versa.
  assert.notEqual(cardA.username, cardB.username);
  assert.notEqual(cardA.gameRole, cardB.gameRole);
  // Card is for the local player only — does not include any "otherPlayers" array.
  assert.equal('otherPlayers' in cardA, false);
  assert.equal('roleAssignments' in cardA, false);
});

test('5. vote_result payload exposes only wasMafiozo boolean, never the role string', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = makeLobby({ phase: 'VOTING' });
  gm.lobbies.set('ROOMX', lobby);
  lobby.gameData.votes = { 202: 202, 303: 202, 404: 202 };
  gm.closeVoting('ROOMX', 'all_voted');

  const vr = io._events.find(e => e.event === 'vote_result').payload;
  assert.equal('roleAssignments' in vr, false, 'roleAssignments must never appear in vote_result');
  assert.equal('gameRole' in vr, false, 'gameRole must never appear in vote_result');
  assert.equal(typeof vr.wasMafiozo, 'boolean', 'wasMafiozo is a boolean signal, not a role label');

  const allowed = new Set([
    'round', 'eliminatedId', 'eliminatedUsername', 'wasMafiozo', 'reason',
    'tally', 'eligibleCount', 'votedCount',
  ]);
  for (const k of Object.keys(vr)) {
    assert.ok(allowed.has(k), `unexpected key on vote_result: ${k}`);
  }
  cleanup(lobby);
});

test('E1. buildPublicState.customConfig surfaces only public metadata (no roles, no identities)', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeLobby({ phase: 'CLUE_REVEAL' });
  // Inject a custom config simulating create_room having normalized one.
  lobby.config = { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4, obviousSuspectEnabled: true };
  gm.lobbies.set('ROOMX', lobby);
  const state = gm.buildPublicState('ROOMX');
  assert.ok(state.customConfig, 'customConfig present when isCustom');
  // Allow-list pin: only safe public metadata fields surface.
  const allowed = new Set(['isCustom', 'playerCount', 'mafiozoCount', 'clueCount']);
  for (const k of Object.keys(state.customConfig)) {
    assert.ok(allowed.has(k), `unexpected key on customConfig: ${k}`);
  }
  // Roles / hidden truth never appear on the customConfig surface.
  assert.equal('roleAssignments' in state.customConfig, false);
  assert.equal('mafiozoUsername' in state.customConfig, false);
  assert.equal('obviousSuspectEnabled' in state.customConfig, false);
});

test('6. finalReveal role data appears ONLY when phase === FINAL_REVEAL', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeLobby({ phase: 'CLUE_REVEAL' });
  gm.lobbies.set('ROOMX', lobby);

  // Pre-FINAL_REVEAL: even if finalReveal were stuffed onto gameData, the
  // builder must hide it. Stuff a stub to prove the gate works.
  lobby.gameData.finalReveal = { truth: { mafiozoUsername: 'A', leaked: 'X' } };
  const before = gm.buildPublicState('ROOMX');
  assert.equal(before.finalReveal, undefined,
    'finalReveal must be undefined while phase !== FINAL_REVEAL, even if gd.finalReveal is set');

  // Now flip to FINAL_REVEAL and rebuild. The reveal IS allowed to mention
  // roles because the game is over and the privacy invariant is satisfied.
  lobby.gameData.phase = 'FINAL_REVEAL';
  lobby.gameData.outcome = 'investigators_win';
  // Use the manager's own builder for realism.
  lobby.gameData.finalReveal = gm.buildFinalReveal(lobby);
  const after = gm.buildPublicState('ROOMX');
  assert.ok(after.finalReveal, 'finalReveal present at FINAL_REVEAL');
  // Contract: if any gameRole leaks before FINAL_REVEAL, the test in #1 catches it.
  // Here we only verify the gate semantics, not the reveal content schema.
});
