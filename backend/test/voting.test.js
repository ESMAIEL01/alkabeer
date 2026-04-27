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
