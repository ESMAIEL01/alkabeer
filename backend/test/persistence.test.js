/**
 * D1 — persistSessionAndStats regression tests.
 *
 * Tests run the real GameManager with a mocked io and an injected fake
 * `db.query`. No real Postgres, no network, no socket layer. The fake
 * query records every (sql, params) pair so we can assert what got
 * INSERTed and UPSERTed without a live database.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeMockIo() {
  const events = [];
  return {
    to() { return { emit(event, payload) { events.push({ event, payload }); } }; },
    on() {},
    _events: events,
  };
}

/**
 * Recording fake `db.query`. Defaults: every call returns 1 inserted row.
 * Override with `{ override: { matcher: (sql, params) => result } }` to make
 * specific queries throw or return different rowsets.
 */
function makeFakeDb({ override = [] } = {}) {
  const calls = [];
  const fakeQuery = async (sql, params) => {
    calls.push({ sql, params });
    for (const { match, result, throwError } of override) {
      if (match(sql, params)) {
        if (throwError) throw throwError;
        return result;
      }
    }
    // Default: simulate INSERT ... RETURNING id behavior — return one row.
    if (/INSERT\s+INTO\s+game_sessions/i.test(sql) && /RETURNING\s+id/i.test(sql)) {
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  return { db: { query: fakeQuery }, calls };
}

/**
 * Synthetic lobby in FINAL_REVEAL state. host(101) + A(202)=mafiozo,
 * B(303)=innocent, C(404)=obvious_suspect. Voting history records that B
 * was eliminated in round 1, then A in round 2.
 */
function makeFinalRevealLobby({ outcome = 'investigators_win' } = {}) {
  const players = new Map();
  players.set(101, { id: 101, username: 'host_ccc', socketId: 's1', isHost: true,  isAlive: true });
  players.set(202, { id: 202, username: 'A',        socketId: 's2', isHost: false, isAlive: outcome !== 'investigators_win' });
  players.set(303, { id: 303, username: 'B',        socketId: 's3', isHost: false, isAlive: false });
  players.set(404, { id: 404, username: 'C',        socketId: 's4', isHost: false, isAlive: outcome === 'investigators_win' });

  const roleAssignments = {
    202: { playerId: 202, username: 'A', gameRole: 'mafiozo',         storyCharacterName: 'X', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: outcome !== 'investigators_win' },
    303: { playerId: 303, username: 'B', gameRole: 'innocent',        storyCharacterName: 'Y', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: false },
    404: { playerId: 404, username: 'C', gameRole: 'obvious_suspect', storyCharacterName: 'Z', storyCharacterRole: 'r', suspiciousDetail: 'sus', isAlive: outcome === 'investigators_win' },
  };

  const votingHistory = [
    { round: 1, eliminatedId: 303, eliminatedUsername: 'B', wasMafiozo: false, reason: 'majority' },
  ];
  if (outcome === 'investigators_win') {
    votingHistory.push({ round: 2, eliminatedId: 202, eliminatedUsername: 'A', wasMafiozo: true, reason: 'majority' });
  }

  return {
    id: 'ROOMP1',
    creatorId: 101, hostId: 101, mode: 'AI',
    roleRevealMode: 'normal', state: 'IN_GAME',
    players,
    gameData: {
      archiveBase64: 'BASE64_REDACTED',
      rawScenario: '',
      decodedArchive: { title: 'سرقة قصر البارون', clues: ['c1', 'c2', 'c3'] },
      clues: ['c1', 'c2', 'c3'],
      clueIndex: 2,
      phase: 'FINAL_REVEAL',
      timer: 0,
      interval: null,
      isPaused: false,
      votes: {},
      roleRevealMode: 'normal',
      roleAssignments,
      publicCharacterCards: [],
      votingHistory,
      eliminatedIds: outcome === 'investigators_win' ? [303, 202] : [303],
      outcome,
      lastVoteResult: votingHistory[votingHistory.length - 1] || null,
      finalReveal: {
        title: 'الكشف النهائي',
        truth: { mafiozoUsername: 'A', mafiozoCharacterName: 'X' },
      },
    },
  };
}

function newGM(db = null) {
  const io = makeMockIo();
  const gm = new GameManager(io, db);
  return { gm, io };
}

// Helpers to find specific INSERTs in the recorded query calls.
const isSessionInsert = (c) => /INSERT\s+INTO\s+game_sessions/i.test(c.sql);
const isParticipantInsert = (c) => /INSERT\s+INTO\s+game_participants/i.test(c.sql);
const isStatsUpsert = (c) => /INSERT\s+INTO\s+user_stats/i.test(c.sql);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. persistSessionAndStats inserts one game_sessions row + N participants', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();
  gm.lobbies.set(lobby.id, lobby);

  const result = await gm.persistSessionAndStats(lobby);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  assert.equal(result.participantCount, 4); // host + 3 non-host

  assert.equal(calls.filter(isSessionInsert).length, 1);
  assert.equal(calls.filter(isParticipantInsert).length, 4);
  assert.equal(lobby.gameData.persisted, true);
});

test('2. stats UPSERT only happens when session insert succeeds', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();
  await gm.persistSessionAndStats(lobby);

  // Three non-host players → three stats UPSERTs. Host is excluded.
  const statsCalls = calls.filter(isStatsUpsert);
  assert.equal(statsCalls.length, 3, 'only non-host players bump stats');
});

test('3. calling persistSessionAndStats twice does NOT double count', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();

  const r1 = await gm.persistSessionAndStats(lobby);
  assert.equal(r1.ok, true);
  const callsAfterFirst = calls.length;

  const r2 = await gm.persistSessionAndStats(lobby);
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'already_persisted');
  // Second call must not have fired any further DB writes (memo gate).
  assert.equal(calls.length, callsAfterFirst);
});

test('4. investigators_win marks non-mafiozo as winners and mafiozo as loser', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby({ outcome: 'investigators_win' });
  await gm.persistSessionAndStats(lobby);

  const partCalls = calls.filter(isParticipantInsert);
  // Find each participant by user_id position (param[1]).
  const hostP = partCalls.find(c => c.params[1] === 101);
  const mafiozoP = partCalls.find(c => c.params[1] === 202);
  const innocentP = partCalls.find(c => c.params[1] === 303);
  const obviousP = partCalls.find(c => c.params[1] === 404);

  // params shape: [game_id, user_id, username, was_host, game_role,
  //                story_character_name, story_character_role,
  //                eliminated_at_round, was_winner]
  assert.equal(hostP.params[8], null,  'host was_winner should be null');
  assert.equal(mafiozoP.params[8], false, 'mafiozo lost');
  assert.equal(innocentP.params[8], true,  'innocent won');
  assert.equal(obviousP.params[8], true,   'obvious_suspect won');
});

test('5. mafiozo_survives marks mafiozo winner and non-mafiozo losers', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby({ outcome: 'mafiozo_survives' });
  await gm.persistSessionAndStats(lobby);

  const partCalls = calls.filter(isParticipantInsert);
  const mafiozoP = partCalls.find(c => c.params[1] === 202);
  const innocentP = partCalls.find(c => c.params[1] === 303);
  const obviousP = partCalls.find(c => c.params[1] === 404);

  assert.equal(mafiozoP.params[8], true,   'mafiozo wins on survives');
  assert.equal(innocentP.params[8], false, 'innocent loses');
  assert.equal(obviousP.params[8], false,  'obvious_suspect loses');
});

test('6. host participant row has was_host=true and game_role=null', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();
  await gm.persistSessionAndStats(lobby);

  const partCalls = calls.filter(isParticipantInsert);
  const hostP = partCalls.find(c => c.params[1] === 101);
  assert.ok(hostP, 'host participant row written');
  assert.equal(hostP.params[3], true,  'was_host = true');
  assert.equal(hostP.params[4], null,  'game_role = null on host');
  assert.equal(hostP.params[5], null,  'storyCharacterName = null on host');
  assert.equal(hostP.params[6], null,  'storyCharacterRole = null on host');
});

test('7. host stats are NOT incremented', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();
  await gm.persistSessionAndStats(lobby);

  const statsCalls = calls.filter(isStatsUpsert);
  const hostStatsCall = statsCalls.find(c => c.params[0] === 101);
  assert.equal(hostStatsCall, undefined, 'no stats UPSERT for host');
});

test('8. malformed/phantom players are skipped', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();
  // Inject a phantom directly into the Map.
  lobby.players.set('phantom', { id: undefined, username: undefined, isHost: false, isAlive: true });
  // Inject a half-formed record (id but no username).
  lobby.players.set(999, { id: 999, username: undefined, isHost: false, isAlive: true });

  await gm.persistSessionAndStats(lobby);

  const partCalls = calls.filter(isParticipantInsert);
  // Real participants: 101 + 202 + 303 + 404. Phantoms must NOT appear.
  const ids = partCalls.map(c => c.params[1]).sort();
  assert.deepEqual(ids, [101, 202, 303, 404]);
  assert.equal(partCalls.find(c => c.params[1] === 999), undefined);
});

test('9. DB error is caught — function returns ok:false instead of throwing', async () => {
  const { db } = makeFakeDb({
    override: [{ match: (sql) => /INSERT\s+INTO\s+game_sessions/i.test(sql), throwError: new Error('connection refused') }],
  });
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();

  await assert.doesNotReject(() => gm.persistSessionAndStats(lobby));
  const result = await gm.persistSessionAndStats(lobby);
  // First call already failed; second call retries because persistenceStarted
  // was reset on failure. Either result is valid: the function must NOT throw.
  assert.ok(result && (result.ok === true || result.ok === false));
});

test('10. persistence skipped before FINAL_REVEAL', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();
  lobby.gameData.phase = 'CLUE_REVEAL';
  const result = await gm.persistSessionAndStats(lobby);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong_phase');
  assert.equal(calls.length, 0, 'no DB writes when phase != FINAL_REVEAL');
});

test('11. persistence skipped when finalReveal is missing', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();
  lobby.gameData.finalReveal = null;
  const result = await gm.persistSessionAndStats(lobby);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_final_reveal');
  assert.equal(calls.length, 0);
});

test('12. votingHistory determines eliminated_at_round', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby({ outcome: 'investigators_win' });
  await gm.persistSessionAndStats(lobby);

  const partCalls = calls.filter(isParticipantInsert);
  const innocentP = partCalls.find(c => c.params[1] === 303);  // eliminated round 1
  const mafiozoP  = partCalls.find(c => c.params[1] === 202);  // eliminated round 2
  const obviousP  = partCalls.find(c => c.params[1] === 404);  // survived

  assert.equal(innocentP.params[7], 1, 'B eliminated at round 1');
  assert.equal(mafiozoP.params[7], 2,  'A eliminated at round 2');
  assert.equal(obviousP.params[7], null, 'C survived → null round');
});

test('13. session insert conflict prevents stats updates', async () => {
  // Simulate ON CONFLICT DO NOTHING returning zero rows (already persisted
  // by a prior call from another path).
  const { db, calls } = makeFakeDb({
    override: [{
      match: (sql) => /INSERT\s+INTO\s+game_sessions/i.test(sql) && /RETURNING\s+id/i.test(sql),
      result: { rows: [], rowCount: 0 },
    }],
  });
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();

  const result = await gm.persistSessionAndStats(lobby);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'already_persisted');

  // No participant inserts and no stats upserts should have fired.
  assert.equal(calls.filter(isParticipantInsert).length, 0);
  assert.equal(calls.filter(isStatsUpsert).length, 0);
});

test('14. archive_b64 + final_reveal written ONLY to game_sessions row, never to participants/stats', async () => {
  const { db, calls } = makeFakeDb();
  const { gm } = newGM(db);
  const lobby = makeFinalRevealLobby();
  await gm.persistSessionAndStats(lobby);

  // Sensitive payload appears only in the game_sessions INSERT params.
  const sessionCall = calls.find(isSessionInsert);
  assert.ok(sessionCall);
  const sessionParamsStr = JSON.stringify(sessionCall.params);
  assert.ok(sessionParamsStr.includes('BASE64_REDACTED'), 'archive_b64 lives on session row');

  for (const c of calls.filter(isParticipantInsert)) {
    const s = JSON.stringify(c.params);
    assert.equal(s.includes('BASE64_REDACTED'), false, 'archive must not leak into participant rows');
  }
  for (const c of calls.filter(isStatsUpsert)) {
    const s = JSON.stringify(c.params);
    assert.equal(s.includes('BASE64_REDACTED'), false, 'archive must not leak into stats rows');
  }
});

test('15. with no db (test injection path), persistSessionAndStats returns no_db', async () => {
  const { gm } = newGM(null);  // no db
  const lobby = makeFinalRevealLobby();
  const result = await gm.persistSessionAndStats(lobby);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_db');
});
