/**
 * FixPack v3 / Commit 1 — task-aware OpenRouter model routing tests.
 *
 * Exercises:
 *   - parseModelList / uniqueModelList pure helpers (dep-free).
 *   - getOpenRouterModelsForTask selector (CI-only via services/ai).
 *   - tryOpenRouterModelChain runner (CI-only via services/ai).
 *
 * The dep-free helper file (config/parseModelList.js) carries no dotenv
 * dependency, so its tests always run locally. Selector + runner tests
 * are gated on the AI module loading because services/ai/index.js
 * transitively requires dotenv via config/env.js — the same skip pattern
 * used by archive-config.test.js and ai-provider-chain.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Always-load: dep-free pure helpers.
const { parseModelList, uniqueModelList } = require('../config/parseModelList');

// Conditionally-load: services/ai pulls dotenv via config/env.js.
let aiModule;
try {
  aiModule = require('../services/ai');
} catch (_) {
  aiModule = null;
}

// ---------------------------------------------------------------------------
// 1. parseModelList — pure helper
// ---------------------------------------------------------------------------

test('FP3.1 parseModelList: comma-separated input is split + trimmed + deduped', () => {
  const list = parseModelList('a, b, c, a, b, d');
  assert.deepEqual(list, ['a', 'b', 'c', 'd']);
});

test('FP3.2 parseModelList: blanks and whitespace-only entries are dropped', () => {
  assert.deepEqual(parseModelList('a, , b, , , c'), ['a', 'b', 'c']);
  assert.deepEqual(parseModelList('   '),           []);
  assert.deepEqual(parseModelList('     ,    ,    '), []);
});

test('FP3.3 parseModelList: null/undefined/non-string → []', () => {
  assert.deepEqual(parseModelList(null),       []);
  assert.deepEqual(parseModelList(undefined),  []);
  assert.deepEqual(parseModelList(42),         []);
  assert.deepEqual(parseModelList({}),         []);
  assert.deepEqual(parseModelList([]),         []);
});

test('FP3.4 parseModelList: preserves first-occurrence order under duplicates', () => {
  const list = parseModelList('z,a,z,b,a,c,z,b');
  assert.deepEqual(list, ['z', 'a', 'b', 'c']);
});

test('FP3.5 parseModelList: handles real-world model ids with namespace prefixes', () => {
  const raw = 'liquid/lfm-2.5-1.2b-thinking:free, minimax/minimax-m2.5:free, '
            + 'minimax/minimax-m2.5:free, z-ai/glm-4.5-air:free, '
            + 'openai/gpt-oss-120b:free';
  const list = parseModelList(raw);
  assert.deepEqual(list, [
    'liquid/lfm-2.5-1.2b-thinking:free',
    'minimax/minimax-m2.5:free',
    'z-ai/glm-4.5-air:free',
    'openai/gpt-oss-120b:free',
  ]);
});

// ---------------------------------------------------------------------------
// 2. uniqueModelList — pure helper
// ---------------------------------------------------------------------------

test('FP3.6 uniqueModelList: dedupes already-built arrays, drops blanks/non-strings', () => {
  assert.deepEqual(
    uniqueModelList(['a', 'b', 'a', '', '   ', null, undefined, 42, 'b', 'c']),
    ['a', 'b', 'c']
  );
});

test('FP3.7 uniqueModelList: returns [] for non-array input', () => {
  assert.deepEqual(uniqueModelList(null),       []);
  assert.deepEqual(uniqueModelList(undefined),  []);
  assert.deepEqual(uniqueModelList('a,b,c'),    []);
  assert.deepEqual(uniqueModelList({ 0: 'a' }), []);
});

// ---------------------------------------------------------------------------
// 3. getOpenRouterModelsForTask — selector (CI-only)
// ---------------------------------------------------------------------------

test('FP3.8 getOpenRouterModelsForTask: archive task returns array (CI-only)', { skip: !aiModule }, () => {
  const list = aiModule._getOpenRouterModelsForTask('archive');
  assert.ok(Array.isArray(list));
  // Either env-driven (preferred) or legacy chain (fallback) — either way,
  // every entry must be a non-empty string.
  for (const m of list) {
    assert.equal(typeof m, 'string');
    assert.ok(m.trim().length > 0);
  }
});

test('FP3.9 getOpenRouterModelsForTask: each documented task returns an array (CI-only)', { skip: !aiModule }, () => {
  for (const task of ['archive', 'final_reveal', 'polish', 'bio']) {
    const list = aiModule._getOpenRouterModelsForTask(task);
    assert.ok(Array.isArray(list), `${task} must return an array`);
  }
});

test('FP3.10 getOpenRouterModelsForTask: unknown task name falls back to archive list (CI-only)', { skip: !aiModule }, () => {
  const archiveList = aiModule._getOpenRouterModelsForTask('archive');
  const bogusList   = aiModule._getOpenRouterModelsForTask('totally_unknown_task');
  assert.deepEqual(bogusList, archiveList,
    'unknown task selector should fall through to archive (no crash, no surprise)');
});

// ---------------------------------------------------------------------------
// 4. tryOpenRouterModelChain — runner (CI-only)
//
// The runner returns null when openrouter is not configured (no API key),
// which is the local + test-env state. Pin the contract.
// ---------------------------------------------------------------------------

test('FP3.11 tryOpenRouterModelChain: returns null without openrouter configured (CI-only)', { skip: !aiModule }, async () => {
  const r = await aiModule._tryOpenRouterModelChain({
    task: 'polish',
    userPrompt: 'hello',
    validate: () => 'ok',
  });
  assert.equal(r, null);
});

test('FP3.12 tryOpenRouterModelChain: rejects malformed args gracefully (CI-only)', { skip: !aiModule }, async () => {
  // Missing fields → null, never throws.
  for (const args of [
    {},
    { task: 'polish' },
    { task: 'polish', userPrompt: '' },
    { task: 'polish', userPrompt: 'x' },                              // no validate
    { task: '',       userPrompt: 'x', validate: () => 'ok' },
    { task: 'polish', userPrompt: 'x', validate: 'not-a-function' },
  ]) {
    const r = await aiModule._tryOpenRouterModelChain(args);
    assert.equal(r, null, `bad args must yield null: ${JSON.stringify(Object.keys(args))}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Static-source: every logAi call is metadata-only (regression pin)
// ---------------------------------------------------------------------------

test('FP3.13 services/ai/index.js logs metadata-only — never prompt/response bodies', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'index.js'),
    'utf8'
  );
  const callRe = /logAi\(\{[\s\S]*?\}\)/g;
  const calls = text.match(callRe) || [];
  assert.ok(calls.length > 0, 'expected at least one logAi call to inspect');
  for (const c of calls) {
    for (const dangerous of [
      'prompt:', 'response:', 'rawResponse:', 'rawPrompt:',
      'output:', 'body:', 'content:', 'messages:',
    ]) {
      assert.equal(c.includes(dangerous), false,
        `logAi must not include "${dangerous}": ${c.slice(0, 200)}`);
    }
  }
});

test('FP3.14 services/ai/index.js exposes the new helpers via underscore exports', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'index.js'),
    'utf8'
  );
  assert.match(text, /_getOpenRouterModelsForTask:/);
  assert.match(text, /_tryOpenRouterModelChain:/);
  assert.match(text, /_openrouterArchiveChain:/);
  // The unified runner must reference all 4 task selectors somewhere.
  for (const task of ['archive', 'final_reveal', 'polish', 'bio']) {
    assert.ok(text.includes(`'${task}'`),
      `services/ai/index.js must reference task selector '${task}'`);
  }
});

test('FP3.15 config/env.js wires all 4 task-aware model env vars', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'config', 'env.js'),
    'utf8'
  );
  assert.match(text, /OPENROUTER_ARCHIVE_MODELS\b/);
  assert.match(text, /OPENROUTER_FINAL_REVEAL_MODELS\b/);
  assert.match(text, /OPENROUTER_POLISH_MODELS\b/);
  assert.match(text, /OPENROUTER_BIO_MODELS\b/);
  // And exports each as a config field.
  for (const k of ['archiveModels', 'finalRevealModels', 'polishModels', 'bioModels']) {
    assert.ok(text.includes(k + ':'), `config.openrouter.${k} must be set`);
  }
});

// ---------------------------------------------------------------------------
// 6. Removed legacy single-model helpers — pin the migration
// ---------------------------------------------------------------------------

test('FP3.16 legacy single-model helpers (tryOpenRouterNarration / tryOpenRouterPolish) removed', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'index.js'),
    'utf8'
  );
  // Names must not be defined as functions any more.
  assert.equal(/^async function tryOpenRouterNarration/m.test(text), false,
    'tryOpenRouterNarration must be removed (now uses tryOpenRouterModelChain)');
  assert.equal(/^async function tryOpenRouterPolish/m.test(text), false,
    'tryOpenRouterPolish must be removed (now uses tryOpenRouterModelChain)');
});
