/**
 * FixPack v3 / Commit 3 — archive chain rejection logging + total
 * budget + optional repair flow.
 *
 * Pinned guarantees:
 *   - classifyValidatorReason maps quality reasons to stable category
 *     tags (no @-suffix indices) for analytics roll-up.
 *   - AI_TIMEOUTS.archive now has a documented totalCapMs (40s).
 *   - generateSealedArchive walks the chain in order and calls the
 *     deterministic fallback when the budget is exceeded.
 *   - Optional Qwen JSON repair is skipped silently when the repair
 *     model env var is empty.
 *   - logAi calls under task='archive_repair' remain metadata-only.
 *   - The repair model env var name is documented in .env.example.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

let aiModule;
try {
  aiModule = require('../services/ai');
} catch (_) {
  aiModule = null;
}

function readSource(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. classifyValidatorReason — analytics roll-up
// ---------------------------------------------------------------------------

test('CR.1 classifyValidatorReason strips @N suffix from quality reasons (CI-only)', { skip: !aiModule }, () => {
  const c = aiModule._classifyValidatorReason;
  assert.equal(c('weak_clue@2'), 'weak_clue');
  assert.equal(c('weak_clue@0'), 'weak_clue');
  assert.equal(c('clues_too_similar@1,3'), 'clues_too_similar');
  assert.equal(c('weak_character_name@4'), 'weak_character_name');
  assert.equal(c('username_like_name@mafiozo0'), 'username_like_name');
  assert.equal(c('character_role_length@2'), 'character_role_length');
  assert.equal(c('suspicious_detail_length@1'), 'suspicious_detail_length');
  assert.equal(c('weak_suspicious_detail@5'), 'weak_suspicious_detail');
  assert.equal(c('clue_too_short@0'), 'clue_too_short');
  assert.equal(c('clue_too_long@2'), 'clue_too_long');
  assert.equal(c('placeholder_detected'), 'placeholder_detected');
});

test('CR.2 classifyValidatorReason passes through known quality categories (CI-only)', { skip: !aiModule }, () => {
  const c = aiModule._classifyValidatorReason;
  for (const r of ['title_length', 'weak_title', 'story_length', 'weak_story',
                   'story_arabic_low', 'clue_arabic_low', 'weak_mafiozo_name',
                   'weak_obvious_suspect']) {
    assert.equal(c(r), r, `${r} must pass through unchanged`);
  }
});

test('CR.3 classifyValidatorReason maps unknown / schema-shaped reasons to "schema_invalid" (CI-only)', { skip: !aiModule }, () => {
  const c = aiModule._classifyValidatorReason;
  for (const r of ['missing story', 'expected exactly 3 clues, got 2',
                   'invalid character at index 1', 'something weird']) {
    assert.equal(c(r), 'schema_invalid', `${r} must bucket to schema_invalid`);
  }
  // Defensive: non-string / empty input.
  assert.equal(c(null), 'schema_invalid');
  assert.equal(c(''), 'schema_invalid');
  assert.equal(c(undefined), 'schema_invalid');
});

// ---------------------------------------------------------------------------
// 2. AI_TIMEOUTS.archive has a documented total budget
// ---------------------------------------------------------------------------

test('CR.4 AI_TIMEOUTS.archive has perModelMs + totalCapMs set (CI-only)', { skip: !aiModule }, () => {
  const t = aiModule._AI_TIMEOUTS.archive;
  assert.ok(Number.isFinite(t.perModelMs) && t.perModelMs > 0,
    'archive perModelMs must be set');
  assert.ok(Number.isFinite(t.totalCapMs) && t.totalCapMs > 0,
    'archive totalCapMs must be set (no longer null)');
  // Sanity: 25–45 second window per the spec.
  assert.ok(t.perModelMs >= 18_000 && t.perModelMs <= 30_000);
  assert.ok(t.totalCapMs >= 35_000 && t.totalCapMs <= 60_000);
});

// ---------------------------------------------------------------------------
// 3. Repair flow — env-driven opt-in, no-op when empty
// ---------------------------------------------------------------------------

test('CR.5 tryArchiveJsonRepair is a no-op when openrouter is unconfigured (CI-only)', { skip: !aiModule }, async () => {
  const r = await aiModule._tryArchiveJsonRepair('garbage', { players: 4, clueCount: 3, mafiozoCount: 1 });
  assert.equal(r, null);
});

test('CR.6 tryArchiveJsonRepair returns null for empty / non-string raw text (CI-only)', { skip: !aiModule }, async () => {
  for (const raw of [null, undefined, '', '   ', 42]) {
    const r = await aiModule._tryArchiveJsonRepair(raw, {});
    assert.equal(r, null, `bad raw=${JSON.stringify(raw)} must yield null`);
  }
});

// ---------------------------------------------------------------------------
// 4. Static-source: chain runner enforces total budget
// ---------------------------------------------------------------------------

test('CR.7 services/ai/index.js generateSealedArchive enforces totalCapMs', () => {
  const text = readSource('services/ai/index.js');
  // The chain runner must compute an `chainStart` timestamp and a
  // `budgetExceeded` predicate, AND check it before each rung.
  const idx = text.indexOf('async function generateSealedArchive');
  assert.ok(idx > 0);
  const body = text.slice(idx, idx + 2500);
  assert.match(body, /chainStart\s*=\s*Date\.now\(\)/);
  assert.match(body, /totalCapMs\s*=\s*AI_TIMEOUTS\.archive\.totalCapMs/);
  assert.match(body, /budgetExceeded\s*=/);
  // The OpenRouter loop must check the predicate before EACH rung.
  assert.match(body, /if\s*\(\s*budgetExceeded\(\)\s*\)/);
  // The cap-exceeded path must log a stable validatorReason tag.
  assert.match(body, /chain_cap_exceeded/);
});

test('CR.8 services/ai/index.js archive helpers pass classifyValidatorReason on rejection', () => {
  const text = readSource('services/ai/index.js');
  // Both Gemini + OpenRouter archive helpers must use
  // classifyValidatorReason() instead of the old generic
  // 'validator_rejected' literal when validation fails.
  // We allow the literal 'validator_rejected' to remain in the polish
  // chain runner (which handles cleaner deterministic outputs); the
  // archive path specifically must use the classifier.
  const archiveHelpers = text.match(
    /async function tryGeminiArchive[\s\S]+?\n\}\n[\s\S]*?async function tryOpenRouterArchive[\s\S]+?\n\}/m
  );
  assert.ok(archiveHelpers && archiveHelpers[0],
    'must locate both archive helpers');
  const block = archiveHelpers[0];
  // Both helpers must reference classifyValidatorReason on validator
  // rejection. A regex count of >= 2 matches confirms both code paths
  // are wired.
  const matches = block.match(/classifyValidatorReason\(/g) || [];
  assert.ok(matches.length >= 2,
    `expected >= 2 classifyValidatorReason calls in archive helpers; got ${matches.length}`);
});

// ---------------------------------------------------------------------------
// 5. logAi metadata-only contract (regression pin)
// ---------------------------------------------------------------------------

test('CR.9 archive_repair logAi calls remain metadata-only', () => {
  const text = readSource('services/ai/index.js');
  // Locate every logAi call inside tryArchiveJsonRepair and verify none
  // includes prompt / response / output keys.
  const idx = text.indexOf('async function tryArchiveJsonRepair');
  assert.ok(idx > 0);
  const block = text.slice(idx, idx + 3000);
  const calls = block.match(/logAi\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(calls.length > 0, 'tryArchiveJsonRepair must log at least once');
  for (const c of calls) {
    for (const dangerous of [
      'prompt:', 'response:', 'rawPrompt:', 'rawResponse:',
      'output:', 'body:', 'content:', 'messages:',
    ]) {
      assert.equal(c.includes(dangerous), false,
        `logAi must not include "${dangerous}": ${c.slice(0, 200)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 6. Env documentation — OPENROUTER_REPAIR_MODELS in .env.example
// ---------------------------------------------------------------------------

test('CR.10 .env.example documents OPENROUTER_REPAIR_MODELS as optional', () => {
  const text = readSource('.env.example');
  assert.match(text, /OPENROUTER_REPAIR_MODELS\b/,
    '.env.example must document the new repair models env var');
  // The documentation comment should make it clear this is OPTIONAL.
  assert.match(text, /OPTIONAL/i);
  // The default must be empty (operator opt-in).
  assert.match(text, /OPENROUTER_REPAIR_MODELS=\s*$/m);
});

test('CR.11 config/env.js wires repairModels through parseModelList', () => {
  const text = readSource('config/env.js');
  assert.match(text, /repairModels\s*:\s*parseModelList\(\s*process\.env\.OPENROUTER_REPAIR_MODELS\s*\)/);
});

// ---------------------------------------------------------------------------
// 7. Repair prompt safety — no raw user prompt logging in flight
// ---------------------------------------------------------------------------

test('CR.12 tryArchiveJsonRepair prompt forbids inventing missing content', () => {
  const text = readSource('services/ai/index.js');
  const idx = text.indexOf('async function tryArchiveJsonRepair');
  assert.ok(idx > 0);
  const block = text.slice(idx, idx + 3000);
  // The repair prompt body must instruct the model not to invent
  // content. We pin the actual phrasing.
  assert.match(block, /Do NOT invent missing|do not invent missing/i);
  // It must also include the "INVALID" sentinel so unrepairable input
  // can be flagged without producing fake JSON.
  assert.match(block, /INVALID/);
});
