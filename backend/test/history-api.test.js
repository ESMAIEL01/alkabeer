/**
 * D2 — history-route helper tests.
 *
 * Imports from routes/history-helpers.js only — no express, no DB, no JWT.
 * The full route surface is exercised in CI where production deps are
 * installed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parsePagination, mapHistoryRow, LIMITS } = require('../routes/history-helpers');

// ---------------------------------------------------------------------------
// parsePagination
// ---------------------------------------------------------------------------

test('parsePagination: defaults when no query', () => {
  const p = parsePagination(undefined);
  assert.equal(p.limit, LIMITS.LIMIT_DEFAULT);
  assert.equal(p.offset, 0);
});

test('parsePagination: clamps limit > 50 down to 50', () => {
  const p = parsePagination({ limit: '500' });
  assert.equal(p.limit, LIMITS.LIMIT_MAX);
});

test('parsePagination: clamps limit < 1 up to 1', () => {
  const p = parsePagination({ limit: '0' });
  assert.equal(p.limit, LIMITS.LIMIT_MIN);
  const p2 = parsePagination({ limit: '-5' });
  assert.equal(p2.limit, LIMITS.LIMIT_MIN);
});

test('parsePagination: invalid limit (NaN, garbage, empty) falls back to default', () => {
  assert.equal(parsePagination({ limit: 'abc' }).limit, LIMITS.LIMIT_DEFAULT);
  assert.equal(parsePagination({ limit: '' }).limit,    LIMITS.LIMIT_DEFAULT);
  assert.equal(parsePagination({}).limit,                LIMITS.LIMIT_DEFAULT);
});

test('parsePagination: negative offset rejected → 0', () => {
  assert.equal(parsePagination({ offset: '-3' }).offset, 0);
  assert.equal(parsePagination({ offset: 'abc' }).offset, 0);
});

test('parsePagination: positive offset preserved', () => {
  assert.equal(parsePagination({ limit: '5', offset: '100' }).offset, 100);
  assert.equal(parsePagination({ limit: '5', offset: '100' }).limit, 5);
});

// ---------------------------------------------------------------------------
// mapHistoryRow — privacy + camelCase mapping
// ---------------------------------------------------------------------------

test('mapHistoryRow: maps snake_case DB columns to safe camelCase shape', () => {
  const m = mapHistoryRow({
    id: 'ROOM1',
    scenario_title: 'سرقة قصر البارون',
    host_mode: 'AI',
    reveal_mode: 'normal',
    outcome: 'investigators_win',
    game_role: 'mafiozo',
    story_character_name: 'X',
    story_character_role: 'r',
    eliminated_at_round: 2,
    was_winner: false,
    ended_at: 't_end',
    created_at: 't_start',
  });
  assert.equal(m.id, 'ROOM1');
  assert.equal(m.scenarioTitle, 'سرقة قصر البارون');
  assert.equal(m.hostMode, 'AI');
  assert.equal(m.revealMode, 'normal');
  assert.equal(m.outcome, 'investigators_win');
  assert.equal(m.role, 'mafiozo');
  assert.equal(m.storyCharacterName, 'X');
  assert.equal(m.storyCharacterRole, 'r');
  assert.equal(m.eliminatedAtRound, 2);
  assert.equal(m.wasWinner, false);
  assert.equal(m.endedAt, 't_end');
  assert.equal(m.createdAt, 't_start');
});

test('mapHistoryRow: NEVER surfaces archive_b64, final_reveal, voting_history, roleAssignments', () => {
  const m = mapHistoryRow({
    id: 'ROOM2',
    scenario_title: 'X',
    host_mode: 'AI',
    reveal_mode: 'normal',
    archive_b64: 'BASE64_LEAK',
    final_reveal: { secret: 'truth' },
    voting_history: [{ voter: 1, target: 2 }],
    roleAssignments: { 1: { gameRole: 'mafiozo' } },
  });
  for (const k of ['archive_b64', 'final_reveal', 'voting_history', 'roleAssignments']) {
    assert.equal(k in m, false, `mapHistoryRow must not surface ${k}`);
  }
  // Full serialization must not contain the leak strings.
  const s = JSON.stringify(m);
  assert.equal(s.includes('BASE64_LEAK'), false);
  assert.equal(s.includes('"truth"'),     false);
});

test('mapHistoryRow: null/undefined safe — returns null on empty input', () => {
  assert.equal(mapHistoryRow(null), null);
  assert.equal(mapHistoryRow(undefined), null);
});

test('mapHistoryRow: missing fields produce nulls / safe defaults', () => {
  const m = mapHistoryRow({ id: 'ROOM3' });
  assert.equal(m.id, 'ROOM3');
  assert.equal(m.scenarioTitle, null);
  assert.equal(m.role, null);
  assert.equal(m.eliminatedAtRound, null);
  assert.equal(m.wasWinner, null);
});

test('mapHistoryRow: surfaces only the documented field set (allow-list pin)', () => {
  const m = mapHistoryRow({
    id: 'X', scenario_title: 'T', host_mode: 'AI', reveal_mode: 'normal',
    outcome: 'investigators_win', game_role: 'innocent',
    story_character_name: 'Y', story_character_role: 'r',
    eliminated_at_round: 1, was_winner: true,
    ended_at: 'e', created_at: 'c',
  });
  const allowed = new Set([
    'id', 'scenarioTitle', 'hostMode', 'revealMode', 'outcome',
    'role', 'storyCharacterName', 'storyCharacterRole',
    'eliminatedAtRound', 'wasWinner', 'endedAt', 'createdAt',
  ]);
  for (const k of Object.keys(m)) {
    assert.ok(allowed.has(k), `unexpected key on history row: ${k}`);
  }
});

test('mapHistoryRow: prefers id, falls back to game_id', () => {
  assert.equal(mapHistoryRow({ id: 'A' }).id, 'A');
  assert.equal(mapHistoryRow({ game_id: 'B' }).id, 'B');
});
