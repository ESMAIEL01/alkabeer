/**
 * Voting / role / phase regression tests.
 *
 * Tests run against the REAL GameManager with a mocked io. They:
 *   - construct a synthetic lobby with known roleAssignments
 *   - stuff lobby.gameData.votes directly
 *   - call gm.closeVoting('ROOMX', reason)
 *   - assert the broadcast vote_result payload AND the resulting lobby state
 *
 * No socket-handler extraction; no real Socket.IO server; no DB; no network.
 *
 * Why we go through closeVoting instead of the submit_vote handler: the
 * handler is currently inline inside socket.on('submit_vote', cb) and
 * extracting it is B2. The eligibility/target rules under test are enforced
 * INSIDE closeVoting (via the stale-target filter and the canonical-id
 * resolver), so testing closeVoting end-to-end exercises the rules.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');

// ---------------------------------------------------------------------------
// Test harness — mock io that records emits, factory for a fresh lobby.
// ---------------------------------------------------------------------------

function makeMockIo() {
  const events = [];
  return {
    to() {
      return {
        emit(event, payload) { events.push({ event, payload }); },
      };
    },
    on() {},
    _events: events,
  };
}

function newGM() {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  return { gm, io };
}

/**
 * 4-player lobby: host(101) + A(202)=mafiozo + B(303)=innocent + C(404)=obvious_suspect.
 * Pre-eliminate via { eliminate: [id, ...] } if needed.
 */
function makeLobby({ eliminate = [], clueIndex = 0 } = {}) {
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

  for (const id of eliminate) {
    if (players.has(id)) players.get(id).isAlive = false;
    if (roleAssignments[id]) roleAssignments[id].isAlive = false;
  }

  return {
    id: 'ROOMX',
    creatorId: 101, hostId: 101, mode: 'AI',
    roleRevealMode: 'normal', state: 'IN_GAME',
    players,
    gameData: {
      archiveBase64: '', rawScenario: '',
      decodedArchive: { characters: [], mafiozo: 'X' },
      clues: ['c1', 'c2', 'c3'],
      clueIndex,
      phase: 'VOTING',
      timer: 30,
      interval: null,
      isPaused: false,
      votes: {},
      roleRevealMode: 'normal',
      roleAssignments,
      publicCharacterCards: [
        { playerId: 202, username: 'A', storyCharacterName: 'X', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
        { playerId: 303, username: 'B', storyCharacterName: 'Y', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
        { playerId: 404, username: 'C', storyCharacterName: 'Z', storyCharacterRole: 'r', suspiciousDetail: 'sus' },
      ],
      votingHistory: [],
      eliminatedIds: eliminate.slice(),
      outcome: null,
      lastVoteResult: null,
    },
  };
}

function lastVoteResult(io) {
  const e = io._events.filter(e => e.event === 'vote_result').pop();
  return e ? e.payload : null;
}

/**
 * closeVoting transitions to VOTE_RESULT and (re)starts the per-room timer
 * via setInterval. Tests must clear that interval or the test process never
 * exits. cleanup() is safe to call multiple times.
 */
function cleanup(lobby) {
  if (lobby && lobby.gameData && lobby.gameData.interval) {
    clearInterval(lobby.gameData.interval);
    lobby.gameData.interval = null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. Mafiozo eliminated by majority sets investigators_win', () => {
  const { gm, io } = newGM();
  const lobby = makeLobby();
  gm.lobbies.set('ROOMX', lobby);
  lobby.gameData.votes = { 202: 202, 303: 202, 404: 202 };
  gm.closeVoting('ROOMX', 'all_voted');

  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 202);
  assert.equal(vr.eliminatedUsername, 'A');
  assert.equal(vr.wasMafiozo, true);
  assert.equal(vr.reason, 'majority');
  assert.equal(lobby.gameData.outcome, 'investigators_win');
  assert.equal(lobby.players.get(202).isAlive, false);
  assert.equal(lobby.gameData.roleAssignments[202].isAlive, false);
  assert.deepEqual(lobby.gameData.eliminatedIds, [202]);
  cleanup(lobby);
});

test('2. Innocent eliminated by majority — game continues', () => {
  const { gm, io } = newGM();
  const lobby = makeLobby();
  gm.lobbies.set('ROOMX', lobby);
  lobby.gameData.votes = { 202: 303, 303: 303, 404: 303 };
  gm.closeVoting('ROOMX', 'all_voted');

  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 303);
  assert.equal(vr.eliminatedUsername, 'B');
  assert.equal(vr.wasMafiozo, false);
  assert.equal(vr.reason, 'majority');
  assert.equal(lobby.gameData.outcome, null, 'game must continue when innocent dies');
  assert.equal(lobby.players.get(303).isAlive, false);
  cleanup(lobby);
});

test('3. Tie — no elimination', () => {
  const { gm, io } = newGM();
  const lobby = makeLobby();
  gm.lobbies.set('ROOMX', lobby);
  // 202→303, 303→202 → 1-1 tie. C abstains.
  lobby.gameData.votes = { 202: 303, 303: 202 };
  gm.closeVoting('ROOMX', 'timer');

  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, null);
  assert.equal(vr.reason, 'tie');
  assert.equal(lobby.gameData.outcome, null);
  cleanup(lobby);
});

test('4. No vote — no elimination', () => {
  const { gm, io } = newGM();
  const lobby = makeLobby();
  gm.lobbies.set('ROOMX', lobby);
  lobby.gameData.votes = {};
  gm.closeVoting('ROOMX', 'timer');

  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, null);
  assert.equal(vr.reason, 'no-vote');
  assert.equal(lobby.gameData.outcome, null);
  cleanup(lobby);
});

test('5. All skip — no elimination', () => {
  const { gm, io } = newGM();
  const lobby = makeLobby();
  gm.lobbies.set('ROOMX', lobby);
  lobby.gameData.votes = { 202: 'skip', 303: 'skip', 404: 'skip' };
  gm.closeVoting('ROOMX', 'all_voted');

  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, null);
  assert.equal(vr.reason, 'all-skip');
  assert.equal(lobby.gameData.outcome, null);
  cleanup(lobby);
});

test('6. Final-round all-skip — outcome is mafiozo_survives', () => {
  const { gm } = newGM();
  const lobby = makeLobby({ clueIndex: 2 }); // last clue: clueIndex >= clues.length - 1
  gm.lobbies.set('ROOMX', lobby);
  lobby.gameData.votes = { 202: 'skip', 303: 'skip', 404: 'skip' };
  gm.closeVoting('ROOMX', 'all_voted');

  assert.equal(lobby.gameData.outcome, 'mafiozo_survives');
  cleanup(lobby);
});

test('7. String-id vote target still resolves through helpers', () => {
  const { gm, io } = newGM();
  const lobby = makeLobby();
  gm.lobbies.set('ROOMX', lobby);
  // JSON round-trip can flip Number↔String. Helpers must survive both.
  lobby.gameData.votes = { 202: '202', 303: '202', 404: '202' };
  gm.closeVoting('ROOMX', 'all_voted');

  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 202, 'canonical id is the live player.id (Number)');
  assert.equal(vr.wasMafiozo, true);
  assert.equal(lobby.gameData.outcome, 'investigators_win');
  cleanup(lobby);
});

test('8. Eliminated player still counts as a participant who voted', () => {
  const { gm, io } = newGM();
  // C(404) was eliminated in a prior round; the jury rule lets her vote on.
  const lobby = makeLobby({ eliminate: [404] });
  gm.lobbies.set('ROOMX', lobby);
  // A, B, eliminated C all vote innocent B.
  lobby.gameData.votes = { 202: 303, 303: 303, 404: 303 };
  gm.closeVoting('ROOMX', 'all_voted');

  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 303, 'B eliminated by 3 unanimous votes');
  assert.equal(vr.votedCount, 3, 'eliminated juror C counts as voted');
  assert.equal(vr.eligibleCount, 3, 'eligibleCount equals participant count');
  cleanup(lobby);
});

test('9. Eliminated player cannot be a vote target — stale-target filter drops all', () => {
  const { gm, io } = newGM();
  const lobby = makeLobby({ eliminate: [404] });
  gm.lobbies.set('ROOMX', lobby);
  // Everyone votes for already-eliminated C.
  lobby.gameData.votes = { 202: 404, 303: 404, 404: 404 };
  gm.closeVoting('ROOMX', 'all_voted');

  const vr = lastVoteResult(io);
  assert.equal(vr.reason, 'no-vote',
    'every vote for an eliminated target is stale → tally is empty → no-vote');
  assert.equal(vr.eliminatedId, null);
  // C remains eliminated (was already), no change to A or B.
  assert.equal(lobby.players.get(202).isAlive, true);
  assert.equal(lobby.players.get(303).isAlive, true);
  cleanup(lobby);
});

test('10. Stale target vote is ignored while valid votes still count', () => {
  const { gm, io } = newGM();
  const lobby = makeLobby({ eliminate: [303] });
  gm.lobbies.set('ROOMX', lobby);
  // A's vote targets eliminated B (stale). C votes A. B (eliminated juror) votes A.
  lobby.gameData.votes = { 202: 303 /* stale */, 303: 202, 404: 202 };
  gm.closeVoting('ROOMX', 'all_voted');

  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 202, 'A eliminated by 2 valid votes after stale drop');
  assert.equal(vr.wasMafiozo, true);
  assert.equal(vr.tally['303'], undefined, 'tally must not contain stale 303');
  cleanup(lobby);
});

test('11. Vote-extension threshold is ceil(70%) of voting participants (eliminated counted)', () => {
  const { gm } = newGM();
  const lobby = makeLobby({ eliminate: [404] });
  gm.lobbies.set('ROOMX', lobby);
  // 3 non-host participants: A alive, B alive, C eliminated juror.
  const participants = gm.getVotingParticipants(lobby);
  assert.equal(participants.length, 3, 'eliminated juror counted in participants');
  const required = Math.max(1, Math.ceil(participants.length * 0.7));
  assert.equal(required, 3, 'ceil(3 * 0.7) === 3');

  // Sanity: with 4 participants, threshold drops to 3.
  const lobby4 = makeLobby();
  // Add a 5th non-host so total non-host = 4.
  lobby4.players.set(505, { id: 505, username: 'D', socketId: 's5', isHost: false, isAlive: true });
  const p4 = gm.getVotingParticipants(lobby4);
  assert.equal(p4.length, 4);
  assert.equal(Math.ceil(p4.length * 0.7), 3);
});

test('12. Ready-to-vote participants include eliminated players; targets exclude them', () => {
  const { gm } = newGM();
  const lobby = makeLobby({ eliminate: [303] });
  gm.lobbies.set('ROOMX', lobby);

  const participantIds = gm.getVotingParticipants(lobby).map(p => p.id).sort();
  assert.deepEqual(participantIds, [202, 303, 404],
    'eliminated B(303) still listed as voting participant');

  const targetIds = gm.getVoteTargets(lobby).map(p => p.id).sort();
  assert.deepEqual(targetIds, [202, 404],
    'eliminated B(303) excluded from vote targets');

  assert.equal(gm.isValidVoteTarget(lobby, 202), true,  'alive non-host → valid target');
  assert.equal(gm.isValidVoteTarget(lobby, 303), false, 'eliminated → not a target');
  assert.equal(gm.isValidVoteTarget(lobby, 101), false, 'host → not a target');
  assert.equal(gm.isValidVoteTarget(lobby, 999), false, 'unknown id → not a target');
});

// ---------------------------------------------------------------------------
// E2 — Multi-Mafiozo voting + win conditions.
// ---------------------------------------------------------------------------

/**
 * Build a 5-player multi-Mafiozo lobby: host(101) + A(202)=mafiozo,
 * B(303)=mafiozo, C(404)=innocent, D(505)=innocent, E(606)=obvious_suspect.
 */
function makeMultiLobby({ eliminate = [], clueIndex = 0, clueCount = 3 } = {}) {
  const players = new Map();
  players.set(101, { id: 101, username: 'host', socketId: 's1', isHost: true,  isAlive: true });
  players.set(202, { id: 202, username: 'A',    socketId: 's2', isHost: false, isAlive: true });
  players.set(303, { id: 303, username: 'B',    socketId: 's3', isHost: false, isAlive: true });
  players.set(404, { id: 404, username: 'C',    socketId: 's4', isHost: false, isAlive: true });
  players.set(505, { id: 505, username: 'D',    socketId: 's5', isHost: false, isAlive: true });
  players.set(606, { id: 606, username: 'E',    socketId: 's6', isHost: false, isAlive: true });

  const roleAssignments = {
    202: { playerId: 202, username: 'A', gameRole: 'mafiozo',         storyCharacterName: 'Sa', storyCharacterRole: 'r', suspiciousDetail: '...', isAlive: true },
    303: { playerId: 303, username: 'B', gameRole: 'mafiozo',         storyCharacterName: 'Sb', storyCharacterRole: 'r', suspiciousDetail: '...', isAlive: true },
    404: { playerId: 404, username: 'C', gameRole: 'innocent',        storyCharacterName: 'Sc', storyCharacterRole: 'r', suspiciousDetail: '...', isAlive: true },
    505: { playerId: 505, username: 'D', gameRole: 'innocent',        storyCharacterName: 'Sd', storyCharacterRole: 'r', suspiciousDetail: '...', isAlive: true },
    606: { playerId: 606, username: 'E', gameRole: 'obvious_suspect', storyCharacterName: 'Se', storyCharacterRole: 'r', suspiciousDetail: '...', isAlive: true },
  };
  for (const id of eliminate) {
    if (players.has(id)) players.get(id).isAlive = false;
    if (roleAssignments[id]) roleAssignments[id].isAlive = false;
  }
  return {
    id: 'ROOMM',
    creatorId: 101, hostId: 101, mode: 'AI',
    roleRevealMode: 'normal', state: 'IN_GAME',
    config: { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount, obviousSuspectEnabled: true },
    players,
    gameData: {
      archiveBase64: '', rawScenario: '',
      decodedArchive: { characters: [], mafiozo: 'X' },
      clues: Array.from({ length: clueCount }, (_, i) => `c${i + 1}`),
      clueIndex,
      phase: 'VOTING',
      timer: 30,
      interval: null,
      isPaused: false,
      votes: {},
      roleRevealMode: 'normal',
      roleAssignments,
      publicCharacterCards: [],
      votingHistory: [],
      eliminatedIds: eliminate.slice(),
      outcome: null,
      lastVoteResult: null,
    },
  };
}

test('E2.1 default 1-Mafiozo eliminated → investigators_win (regression of pre-E2 behavior)', () => {
  const { gm, io } = newGM();
  const lobby = makeLobby();  // 1 mafiozo (202)
  gm.lobbies.set('ROOMX', lobby);
  lobby.gameData.votes = { 202: 202, 303: 202, 404: 202 };
  gm.closeVoting('ROOMX', 'all_voted');
  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 202);
  assert.equal(vr.wasMafiozo, true);
  assert.equal(vr.totalMafiozos, 1, 'default games report totalMafiozos=1');
  assert.equal(vr.mafiozosRemaining, 0);
  assert.equal(lobby.gameData.outcome, 'investigators_win');
  cleanup(lobby);
});

test('E2.2 multi-Mafiozo: eliminate first Mafiozo → game continues, mafiozosRemaining=1', () => {
  const { gm, io } = newGM();
  const lobby = makeMultiLobby();
  gm.lobbies.set('ROOMM', lobby);
  // All non-host vote A (mafiozo #1).
  lobby.gameData.votes = { 202: 202, 303: 202, 404: 202, 505: 202, 606: 202 };
  gm.closeVoting('ROOMM', 'all_voted');
  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 202);
  assert.equal(vr.wasMafiozo, true);
  assert.equal(vr.totalMafiozos, 2);
  assert.equal(vr.mafiozosRemaining, 1, 'one Mafiozo still alive');
  assert.equal(lobby.gameData.outcome, null, 'game continues when Mafiozos remain');
  cleanup(lobby);
});

test('E2.3 multi-Mafiozo: eliminate second remaining Mafiozo → investigators_win', () => {
  const { gm, io } = newGM();
  const lobby = makeMultiLobby({ eliminate: [202], clueIndex: 1 });
  gm.lobbies.set('ROOMM', lobby);
  // A already eliminated. Now everyone (including jury voter A) votes B.
  lobby.gameData.votes = { 202: 303, 303: 303, 404: 303, 505: 303, 606: 303 };
  gm.closeVoting('ROOMM', 'all_voted');
  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 303);
  assert.equal(vr.wasMafiozo, true);
  assert.equal(vr.totalMafiozos, 2);
  assert.equal(vr.mafiozosRemaining, 0, 'all Mafiozos eliminated');
  assert.equal(lobby.gameData.outcome, 'investigators_win');
  cleanup(lobby);
});

test('E2.4 multi-Mafiozo: eliminate innocent on FINAL clue → mafiozo_survives', () => {
  const { gm, io } = newGM();
  const lobby = makeMultiLobby({ clueCount: 3, clueIndex: 2 }); // last clue
  gm.lobbies.set('ROOMM', lobby);
  // Everyone votes innocent C; both Mafiozos still alive afterward.
  lobby.gameData.votes = { 202: 404, 303: 404, 404: 404, 505: 404, 606: 404 };
  gm.closeVoting('ROOMM', 'all_voted');
  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 404);
  assert.equal(vr.wasMafiozo, false);
  assert.equal(vr.mafiozosRemaining, 2);
  assert.equal(lobby.gameData.outcome, 'mafiozo_survives');
  cleanup(lobby);
});

test('E2.5 multi-Mafiozo: tie on final clue with Mafiozos alive → mafiozo_survives', () => {
  const { gm, io } = newGM();
  const lobby = makeMultiLobby({ clueCount: 3, clueIndex: 2 });
  gm.lobbies.set('ROOMM', lobby);
  // Two players vote A, two vote B → 2-2 tie, no elimination.
  lobby.gameData.votes = { 202: 303, 303: 202, 404: 202, 505: 303 };
  gm.closeVoting('ROOMM', 'all_voted');
  const vr = lastVoteResult(io);
  assert.equal(vr.reason, 'tie');
  assert.equal(vr.eliminatedId, null);
  assert.equal(vr.mafiozosRemaining, 2);
  assert.equal(lobby.gameData.outcome, 'mafiozo_survives');
  cleanup(lobby);
});

test('E2.6 multi-Mafiozo: all-skip on final clue with Mafiozos alive → mafiozo_survives', () => {
  const { gm, io } = newGM();
  const lobby = makeMultiLobby({ clueCount: 3, clueIndex: 2 });
  gm.lobbies.set('ROOMM', lobby);
  lobby.gameData.votes = { 202: 'skip', 303: 'skip', 404: 'skip', 505: 'skip', 606: 'skip' };
  gm.closeVoting('ROOMM', 'all_voted');
  const vr = lastVoteResult(io);
  assert.equal(vr.reason, 'all-skip');
  assert.equal(vr.mafiozosRemaining, 2);
  assert.equal(lobby.gameData.outcome, 'mafiozo_survives');
  cleanup(lobby);
});

test('E2.7 vote_result payload includes mafiozosRemaining + totalMafiozos but NO roleAssignments / gameRole', () => {
  const { gm, io } = newGM();
  const lobby = makeMultiLobby();
  gm.lobbies.set('ROOMM', lobby);
  lobby.gameData.votes = { 202: 202, 303: 202, 404: 202, 505: 202, 606: 202 };
  gm.closeVoting('ROOMM', 'all_voted');
  const vr = lastVoteResult(io);
  assert.equal('mafiozosRemaining' in vr, true);
  assert.equal('totalMafiozos' in vr, true);
  assert.equal('roleAssignments' in vr, false);
  assert.equal('gameRole' in vr, false);
  // Allow-list pin: 10 documented keys.
  const allowed = new Set([
    'round', 'eliminatedId', 'eliminatedUsername', 'wasMafiozo', 'reason',
    'tally', 'eligibleCount', 'votedCount', 'mafiozosRemaining', 'totalMafiozos',
  ]);
  for (const k of Object.keys(vr)) {
    assert.ok(allowed.has(k), `unexpected key on vote_result: ${k}`);
  }
  cleanup(lobby);
});

test('E2.8 multi-Mafiozo: eliminated juror still votes (jury rule) in custom mode', () => {
  const { gm, io } = newGM();
  const lobby = makeMultiLobby({ eliminate: [404], clueIndex: 1 });  // C eliminated earlier
  gm.lobbies.set('ROOMM', lobby);
  // C still votes A (mafiozo #1); 4 alive non-host + 1 juror.
  lobby.gameData.votes = { 202: 202, 303: 202, 404: 202, 505: 202, 606: 202 };
  gm.closeVoting('ROOMM', 'all_voted');
  const vr = lastVoteResult(io);
  assert.equal(vr.eligibleCount, 5, 'all 5 non-host (including eliminated juror) counted');
  assert.equal(vr.votedCount, 5);
  assert.equal(vr.eliminatedId, 202);
  cleanup(lobby);
});

test('E2.9 multi-Mafiozo: stale vote on already-eliminated target dropped from tally', () => {
  const { gm, io } = newGM();
  const lobby = makeMultiLobby({ eliminate: [202], clueIndex: 1 });
  gm.lobbies.set('ROOMM', lobby);
  // Half the lobby votes for already-eliminated A (stale); rest vote B.
  lobby.gameData.votes = { 202: 303, 303: 303, 404: 202 /* stale */, 505: 303, 606: 202 /* stale */ };
  gm.closeVoting('ROOMM', 'all_voted');
  const vr = lastVoteResult(io);
  assert.equal(vr.eliminatedId, 303, 'B eliminated by 3 valid votes (stale 202 entries dropped)');
  assert.equal(vr.tally['202'], undefined, 'tally must not contain stale 202');
  cleanup(lobby);
});

test('E2.10 multi-Mafiozo: vote-extension threshold uses participants count', () => {
  const { gm } = newGM();
  const lobby = makeMultiLobby({ eliminate: [404] });
  gm.lobbies.set('ROOMM', lobby);
  // 5 non-host (4 alive + 1 eliminated juror).
  const participants = gm.getVotingParticipants(lobby);
  assert.equal(participants.length, 5);
  const required = Math.max(1, Math.ceil(participants.length * 0.7));
  assert.equal(required, 4, 'ceil(5 * 0.7) === 4');
});
