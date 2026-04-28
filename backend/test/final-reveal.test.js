/**
 * E3 — multi-Mafiozo final reveal tests.
 *
 * Verifies buildFinalReveal produces:
 *   - truth.mafiozos array of length === mafiozoCount
 *   - legacy singular fields preserved for backwards-compat with older
 *     cached frontend builds
 *   - per-Mafiozo eliminatedAtRound + survived booleans
 *   - finalReveal still gated to FINAL_REVEAL phase in buildPublicState
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');

function makeMockIo() {
  return { to() { return { emit() {} }; }, on() {}, _events: [] };
}

function makeFinishedLobby({ mafiozoIds = [202], outcome = 'investigators_win', votingHistory = [] } = {}) {
  const players = new Map();
  players.set(101, { id: 101, username: 'host', socketId: 's1', isHost: true,  isAlive: true });
  players.set(202, { id: 202, username: 'A',    socketId: 's2', isHost: false, isAlive: true });
  players.set(303, { id: 303, username: 'B',    socketId: 's3', isHost: false, isAlive: true });
  players.set(404, { id: 404, username: 'C',    socketId: 's4', isHost: false, isAlive: true });
  players.set(505, { id: 505, username: 'D',    socketId: 's5', isHost: false, isAlive: true });

  const roleAssignments = {};
  for (const id of [202, 303, 404, 505]) {
    const isMafiozo = mafiozoIds.includes(id);
    roleAssignments[id] = {
      playerId: id,
      username: players.get(id).username,
      gameRole: isMafiozo ? 'mafiozo' : (id === 404 ? 'obvious_suspect' : 'innocent'),
      storyCharacterName: `Char_${id}`,
      storyCharacterRole: 'Role',
      suspiciousDetail: `Detail_${id}`,
      isAlive: true,
    };
  }

  return {
    id: 'ROOMR',
    creatorId: 101, hostId: 101, mode: 'AI',
    roleRevealMode: 'normal', state: 'IN_GAME',
    config: mafiozoIds.length > 1
      ? { isCustom: true, playerCount: 4, mafiozoCount: mafiozoIds.length, clueCount: 3, obviousSuspectEnabled: true }
      : null,
    players,
    gameData: {
      archiveBase64: '', rawScenario: '',
      decodedArchive: { title: 'Test Case', characters: [], clues: ['c1', 'c2', 'c3'] },
      clues: ['c1', 'c2', 'c3'],
      clueIndex: 2,
      phase: 'FINAL_REVEAL',
      timer: 0,
      roleRevealMode: 'normal',
      roleAssignments,
      publicCharacterCards: [],
      votingHistory,
      eliminatedIds: [],
      outcome,
      lastVoteResult: null,
      finalReveal: null,
    },
  };
}

test('E3.1 buildFinalReveal default 1-Mafiozo → truth.mafiozos length === 1', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeFinishedLobby({
    mafiozoIds: [202],
    outcome: 'investigators_win',
    votingHistory: [{ round: 2, eliminatedId: 202, eliminatedUsername: 'A', wasMafiozo: true, reason: 'majority' }],
  });
  const reveal = gm.buildFinalReveal(lobby);
  assert.ok(reveal.truth);
  assert.ok(Array.isArray(reveal.truth.mafiozos));
  assert.equal(reveal.truth.mafiozos.length, 1);
  assert.equal(reveal.truth.mafiozoCount, 1);
  // Legacy singular fields preserved (older cached clients still render).
  assert.equal(reveal.truth.mafiozoUsername, 'A');
  assert.equal(reveal.truth.mafiozoCharacterName, 'Char_202');
  assert.equal(reveal.truth.mafiozoStoryRole, 'Role');
  assert.equal(reveal.truth.mafiozoSuspiciousDetail, 'Detail_202');
  // Array item matches the legacy singular projection.
  const m = reveal.truth.mafiozos[0];
  assert.equal(m.username, 'A');
  assert.equal(m.characterName, 'Char_202');
  assert.equal(m.eliminatedAtRound, 2);
  assert.equal(m.survived, false);
});

test('E3.2 buildFinalReveal 2-Mafiozo investigators_win → array length 2 with both eliminated', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeFinishedLobby({
    mafiozoIds: [202, 303],
    outcome: 'investigators_win',
    votingHistory: [
      { round: 1, eliminatedId: 202, eliminatedUsername: 'A', wasMafiozo: true, reason: 'majority' },
      { round: 2, eliminatedId: 303, eliminatedUsername: 'B', wasMafiozo: true, reason: 'majority' },
    ],
  });
  const reveal = gm.buildFinalReveal(lobby);
  assert.equal(reveal.truth.mafiozos.length, 2);
  assert.equal(reveal.truth.mafiozoCount, 2);
  // Each item has the documented shape.
  for (const m of reveal.truth.mafiozos) {
    assert.ok(m.username && m.characterName && m.suspiciousDetail);
    assert.ok(typeof m.explanation === 'string' && m.explanation.length > 0);
    assert.equal(m.survived, false);
    assert.ok(Number.isFinite(m.eliminatedAtRound));
  }
  // Legacy singular fields seed from the FIRST Mafiozo encountered.
  assert.ok(reveal.truth.mafiozoUsername === 'A' || reveal.truth.mafiozoUsername === 'B');
});

test('E3.3 buildFinalReveal 2-Mafiozo mafiozo_survives → at least one survived=true', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeFinishedLobby({
    mafiozoIds: [202, 303],
    outcome: 'mafiozo_survives',
    votingHistory: [
      { round: 1, eliminatedId: 404, eliminatedUsername: 'C', wasMafiozo: false, reason: 'majority' },
      { round: 2, eliminatedId: 202, eliminatedUsername: 'A', wasMafiozo: true,  reason: 'majority' },
      { round: 3, eliminatedId: null, wasMafiozo: false, reason: 'no-vote' },
    ],
  });
  const reveal = gm.buildFinalReveal(lobby);
  assert.equal(reveal.truth.mafiozos.length, 2);
  const survivors = reveal.truth.mafiozos.filter(m => m.survived === true);
  assert.ok(survivors.length >= 1, 'at least one Mafiozo should be marked survived');
});

test('E3.4 each mafiozo item carries username/characterName/storyRole/suspiciousDetail', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeFinishedLobby({ mafiozoIds: [202, 303], outcome: 'investigators_win' });
  const reveal = gm.buildFinalReveal(lobby);
  for (const m of reveal.truth.mafiozos) {
    assert.ok(m.username);
    assert.ok(m.characterName);
    assert.ok(m.storyRole);
    assert.ok(m.suspiciousDetail);
  }
});

test('E3.5 buildPublicState gates finalReveal to FINAL_REVEAL phase only', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeFinishedLobby({ mafiozoIds: [202, 303] });
  // Stuff a finalReveal but mark phase as CLUE_REVEAL.
  lobby.gameData.phase = 'CLUE_REVEAL';
  lobby.gameData.finalReveal = { truth: { mafiozos: [{ username: 'LEAK' }] } };
  gm.lobbies.set('ROOMR', lobby);
  const state = gm.buildPublicState('ROOMR');
  assert.equal(state.finalReveal, undefined,
    'finalReveal must be undefined while phase !== FINAL_REVEAL');
});

test('E3.6 pre-FINAL_REVEAL buildPublicState does NOT include truth.mafiozos anywhere', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeFinishedLobby({ mafiozoIds: [202, 303] });
  lobby.gameData.phase = 'CLUE_REVEAL';
  lobby.gameData.finalReveal = { truth: { mafiozos: [{ username: 'LEAK_USER', characterName: 'LEAK_CHAR' }] } };
  gm.lobbies.set('ROOMR', lobby);
  const state = gm.buildPublicState('ROOMR');
  const ser = JSON.stringify(state);
  assert.equal(ser.includes('LEAK_USER'), false, 'no truth.mafiozos username in pre-reveal payload');
  assert.equal(ser.includes('LEAK_CHAR'), false, 'no truth.mafiozos characterName in pre-reveal payload');
});

test('E3.7 single-Mafiozo legacy clients still see singular fields populated', () => {
  // Simulates an old cached frontend reading data.truth.mafiozoUsername.
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeFinishedLobby({
    mafiozoIds: [202],
    outcome: 'investigators_win',
    votingHistory: [{ round: 1, eliminatedId: 202, eliminatedUsername: 'A', wasMafiozo: true, reason: 'majority' }],
  });
  const reveal = gm.buildFinalReveal(lobby);
  // Legacy fields populated:
  assert.equal(reveal.truth.mafiozoUsername, 'A');
  assert.equal(reveal.truth.mafiozoCharacterName, 'Char_202');
  // And new array also populated for new clients:
  assert.equal(reveal.truth.mafiozos.length, 1);
});
