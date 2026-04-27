/**
 * D4 — archive replay helper tests.
 *
 * Imports from routes/archive-helpers.js only — no express, no DB, no JWT.
 * The full route surface is exercised in CI (npm ci installs everything).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  canReadArchive,
  mapSessionRow,
  mapParticipantRow,
  buildCallerSummary,
  sanitizeVotingHistory,
} = require('../routes/archive-helpers');

// ---------------------------------------------------------------------------
// canReadArchive — participant gate + admin escape hatch
// ---------------------------------------------------------------------------

const PARTICIPANTS = [
  { user_id: 101, username: 'host', was_host: true },
  { user_id: 202, username: 'A',    was_host: false },
  { user_id: 303, username: 'B',    was_host: false },
];

test('canReadArchive: caller who participated → true', () => {
  assert.equal(canReadArchive(PARTICIPANTS, 202, false), true);
  assert.equal(canReadArchive(PARTICIPANTS, 101, false), true);
});

test('canReadArchive: non-participant → false', () => {
  assert.equal(canReadArchive(PARTICIPANTS, 999, false), false);
  assert.equal(canReadArchive(PARTICIPANTS, null,  false), false);
  assert.equal(canReadArchive(PARTICIPANTS, undefined, false), false);
});

test('canReadArchive: admin → true even if not in participants', () => {
  assert.equal(canReadArchive(PARTICIPANTS, 999, true), true);
});

test('canReadArchive: defensive against bad inputs', () => {
  assert.equal(canReadArchive(null,      202, false), false);
  assert.equal(canReadArchive(undefined, 202, false), false);
  assert.equal(canReadArchive('not array', 202, false), false);
  assert.equal(canReadArchive([null, undefined, {}], 202, false), false);
});

test('canReadArchive: tolerates string vs number id mismatch (Postgres int vs JSON)', () => {
  // Postgres SERIAL returns Number; some payloads might stringify.
  assert.equal(canReadArchive([{ user_id: '202' }], 202,   false), true);
  assert.equal(canReadArchive([{ user_id: 202 }],   '202', false), true);
});

// ---------------------------------------------------------------------------
// mapSessionRow — privacy + camelCase mapping
// ---------------------------------------------------------------------------

test('mapSessionRow: maps allow-listed columns to camelCase', () => {
  const m = mapSessionRow({
    id: 'ROOM1',
    scenario_title: 'سرقة قصر البارون',
    host_mode: 'AI',
    reveal_mode: 'normal',
    custom_config: null,
    outcome: 'investigators_win',
    ended_at: 't_end',
    created_at: 't_start',
  });
  assert.equal(m.id, 'ROOM1');
  assert.equal(m.scenarioTitle, 'سرقة قصر البارون');
  assert.equal(m.hostMode, 'AI');
  assert.equal(m.revealMode, 'normal');
  assert.equal(m.outcome, 'investigators_win');
  assert.equal(m.endedAt, 't_end');
  assert.equal(m.createdAt, 't_start');
});

test('mapSessionRow: NEVER surfaces archive_b64, host_user_id, voting_history, final_reveal at this layer', () => {
  const m = mapSessionRow({
    id: 'ROOM2',
    scenario_title: 'X',
    host_mode: 'AI',
    reveal_mode: 'normal',
    archive_b64: 'BASE64_LEAK',
    host_user_id: 42,
    voting_history: [{ voter: 1, target: 2 }],
    final_reveal: { secret: 'truth' },
    password: 'leak',
    JWT_SECRET: 'leak',
  });
  for (const k of ['archive_b64', 'host_user_id', 'voting_history', 'final_reveal',
                   'password', 'JWT_SECRET', 'votingHistory', 'finalReveal']) {
    assert.equal(k in m, false, `mapSessionRow must not surface ${k}`);
  }
  const s = JSON.stringify(m);
  for (const leak of ['BASE64_LEAK', '"truth"', 'JWT_SECRET']) {
    assert.equal(s.includes(leak), false, `serialized session must not contain ${leak}`);
  }
});

test('mapSessionRow: surfaces only the documented field set (allow-list pin)', () => {
  const m = mapSessionRow({
    id: 'X', scenario_title: 'T', host_mode: 'AI', reveal_mode: 'normal',
    custom_config: { mafiozoCount: 1 }, outcome: 'investigators_win',
    ended_at: 'e', created_at: 'c',
  });
  const allowed = new Set([
    'id', 'scenarioTitle', 'hostMode', 'revealMode',
    'outcome', 'customConfig', 'endedAt', 'createdAt',
  ]);
  for (const k of Object.keys(m)) {
    assert.ok(allowed.has(k), `unexpected key on session row: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// mapParticipantRow
// ---------------------------------------------------------------------------

test('mapParticipantRow: maps DB row to public participant shape', () => {
  const p = mapParticipantRow({
    user_id: 202, username: 'A', was_host: false,
    game_role: 'mafiozo', story_character_name: 'X', story_character_role: 'r',
    eliminated_at_round: 2, was_winner: false,
  });
  assert.equal(p.userId, 202);
  assert.equal(p.username, 'A');
  assert.equal(p.wasHost, false);
  assert.equal(p.gameRole, 'mafiozo');
  assert.equal(p.storyCharacterName, 'X');
  assert.equal(p.storyCharacterRole, 'r');
  assert.equal(p.eliminatedAtRound, 2);
  assert.equal(p.wasWinner, false);
});

test('mapParticipantRow: allow-list pin — no extra keys', () => {
  const p = mapParticipantRow({
    user_id: 202, username: 'A', was_host: false,
    game_role: 'mafiozo', story_character_name: 'X', story_character_role: 'r',
    eliminated_at_round: 2, was_winner: false,
    // Hostile extras that must NOT come through.
    password_hash: 'leak', email: 'leak@x.com', token: 'leak',
  });
  const allowed = new Set([
    'userId', 'username', 'wasHost', 'gameRole',
    'storyCharacterName', 'storyCharacterRole',
    'eliminatedAtRound', 'wasWinner',
  ]);
  for (const k of Object.keys(p)) {
    assert.ok(allowed.has(k), `unexpected key on participant row: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// buildCallerSummary
// ---------------------------------------------------------------------------

test('buildCallerSummary: returns null-defaults when no participant row', () => {
  const c = buildCallerSummary(null);
  assert.equal(c.role, null);
  assert.equal(c.storyCharacterName, null);
  assert.equal(c.storyCharacterRole, null);
  assert.equal(c.wasWinner, null);
  assert.equal(c.eliminatedAtRound, null);
});

test('buildCallerSummary: pulls only the caller-facing fields', () => {
  const c = buildCallerSummary({
    user_id: 202, username: 'A', was_host: false,
    game_role: 'innocent', story_character_name: 'Y', story_character_role: 'r',
    eliminated_at_round: 1, was_winner: true,
  });
  assert.equal(c.role, 'innocent');
  assert.equal(c.storyCharacterName, 'Y');
  assert.equal(c.eliminatedAtRound, 1);
  assert.equal(c.wasWinner, true);
  // Caller summary intentionally omits userId/username — caller already
  // knows their own identity.
  assert.equal('userId' in c, false);
  assert.equal('username' in c, false);
});

// ---------------------------------------------------------------------------
// sanitizeVotingHistory
// ---------------------------------------------------------------------------

test('sanitizeVotingHistory: allow-listed fields only', () => {
  const out = sanitizeVotingHistory([{
    round: 1,
    eliminatedId: 303,
    eliminatedUsername: 'B',
    wasMafiozo: false,
    reason: 'majority',
    closedBy: 'all_voted',
    // Hostile extras.
    votes: { 202: 303, 303: 202 },     // per-voter map — must be dropped
    tally: { '303': 2 },               // optional — also drop in sanitized form
    secret: 'leak',
  }, null, undefined, 'not an object']);
  assert.equal(out.length, 1, 'null/non-object entries filtered');
  const e = out[0];
  const allowed = new Set([
    'round', 'eliminatedId', 'eliminatedUsername',
    'wasMafiozo', 'reason', 'closedBy',
  ]);
  for (const k of Object.keys(e)) {
    assert.ok(allowed.has(k), `unexpected key on voting-history row: ${k}`);
  }
  assert.equal(JSON.stringify(out).includes('"votes"'), false);
  assert.equal(JSON.stringify(out).includes('"tally"'), false);
});

test('sanitizeVotingHistory: non-array → empty array', () => {
  assert.deepEqual(sanitizeVotingHistory(null), []);
  assert.deepEqual(sanitizeVotingHistory(undefined), []);
  assert.deepEqual(sanitizeVotingHistory({}), []);
});
