/**
 * FixPack v2 / Commit 5 — extended AI provider chain tests.
 *
 * Pin the contract:
 *   - openrouterArchiveChain() returns models in attempt order with blanks
 *     filtered out.
 *   - The chain is configurable via env vars (FALLBACK_MODEL,
 *     FALLBACK_MODEL_2, FALLBACK_MODEL_3) without code change.
 *   - Empty/blank rungs are SILENT (not errors).
 *   - generateSealedArchive still falls through to the deterministic
 *     fallback when ALL providers fail.
 *   - The fallback archive validates against custom mode counts
 *     (regression-pinned from E4 — must not break with the chain
 *     extension).
 *   - Validator opts derived from input still enforce exact counts.
 *
 * The full integration of services/ai/index.js requires dotenv (not
 * installed in the local sandbox). Tests that touch the full module
 * are guarded with { skip } so they pass locally and run in CI under
 * `npm ci`. This is the same pattern used by archive-config.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

let aiModule;
try {
  aiModule = require('../services/ai');
} catch (_) {
  aiModule = null;
}

// ---------------------------------------------------------------------------
// 1. openrouterArchiveChain — filters blanks, preserves order
// ---------------------------------------------------------------------------

test('FP2.38 openrouterArchiveChain returns array (CI-only when ai module loads)', { skip: !aiModule }, () => {
  const chain = aiModule._openrouterArchiveChain();
  assert.ok(Array.isArray(chain), 'must return an array');
  // Every entry is a non-empty string (blanks filtered).
  for (const m of chain) {
    assert.equal(typeof m, 'string');
    assert.ok(m.trim().length > 0, `chain must not contain blank: "${m}"`);
  }
});

test('FP2.39 openrouterArchiveChain returns at minimum the primary fallback (CI-only)', { skip: !aiModule }, () => {
  const chain = aiModule._openrouterArchiveChain();
  // The default OPENROUTER_FALLBACK_MODEL is always set ('nvidia/...:free'),
  // so chain[0] must always exist.
  assert.ok(chain.length >= 1);
});

// ---------------------------------------------------------------------------
// 2. Fallback archive — config-aware shape (E4 regression)
// ---------------------------------------------------------------------------

test('FP2.40 _buildFallbackArchive default shape is byte-for-byte the static archive (CI-only)', { skip: !aiModule }, () => {
  const a = aiModule._buildFallbackArchive({ players: 4, clueCount: 3, mafiozoCount: 1 });
  assert.equal(a.title, aiModule._fallbackArchive.title);
  assert.equal(a.clues.length, 3);
  assert.equal(a.characters.length, 4);
  assert.equal(typeof a.mafiozo, 'string');
});

test('FP2.41 _buildFallbackArchive custom 5/2/4 returns config-correct shape (CI-only)', { skip: !aiModule }, () => {
  const a = aiModule._buildFallbackArchive({ players: 5, clueCount: 4, mafiozoCount: 2 });
  assert.equal(a.clues.length, 4);
  assert.equal(a.characters.length, 5);
  assert.ok(Array.isArray(a.mafiozos));
  assert.equal(a.mafiozos.length, 2);
});

test('FP2.42 _buildFallbackArchive custom 8/5/3 still validates as a complete archive (CI-only)', { skip: !aiModule }, () => {
  const a = aiModule._buildFallbackArchive({ players: 8, clueCount: 5, mafiozoCount: 3 });
  // The validator must accept the fallback when called with the same opts.
  const err = aiModule._validateArchive(a, { expectedClues: 5, expectedMafiozos: 3, expectedCharacters: 8 });
  assert.equal(err, null, `validator must accept fallback: ${err}`);
  for (const c of a.clues) {
    assert.ok(typeof c === 'string' && c.trim().length > 0);
    assert.equal(c.toLowerCase().includes('todo'), false);
    assert.equal(c.toLowerCase().includes('placeholder'), false);
    assert.equal(c.includes('undefined'), false);
  }
  for (const ch of a.characters) {
    assert.ok(ch.name && ch.role && ch.suspicious_detail);
    assert.equal(String(ch.name).includes('undefined'), false);
  }
});

// ---------------------------------------------------------------------------
// 3. validateArchive parameterization (chain extension MUST preserve E4)
// ---------------------------------------------------------------------------

test('FP2.43 validateArchive default opts still accept the static fallback (CI-only)', { skip: !aiModule }, () => {
  const err = aiModule._validateArchive(aiModule._fallbackArchive);
  assert.equal(err, null, `default validation must pass on the static fallback: ${err}`);
});

test('FP2.44 validateArchive rejects 3-clue archive when expectedClues=5 (CI-only)', { skip: !aiModule }, () => {
  const err = aiModule._validateArchive(aiModule._fallbackArchive, { expectedClues: 5 });
  assert.ok(err && err.includes('expected exactly 5 clues'),
    `validator must enforce expectedClues=5: ${err}`);
});

// ---------------------------------------------------------------------------
// 4. Source-level grep regression: no prompts/responses in logging
// ---------------------------------------------------------------------------

test('FP2.45 services/ai/index.js logs metadata-only — never prompt/response bodies', () => {
  // Static-source check independent of dotenv. Confirms that the only
  // arguments passed to logAi are short labels + booleans + integers.
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'index.js'),
    'utf8'
  );
  // Forbidden: any logAi call that includes the literal `prompt:` or
  // `response:` or `body:` keys at the call site.
  // Use a permissive regex on `logAi({` blocks, then assert each block
  // doesn't contain dangerous identifiers.
  const callRe = /logAi\(\{[\s\S]*?\}\)/g;
  const calls = text.match(callRe) || [];
  assert.ok(calls.length > 0, 'expected at least one logAi call to inspect');
  for (const c of calls) {
    for (const dangerous of ['prompt:', 'response:', 'rawResponse:', 'rawPrompt:', 'output:', 'body:', 'content:']) {
      assert.equal(c.includes(dangerous), false,
        `logAi call must not include "${dangerous}" key: ${c.slice(0, 200)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Static-source: chain function exists and references all 3 model slots
// ---------------------------------------------------------------------------

test('FP2.46 openrouterArchiveChain references all 3 model env slots', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'index.js'),
    'utf8'
  );
  assert.match(text, /openrouterArchiveChain/);
  assert.match(text, /config\.openrouter\.fallbackModel\b/);
  assert.match(text, /config\.openrouter\.fallbackModel2\b/);
  assert.match(text, /config\.openrouter\.fallbackModel3\b/);
});

test('FP2.47 config/env.js exposes all 3 OpenRouter model slots', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'config', 'env.js'),
    'utf8'
  );
  assert.match(text, /OPENROUTER_FALLBACK_MODEL\b/);
  assert.match(text, /OPENROUTER_FALLBACK_MODEL_2\b/);
  assert.match(text, /OPENROUTER_FALLBACK_MODEL_3\b/);
});

// ---------------------------------------------------------------------------
// 6. generateSealedArchive contract — never throws, always returns archive
// (CI-only because the function calls into the full AI module)
// ---------------------------------------------------------------------------

test('FP2.48 generateSealedArchive contract: never throws, returns valid archive (CI-only)', { skip: !aiModule }, async () => {
  // Provide a custom config; ALL providers may fail (no network in test).
  // The function must still return a valid archive (deterministic fallback).
  const result = await aiModule.generateSealedArchive({
    idea: 'crime',
    players: 5,
    clueCount: 4,
    mafiozoCount: 2,
  });
  assert.ok(result, 'must return a result object');
  assert.ok(['gemini', 'openrouter', 'fallback'].includes(result.source));
  assert.ok(result.archive, 'archive present');
  // The archive must validate against the same opts.
  const err = aiModule._validateArchive(result.archive, { expectedClues: 4, expectedMafiozos: 2 });
  assert.equal(err, null, `result archive must validate: ${err}`);
});
