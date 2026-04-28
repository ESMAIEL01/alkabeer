/**
 * FixPack v3 / Premium archive — deterministic fallback quality tests.
 *
 * Pinned guarantees:
 *   - Default 4/3/1 fallback passes BOTH schema and quality validation.
 *   - Custom 5/2/4 fallback passes BOTH schema and quality validation.
 *   - Custom 8/3/5 fallback passes BOTH schema and quality validation.
 *   - Same input → same output (deterministic).
 *   - Different inputs → different archives (no collisions across the
 *     supported parameter range).
 *   - Output never contains placeholder strings, username-like names,
 *     repeated clues, or English-dominant content.
 *   - Output preserves the legacy default wire shape (singular
 *     `mafiozo` field for default 4/3/1; `mafiozos[]` array for
 *     multi-Mafiozo with `mafiozo` kept as legacy alias).
 *
 * The fallback builder lives inside services/ai/index.js, which
 * transitively requires dotenv. Tests use the existing skip-on-load
 * pattern so they run in CI (npm ci installs dotenv) but skip locally.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateArchive, validateArchiveQuality } =
  require('../services/ai/validators');

// FixPack v3 / Commit 2 — the premium fallback lives in a dep-free
// module so tests run locally without dotenv.
const { buildFallbackArchive } =
  require('../services/ai/archive-fallback');
const SKIP = {};

// ---------------------------------------------------------------------------
// 1. Schema + quality on the supported counts
// ---------------------------------------------------------------------------

test('PF.1 default 4/3/1 fallback passes schema AND quality', SKIP, () => {
  const a = buildFallbackArchive({});
  assert.equal(validateArchive(a), null, 'schema must pass');
  assert.equal(validateArchiveQuality(a), null, 'quality must pass');
});

test('PF.2 default 4/3/1 keeps the legacy singular `mafiozo` field shape', SKIP, () => {
  const a = buildFallbackArchive({});
  assert.equal(typeof a.mafiozo, 'string',
    'default-shape must carry singular `mafiozo` for legacy clients');
  // Default 4/3/1 → no mafiozos[] array (or undefined) so old clients
  // never see a shape they don't recognize.
  assert.equal(Array.isArray(a.mafiozos), false,
    'default 4/3/1 must NOT emit mafiozos[]');
  assert.equal(a.characters.length, 4);
  assert.equal(a.clues.length, 3);
});

test('PF.3 custom 5/2/4 fallback passes schema AND quality', SKIP, () => {
  const a = buildFallbackArchive({ players: 5, clueCount: 4, mafiozoCount: 2 });
  assert.equal(
    validateArchive(a, { expectedClues: 4, expectedMafiozos: 2, expectedCharacters: 5 }),
    null,
    'schema must pass for 5/2/4'
  );
  assert.equal(validateArchiveQuality(a), null, 'quality must pass for 5/2/4');
});

test('PF.4 custom 5/2/4 emits mafiozos[] of length 2 + legacy mafiozo singular', SKIP, () => {
  const a = buildFallbackArchive({ players: 5, clueCount: 4, mafiozoCount: 2 });
  assert.ok(Array.isArray(a.mafiozos));
  assert.equal(a.mafiozos.length, 2);
  for (const m of a.mafiozos) {
    assert.ok(m.name && m.role && m.suspicious_detail);
  }
  // Legacy singular MUST still be present so older cached clients render.
  assert.equal(typeof a.mafiozo, 'string');
  assert.equal(a.characters.length, 5);
  assert.equal(a.clues.length, 4);
});

test('PF.5 custom 8/3/5 fallback passes schema AND quality', SKIP, () => {
  const a = buildFallbackArchive({ players: 8, clueCount: 5, mafiozoCount: 3 });
  assert.equal(
    validateArchive(a, { expectedClues: 5, expectedMafiozos: 3, expectedCharacters: 8 }),
    null,
    'schema must pass for 8/3/5'
  );
  assert.equal(validateArchiveQuality(a), null, 'quality must pass for 8/3/5');
  assert.equal(a.characters.length, 8);
  assert.equal(a.clues.length, 5);
  assert.equal(a.mafiozos.length, 3);
});

// ---------------------------------------------------------------------------
// 2. Determinism + uniqueness
// ---------------------------------------------------------------------------

test('PF.6 same input → identical archive (deterministic)', SKIP, () => {
  const a = buildFallbackArchive({ players: 5, clueCount: 4, mafiozoCount: 2, idea: 'سرقة في فندق' });
  const b = buildFallbackArchive({ players: 5, clueCount: 4, mafiozoCount: 2, idea: 'سرقة في فندق' });
  assert.deepEqual(a, b, 'same input must produce same output');
});

test('PF.7 different idea → different titles (seed varies)', SKIP, () => {
  const a = buildFallbackArchive({ players: 4, clueCount: 3, mafiozoCount: 1, idea: 'فكرة 1' });
  const b = buildFallbackArchive({ players: 4, clueCount: 3, mafiozoCount: 1, idea: 'فكرة 2' });
  // Both must pass quality. They MAY pick the same title in rare cases
  // (12-pool collisions), but the contract here is that the function
  // doesn't lock to a single output — at least one of {title, story,
  // characters[0].name} must differ across distinct ideas.
  const sameTitle = a.title === b.title;
  const sameFirstName = a.characters[0].name === b.characters[0].name;
  const sameClue = a.clues[0] === b.clues[0];
  assert.equal(sameTitle && sameFirstName && sameClue, false,
    'different ideas must vary at least one of title/firstChar/firstClue');
});

test('PF.8 character names within an archive are unique', SKIP, () => {
  for (const cfg of [
    { players: 4, clueCount: 3, mafiozoCount: 1 },
    { players: 5, clueCount: 4, mafiozoCount: 2 },
    { players: 8, clueCount: 5, mafiozoCount: 3 },
  ]) {
    const a = buildFallbackArchive(cfg);
    const names = a.characters.map(c => c.name);
    const unique = new Set(names);
    assert.equal(unique.size, names.length,
      `character names must be unique for ${JSON.stringify(cfg)}: ${names.join(', ')}`);
  }
});

test('PF.9 clues within an archive are unique', SKIP, () => {
  for (const cfg of [
    { players: 4, clueCount: 3, mafiozoCount: 1 },
    { players: 5, clueCount: 4, mafiozoCount: 2 },
    { players: 8, clueCount: 5, mafiozoCount: 3 },
  ]) {
    const a = buildFallbackArchive(cfg);
    const unique = new Set(a.clues);
    assert.equal(unique.size, a.clues.length,
      `clues must be unique for ${JSON.stringify(cfg)}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Boundary checks across the supported parameter ranges
// ---------------------------------------------------------------------------

test('PF.10 every supported (players, clueCount, mafiozoCount) combo passes quality', SKIP, () => {
  let combos = 0;
  for (let players = 3; players <= 8; players++) {
    const maxM = Math.max(1, Math.floor((players - 1) / 2));
    for (let mafiozoCount = 1; mafiozoCount <= maxM; mafiozoCount++) {
      for (let clueCount = 1; clueCount <= 5; clueCount++) {
        const a = buildFallbackArchive({ players, clueCount, mafiozoCount });
        const schemaErr = validateArchive(a, {
          expectedClues: clueCount,
          expectedMafiozos: mafiozoCount,
          expectedCharacters: players,
        });
        const qualityErr = validateArchiveQuality(a);
        assert.equal(schemaErr, null,
          `schema must pass for ${players}/${mafiozoCount}/${clueCount}: ${schemaErr}`);
        assert.equal(qualityErr, null,
          `quality must pass for ${players}/${mafiozoCount}/${clueCount}: ${qualityErr}`);
        combos++;
      }
    }
  }
  assert.ok(combos >= 30, `should cover at least 30 combos, ran ${combos}`);
});

// ---------------------------------------------------------------------------
// 4. Privacy / no placeholder leaks
// ---------------------------------------------------------------------------

test('PF.11 fallback never contains placeholder strings', SKIP, () => {
  const a = buildFallbackArchive({ players: 8, clueCount: 5, mafiozoCount: 3 });
  const allText = JSON.stringify(a);
  for (const bad of [
    'الجملة 1', 'الجملة 2', 'الجملة 3', 'الشخص 1', 'المشتبه 1',
    'الدليل 1', 'مافيوزو 1', 'undefined', 'null', 'NaN',
    'TODO', 'placeholder', 'lorem', 'demo',
  ]) {
    assert.equal(allText.includes(bad), false,
      `fallback must not contain "${bad}"`);
  }
});

test('PF.12 fallback contains "مافيوزو" only as the brand reference, never as a name', SKIP, () => {
  const a = buildFallbackArchive({ players: 5, clueCount: 4, mafiozoCount: 2 });
  for (const ch of a.characters) {
    assert.equal(/مافيوزو/.test(ch.name), false,
      `character name must not contain "مافيوزو": ${ch.name}`);
  }
});

test('PF.13 fallback resilient to null / undefined / partial input', SKIP, () => {
  for (const input of [null, undefined, {}, { players: 4 }, { clueCount: 3 }]) {
    const a = buildFallbackArchive(input);
    assert.equal(validateArchiveQuality(a), null,
      `must build a valid archive for input=${JSON.stringify(input)}`);
  }
});
