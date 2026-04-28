/**
 * FixPack v2 / Commit 1 — Custom Mode player-count semantics.
 *
 * Pin the contract for getRealPlayers / getSuspectPlayers / getHostPlayers
 * / getCurrentSuspectCount / getCustomRequiredSuspectCount /
 * validateCustomStartCount.
 *
 * No DB, no network. Builds synthetic lobbies and probes module-private
 * helpers exposed via the test-only exports on GameManager.
 *
 * Acceptance pinned here:
 *   - Human Host + 5 suspects + playerCount=5 → passes
 *   - Human Host + 3 suspects + playerCount=5 → fails with current=3, required=5
 *   - AI Host + 5 suspects + playerCount=5 → passes
 *   - AI Host + 2 suspects + playerCount=3 → fails with current=2, required=3
 *   - Default mode unaffected
 *   - Phantom/malformed players ignored
 *   - Host never accidentally counted as suspect
 *   - Error copy quotes BOTH required and current counts
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  _getRealPlayers,
  _getHostPlayers,
  _getSuspectPlayers,
  _getCurrentSuspectCount,
  _getCustomRequiredSuspectCount,
  _validateCustomStartCount,
} = require('../game/GameManager');

// ---------------------------------------------------------------------------
// Tiny lobby builder. Mirrors the production lobby shape exactly: a Map
// keyed by user id, with {id, username, isHost, isAlive} records.
// ---------------------------------------------------------------------------

function makeLobby({ humanHostId = null, suspectCount = 0, phantomCount = 0, mode = 'AI', config = null } = {}) {
  const players = new Map();
  if (humanHostId !== null) {
    players.set(humanHostId, {
      id: humanHostId, username: `host_${humanHostId}`, socketId: 'sH',
      isHost: true, isAlive: true,
    });
  }
  for (let i = 0; i < suspectCount; i++) {
    const id = 1000 + i;
    players.set(id, {
      id, username: `S${i}`, socketId: `s${i}`, isHost: false, isAlive: true,
    });
  }
  // Phantom rows: missing id, missing username, or both. Defensive — these
  // must NEVER reach the suspect/host count helpers.
  for (let i = 0; i < phantomCount; i++) {
    const k = `phantom_${i}`;
    players.set(k, { id: undefined, username: i % 2 === 0 ? undefined : `Ghost${i}` });
  }
  return {
    id: 'TEST_ROOM', mode,
    hostId: humanHostId,
    creatorId: humanHostId,
    players,
    config,
  };
}

// ---------------------------------------------------------------------------
// 1. Helpers — clean separation of host / suspect / real players
// ---------------------------------------------------------------------------

test('FP2.1 getRealPlayers filters phantom rows (missing id/username)', () => {
  const lobby = makeLobby({ humanHostId: 100, suspectCount: 3, phantomCount: 4 });
  const real = _getRealPlayers(lobby);
  // 1 host + 3 suspects = 4 real players. Phantom rows dropped.
  assert.equal(real.length, 4);
  for (const p of real) {
    assert.ok(p.id, 'every real player has an id');
    assert.ok(p.username, 'every real player has a username');
  }
});

test('FP2.2 getHostPlayers returns exactly one row in Human Host rooms', () => {
  const lobby = makeLobby({ humanHostId: 42, suspectCount: 5 });
  const hosts = _getHostPlayers(lobby);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].id, 42);
  assert.equal(hosts[0].isHost, true);
});

test('FP2.3 getHostPlayers returns empty in AI Host rooms (no human host)', () => {
  // AI Host rooms: humanHostId is null, no isHost=true players in the Map.
  const lobby = makeLobby({ humanHostId: null, suspectCount: 5, mode: 'AI' });
  const hosts = _getHostPlayers(lobby);
  assert.equal(hosts.length, 0);
});

test('FP2.4 getSuspectPlayers excludes the human host (Human Host)', () => {
  const lobby = makeLobby({ humanHostId: 7, suspectCount: 5 });
  const suspects = _getSuspectPlayers(lobby);
  assert.equal(suspects.length, 5);
  for (const s of suspects) {
    assert.equal(s.isHost, false);
    assert.notEqual(s.id, 7, 'human host is NEVER counted as a suspect');
  }
});

test('FP2.5 getSuspectPlayers includes everyone in AI Host rooms', () => {
  const lobby = makeLobby({ humanHostId: null, suspectCount: 5, mode: 'AI' });
  const suspects = _getSuspectPlayers(lobby);
  assert.equal(suspects.length, 5);
});

test('FP2.6 getCurrentSuspectCount matches getSuspectPlayers().length', () => {
  for (const n of [0, 1, 3, 5, 8]) {
    const lobby = makeLobby({ humanHostId: 99, suspectCount: n });
    assert.equal(_getCurrentSuspectCount(lobby), n);
  }
});

// ---------------------------------------------------------------------------
// 2. getCustomRequiredSuspectCount
// ---------------------------------------------------------------------------

test('FP2.7 getCustomRequiredSuspectCount returns null for null/default config', () => {
  assert.equal(_getCustomRequiredSuspectCount(null), null);
  assert.equal(_getCustomRequiredSuspectCount(undefined), null);
  assert.equal(_getCustomRequiredSuspectCount({}), null);
  assert.equal(_getCustomRequiredSuspectCount({ isCustom: false, playerCount: 5 }), null);
});

test('FP2.8 getCustomRequiredSuspectCount returns playerCount for custom config', () => {
  assert.equal(_getCustomRequiredSuspectCount({ isCustom: true, playerCount: 3 }), 3);
  assert.equal(_getCustomRequiredSuspectCount({ isCustom: true, playerCount: 5 }), 5);
  assert.equal(_getCustomRequiredSuspectCount({ isCustom: true, playerCount: 8 }), 8);
});

// ---------------------------------------------------------------------------
// 3. validateCustomStartCount — the FixPack v2 semantic
// ---------------------------------------------------------------------------

test('FP2.9 Human Host + 5 suspects + playerCount=5 → passes', () => {
  const cfg = { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 };
  const lobby = makeLobby({ humanHostId: 1, suspectCount: 5, config: cfg });
  const r = _validateCustomStartCount(lobby);
  assert.equal(r.ok, true);
  assert.equal(r.required, 5);
  assert.equal(r.current, 5);
});

test('FP2.10 Human Host + 3 suspects + playerCount=5 → fails (current=3, required=5)', () => {
  const cfg = { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 };
  const lobby = makeLobby({ humanHostId: 1, suspectCount: 3, config: cfg });
  const r = _validateCustomStartCount(lobby);
  assert.equal(r.ok, false);
  assert.equal(r.required, 5);
  assert.equal(r.current, 3);
  // Error must mention BOTH numbers — no more ambiguous "محتاج 3 لاعبين".
  assert.ok(r.error.includes('5'), `error must mention required=5: "${r.error}"`);
  assert.ok(r.error.includes('3'), `error must mention current=3: "${r.error}"`);
});

test('FP2.11 AI Host + 5 suspects + playerCount=5 → passes', () => {
  const cfg = { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 };
  const lobby = makeLobby({ humanHostId: null, suspectCount: 5, mode: 'AI', config: cfg });
  const r = _validateCustomStartCount(lobby);
  assert.equal(r.ok, true);
  assert.equal(r.current, 5);
  assert.equal(r.required, 5);
});

test('FP2.12 AI Host + 2 suspects + playerCount=3 → fails (current=2, required=3)', () => {
  const cfg = { isCustom: true, playerCount: 3, mafiozoCount: 1, clueCount: 3 };
  const lobby = makeLobby({ humanHostId: null, suspectCount: 2, mode: 'AI', config: cfg });
  const r = _validateCustomStartCount(lobby);
  assert.equal(r.ok, false);
  assert.equal(r.current, 2);
  assert.equal(r.required, 3);
  assert.ok(r.error.includes('3'));
  assert.ok(r.error.includes('2'));
});

test('FP2.13 Default mode (config=null) is NOT affected by exact-count gate', () => {
  const lobby = makeLobby({ humanHostId: 1, suspectCount: 3, config: null });
  const r = _validateCustomStartCount(lobby);
  assert.equal(r.ok, true);
});

test('FP2.14 Phantom/malformed players are not counted', () => {
  const cfg = { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 };
  // 5 real suspects + 4 phantom rows. Phantom must not inflate the count.
  const lobby = makeLobby({ humanHostId: 1, suspectCount: 5, phantomCount: 4, config: cfg });
  const r = _validateCustomStartCount(lobby);
  assert.equal(r.ok, true, `phantoms must not inflate count: current=${r.current}`);
  assert.equal(r.current, 5);
});

test('FP2.15 Human host is NEVER counted as a suspect (semantic guarantee)', () => {
  // 5-seat custom config; 1 host + 5 suspects → CURRENT must equal 5, not 6.
  const cfg = { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 };
  const lobby = makeLobby({ humanHostId: 99, suspectCount: 5, config: cfg });
  const r = _validateCustomStartCount(lobby);
  assert.equal(r.ok, true);
  assert.equal(r.current, 5);
  // And reverse: 1 host + 6 suspects → current=6, fails.
  const lobby2 = makeLobby({ humanHostId: 99, suspectCount: 6, config: cfg });
  const r2 = _validateCustomStartCount(lobby2);
  assert.equal(r2.ok, false);
  assert.equal(r2.current, 6);
  assert.equal(r2.required, 5);
});

test('FP2.16 Error copy follows the documented FixPack v2 template', () => {
  const cfg = { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 };
  const lobby = makeLobby({ humanHostId: 1, suspectCount: 3, config: cfg });
  const r = _validateCustomStartCount(lobby);
  // Must NOT be the misleading old copy.
  assert.equal(r.error.includes('محتاج 5 لاعبين بالضبط قبل الختم.') &&
               !r.error.includes('الموجود الآن'), false,
    'error must include BOTH required and current counts');
  // Must include the documented words from the spec.
  assert.match(r.error, /يحتاج/);
  assert.match(r.error, /لاعبين مشاركين/);
  assert.match(r.error, /الموجود الآن/);
});

// ---------------------------------------------------------------------------
// 4. explicitConfig override (callers that want to validate against a
// config that's not yet attached to the lobby — useful for AI Host ready
// flow which validates BEFORE attaching the archive).
// ---------------------------------------------------------------------------

test('FP2.17 explicitConfig override — useful for pre-finalize gating', () => {
  const cfg = { isCustom: true, playerCount: 4, mafiozoCount: 1, clueCount: 3 };
  // Lobby has no config attached but the caller passes one explicitly.
  const lobby = makeLobby({ humanHostId: null, suspectCount: 4, mode: 'AI', config: null });
  const r = _validateCustomStartCount(lobby, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.current, 4);
  assert.equal(r.required, 4);
});
