/**
 * D2 — profile validators + stats/profile mapper tests.
 *
 * Imports from routes/profile-helpers.js only — no express, no JWT, no DB.
 * The full route file (routes/profile.js) is exercised in CI where
 * `npm ci` installs production deps; the auth middleware is intentionally
 * NOT tested here because it requires `jsonwebtoken`. CI's npm test on
 * the test workflow runs the full surface; the failure modes covered
 * below are the high-value invariants.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAndNormalizeProfileInput,
  mapProfileRow,
  mapStatsRow,
  LIMITS,
} = require('../routes/profile-helpers');

// ---------------------------------------------------------------------------
// validateAndNormalizeProfileInput
// ---------------------------------------------------------------------------

test('validateAndNormalizeProfileInput: displayName too short rejected', () => {
  const r = validateAndNormalizeProfileInput({ displayName: 'A' });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].length > 0);
});

test('validateAndNormalizeProfileInput: displayName too long rejected', () => {
  const r = validateAndNormalizeProfileInput({ displayName: 'A'.repeat(40) });
  assert.equal(r.ok, false);
});

test('validateAndNormalizeProfileInput: displayName valid 2..32 accepted, trimmed', () => {
  const r = validateAndNormalizeProfileInput({ displayName: '   Mafia Hunter   ' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized.displayName, 'Mafia Hunter');
});

test('validateAndNormalizeProfileInput: avatarUrl rejects http:// (non-https)', () => {
  const r = validateAndNormalizeProfileInput({ avatarUrl: 'http://evil.example.com/x.png' });
  assert.equal(r.ok, false);
});

test('validateAndNormalizeProfileInput: avatarUrl accepts https://', () => {
  const r = validateAndNormalizeProfileInput({ avatarUrl: '  https://cdn.example.com/me.png  ' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized.avatarUrl, 'https://cdn.example.com/me.png');
});

test('validateAndNormalizeProfileInput: empty avatarUrl is treated as explicit clear', () => {
  const r = validateAndNormalizeProfileInput({ avatarUrl: '' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized.avatarUrl, '');
});

test('validateAndNormalizeProfileInput: avatarUrl too long rejected', () => {
  const r = validateAndNormalizeProfileInput({ avatarUrl: 'https://x.com/' + 'a'.repeat(LIMITS.AVATAR_URL_MAX) });
  assert.equal(r.ok, false);
});

test('validateAndNormalizeProfileInput: bio over BIO_MAX rejected; under is kept', () => {
  const overR = validateAndNormalizeProfileInput({ bio: 'ا'.repeat(LIMITS.BIO_MAX + 1) });
  assert.equal(overR.ok, false);
  const underR = validateAndNormalizeProfileInput({ bio: 'محقق هاوي بحب القهوة السادة.' });
  assert.equal(underR.ok, true);
  assert.equal(underR.normalized.bio, 'محقق هاوي بحب القهوة السادة.');
});

test('validateAndNormalizeProfileInput: <script> in avatarUrl/bio rejected', () => {
  const a = validateAndNormalizeProfileInput({ avatarUrl: 'https://example.com/<script>alert(1)</script>' });
  assert.equal(a.ok, false);
  const b = validateAndNormalizeProfileInput({ bio: 'hello <script>alert(1)</script>' });
  assert.equal(b.ok, false);
});

test('validateAndNormalizeProfileInput: empty body → ok with all-null normalized', () => {
  const r = validateAndNormalizeProfileInput({});
  assert.equal(r.ok, true);
  assert.equal(r.normalized.displayName, null);
  assert.equal(r.normalized.avatarUrl, null);
  assert.equal(r.normalized.bio, null);
});

test('validateAndNormalizeProfileInput: never returns token/secret-named fields', () => {
  const r = validateAndNormalizeProfileInput({
    displayName: 'OK',
    token: 'leak',
    apiKey: 'leak',
    JWT_SECRET: 'leak',
    password: 'leak',
  });
  // Whatever the result, normalized must contain only the three known keys.
  const keys = Object.keys(r.normalized).sort();
  assert.deepEqual(keys, ['avatarUrl', 'bio', 'displayName']);
});

test('validateAndNormalizeProfileInput: non-string types rejected', () => {
  const r = validateAndNormalizeProfileInput({ displayName: 42, avatarUrl: true, bio: { x: 1 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
});

// ---------------------------------------------------------------------------
// mapStatsRow — winRate & defaults
// ---------------------------------------------------------------------------

test('mapStatsRow: empty/undefined row produces zero defaults and 0% winRate', () => {
  const s = mapStatsRow(undefined);
  assert.equal(s.gamesPlayed, 0);
  assert.equal(s.wins, 0);
  assert.equal(s.losses, 0);
  assert.equal(s.winRate, 0);
  assert.equal(s.timesMafiozo, 0);
  assert.equal(s.lastPlayedAt, null);
});

test('mapStatsRow: winRate is percentage integer 0..100 (rounded)', () => {
  assert.equal(mapStatsRow({ games_played: 4, wins: 1 }).winRate, 25);
  assert.equal(mapStatsRow({ games_played: 3, wins: 1 }).winRate, 33);
  assert.equal(mapStatsRow({ games_played: 7, wins: 5 }).winRate, 71);
  assert.equal(mapStatsRow({ games_played: 10, wins: 10 }).winRate, 100);
});

test('mapStatsRow: never surfaces sensitive fields even when input has them', () => {
  const s = mapStatsRow({
    games_played: 1,
    wins: 1,
    archive_b64: 'leak',
    final_reveal: { foo: 'leak' },
    voting_history: [{}],
    gameRole: 'mafiozo',
    roleAssignments: { 1: { gameRole: 'mafiozo' } },
  });
  for (const k of ['archive_b64', 'final_reveal', 'voting_history', 'gameRole', 'roleAssignments']) {
    assert.equal(k in s, false, `mapStatsRow must not surface ${k}`);
  }
});

// ---------------------------------------------------------------------------
// mapProfileRow
// ---------------------------------------------------------------------------

test('mapProfileRow: maps DB columns to camelCase; null/undefined returns null', () => {
  assert.equal(mapProfileRow(null), null);
  assert.equal(mapProfileRow(undefined), null);
  const m = mapProfileRow({
    user_id: 42,
    display_name: 'X',
    avatar_url: 'https://x.com/a',
    bio: 'b',
    ai_bio: 'aib',
    ai_bio_source: 'gemini',
    created_at: 't1',
    updated_at: 't2',
  });
  assert.equal(m.displayName, 'X');
  assert.equal(m.avatarUrl, 'https://x.com/a');
  assert.equal(m.bio, 'b');
  assert.equal(m.aiBio, 'aib');
  assert.equal(m.aiBioSource, 'gemini');
  assert.equal(m.createdAt, 't1');
  assert.equal(m.updatedAt, 't2');
  // user_id intentionally NOT surfaced — caller already knows req.user.id.
  assert.equal('userId' in m, false);
  assert.equal('user_id' in m, false);
});
