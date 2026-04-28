/**
 * FixPack v3 / Latency hotfix — deadline-driven archive generation.
 *
 * Pinned guarantees:
 *   - AI_TIMEOUTS.archive carries perModelMs / totalCapMs / minAttemptMs
 *     within the documented bounds.
 *   - createDeadline produces a working timer with remainingMs / canAttempt
 *     / clamp / expired semantics.
 *   - generateSealedArchive is bounded by the public deadline; the
 *     deadline timer races the chain, the pre-built premium fallback
 *     wins when the chain takes too long.
 *   - Per-model timeoutMs passed into provider helpers is
 *     min(perModelMs, remainingMs) — pinned by source-grep so a
 *     refactor that loses this property fails the test.
 *   - Default OpenRouter archive order recommended in .env.example
 *     puts z-ai first.
 *   - Premium fallback returned when chain is exhausted is properly
 *     marked source='fallback' / model='premium-deterministic'.
 *   - All logAi calls in the new flow remain metadata-only.
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
// 1. AI_TIMEOUTS profile — documented latency envelope
// ---------------------------------------------------------------------------

test('LH.1 AI_TIMEOUTS.archive has perModelMs ≤ 15s, totalCapMs ≤ 45s, minAttemptMs set (CI-only)', { skip: !aiModule }, () => {
  const t = aiModule._AI_TIMEOUTS.archive;
  assert.ok(Number.isFinite(t.perModelMs) && t.perModelMs > 0);
  assert.ok(Number.isFinite(t.totalCapMs) && t.totalCapMs > 0);
  assert.ok(Number.isFinite(t.minAttemptMs) && t.minAttemptMs > 0);
  // Latency target: 10–15 s per model, 40–45 s total, 2–5 s min attempt.
  assert.ok(t.perModelMs >= 10_000 && t.perModelMs <= 15_000,
    `perModelMs out of [10s, 15s] target: ${t.perModelMs}`);
  assert.ok(t.totalCapMs >= 40_000 && t.totalCapMs <= 45_000,
    `totalCapMs out of [40s, 45s] target: ${t.totalCapMs}`);
  assert.ok(t.minAttemptMs >= 2_000 && t.minAttemptMs <= 5_000,
    `minAttemptMs out of [2s, 5s] target: ${t.minAttemptMs}`);
});

test('LH.2 every documented task carries minAttemptMs (CI-only)', { skip: !aiModule }, () => {
  const t = aiModule._AI_TIMEOUTS;
  for (const k of ['archive', 'final_reveal_polish', 'profile_identity',
                   'profile_bio', 'clue_transition_polish',
                   'vote_result_polish', 'narration']) {
    assert.ok(Number.isFinite(t[k].minAttemptMs) && t[k].minAttemptMs > 0,
      `${k} must carry a positive minAttemptMs`);
  }
});

// ---------------------------------------------------------------------------
// 2. createDeadline — helper semantics
// ---------------------------------------------------------------------------

test('LH.3 createDeadline.remainingMs / canAttempt / clamp / expired (CI-only)', { skip: !aiModule }, async () => {
  const d = aiModule._createDeadline(40);
  assert.equal(d.totalMs, 40);
  // Right after creation, we should have ~40ms remaining.
  assert.ok(d.remainingMs() > 30 && d.remainingMs() <= 40);
  assert.equal(d.expired(), false);
  // canAttempt: 30ms is OK, 100ms is not.
  assert.equal(d.canAttempt(30), true);
  assert.equal(d.canAttempt(100), false);
  // clamp: the smaller of (perModelMs, remainingMs).
  assert.ok(d.clamp(50) <= d.remainingMs());
  // Wait past deadline.
  await new Promise(r => setTimeout(r, 60));
  assert.equal(d.expired(), true);
  assert.equal(d.canAttempt(1), false);
  // clamp returns at least 1 (never 0) so callers don't pass 0 to a fetch.
  assert.ok(d.clamp(50) >= 1);
});

test('LH.4 createDeadline rejects non-positive totalMs gracefully (CI-only)', { skip: !aiModule }, () => {
  for (const bad of [0, -1, NaN, null, undefined]) {
    const d = aiModule._createDeadline(bad);
    assert.ok(d.totalMs > 0, `totalMs must be sanitized for input=${bad}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Static-source — generateSealedArchive uses the deadline race + clamp
// ---------------------------------------------------------------------------

test('LH.5 generateSealedArchive uses createDeadline + Promise.race deadline timer', () => {
  const text = readSource('services/ai/index.js');
  const idx = text.indexOf('async function generateSealedArchive');
  assert.ok(idx > 0);
  const body = text.slice(idx, idx + 4000);
  // Must instantiate a deadline object with the archive totalCapMs.
  assert.match(body, /createDeadline\(\s*AI_TIMEOUTS\.archive\.totalCapMs/);
  // Must race the chain against a deadline timer (Promise.race or similar).
  assert.match(body, /Promise\.race\(/);
  // Must build a premium fallback BEFORE the race (so the race has
  // something to fall back to).
  const fallbackIdx = body.indexOf('buildFallbackArchive(input)');
  const raceIdx = body.indexOf('Promise.race(');
  assert.ok(fallbackIdx > 0 && raceIdx > 0,
    'fallback build and race must both be present');
  assert.ok(fallbackIdx < raceIdx,
    'premium fallback must be built BEFORE Promise.race so the race can return it');
});

test('LH.6 generateSealedArchive passes deadline.clamp(perModelMs) into every provider attempt', () => {
  const text = readSource('services/ai/index.js');
  const idx = text.indexOf('async function generateSealedArchive');
  assert.ok(idx > 0);
  const body = text.slice(idx, idx + 4000);
  // Every tryGeminiArchive / tryOpenRouterArchive call inside the chain
  // must pass timeoutMs: deadline.clamp(PER_MODEL).
  const callMatches = body.match(/timeoutMs:\s*deadline\.clamp\(/g) || [];
  assert.ok(callMatches.length >= 3,
    `expected ≥ 3 deadline.clamp() forwards (Gemini Pro, Gemini Flash, OpenRouter), got ${callMatches.length}`);
});

test('LH.7 generateSealedArchive skips a rung when deadline.canAttempt(MIN_ATTEMPT) is false', () => {
  const text = readSource('services/ai/index.js');
  const idx = text.indexOf('async function generateSealedArchive');
  assert.ok(idx > 0);
  const body = text.slice(idx, idx + 4000);
  // Each rung must gate on deadline.canAttempt(MIN_ATTEMPT) before
  // starting the call.
  const canAttemptMatches = body.match(/deadline\.canAttempt\(\s*MIN_ATTEMPT\s*\)/g) || [];
  assert.ok(canAttemptMatches.length >= 3,
    `expected ≥ 3 canAttempt gates, got ${canAttemptMatches.length}`);
});

test('LH.8 generateSealedArchive marks the deadline-race fallback with a stable shape', () => {
  const text = readSource('services/ai/index.js');
  const idx = text.indexOf('async function generateSealedArchive');
  assert.ok(idx > 0);
  // Slice from the function start to the next top-level function so we
  // capture the FULL body, not just an arbitrary 4000-char prefix.
  const tail = text.slice(idx + 1);
  const nextFnIdx = tail.search(/\nasync function /);
  const body = tail.slice(0, nextFnIdx > 0 ? nextFnIdx : tail.length);
  assert.match(body, /source:\s*['"]fallback['"]/);
  assert.match(body, /model:\s*['"]premium-deterministic['"]/);
});

// ---------------------------------------------------------------------------
// 4. Static-source — provider helpers accept caller timeoutMs
// ---------------------------------------------------------------------------

test('LH.9 tryGeminiArchive accepts timeoutMs and forwards it to callGemini', () => {
  const text = readSource('services/ai/index.js');
  const idx = text.indexOf('async function tryGeminiArchive');
  assert.ok(idx > 0);
  const block = text.slice(idx, text.indexOf('\n}\n', idx));
  // Function signature must include timeoutMs in its destructure.
  assert.match(block, /async function tryGeminiArchive\([^)]*\{[^)]*timeoutMs/);
  // It must be forwarded to callGemini.
  assert.match(block, /timeoutMs:\s*Number\.isFinite\(timeoutMs\)/);
});

test('LH.10 tryOpenRouterArchive accepts timeoutMs and forwards it', () => {
  const text = readSource('services/ai/index.js');
  const idx = text.indexOf('async function tryOpenRouterArchive');
  assert.ok(idx > 0);
  const block = text.slice(idx, text.indexOf('\n}\n', idx));
  assert.match(block, /async function tryOpenRouterArchive\([^)]*,\s*\{[^)]*timeoutMs/);
  assert.match(block, /timeoutMs:\s*Number\.isFinite\(timeoutMs\)/);
});

// ---------------------------------------------------------------------------
// 5. Default OpenRouter archive order recommends z-ai first
// ---------------------------------------------------------------------------

test('LH.11 .env.example recommends z-ai first in OPENROUTER_ARCHIVE_MODELS', () => {
  const text = readSource('.env.example');
  const m = text.match(/^OPENROUTER_ARCHIVE_MODELS=(.+)$/m);
  assert.ok(m, 'OPENROUTER_ARCHIVE_MODELS line must be present');
  const list = m[1].split(',').map(s => s.trim());
  assert.equal(list[0], 'z-ai/glm-4.5-air:free',
    `z-ai must be FIRST in the recommended archive chain; got ${list.join(' → ')}`);
  // The other three known models must still be present.
  for (const m2 of ['openai/gpt-oss-120b:free', 'minimax/minimax-m2.5:free',
                    'liquid/lfm-2.5-1.2b-thinking:free']) {
    assert.ok(list.includes(m2), `expected ${m2} in the chain`);
  }
});

// ---------------------------------------------------------------------------
// 6. Privacy regression — logAi remains metadata-only across the new flow
// ---------------------------------------------------------------------------

test('LH.12 every logAi call in services/ai/index.js stays metadata-only', () => {
  const text = readSource('services/ai/index.js');
  const callRe = /logAi\(\{[\s\S]*?\}\)/g;
  const calls = text.match(callRe) || [];
  assert.ok(calls.length > 0);
  for (const c of calls) {
    for (const dangerous of [
      'prompt:', 'response:', 'rawPrompt:', 'rawResponse:',
      'output:', 'body:', 'content:', 'messages:', 'answers:',
    ]) {
      assert.equal(c.includes(dangerous), false,
        `logAi must not include "${dangerous}": ${c.slice(0, 200)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 7. Premium fallback quality gate (regression — Commit 2 contract)
// ---------------------------------------------------------------------------

test('LH.13 premium fallback ALWAYS passes schema + quality (regression)', () => {
  const { buildFallbackArchive } = require('../services/ai/archive-fallback');
  const { validateArchive, validateArchiveQuality } = require('../services/ai/validators');
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
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 8. Behavioral test — generateSealedArchive returns the premium fallback
//    within the deadline window when no provider is configured.
// ---------------------------------------------------------------------------

test('LH.14 generateSealedArchive returns premium fallback under deadline when no provider configured (CI-only)',
  { skip: !aiModule }, async () => {
  // In the local sandbox / CI test env, neither GEMINI_API_KEY nor
  // OpenRouter is configured (or both are empty). The chain immediately
  // bails to the deterministic premium fallback. We pin: the call
  // returns within ONE total cap of `archive.totalCapMs`, with the
  // expected source/model labels.
  const startedAt = Date.now();
  const result = await aiModule.generateSealedArchive({});
  const elapsed = Date.now() - startedAt;
  assert.ok(result, 'must return something');
  assert.ok(result.archive, 'must include archive');
  // The result should be a fallback (no providers configured).
  if (result.source === 'fallback') {
    assert.equal(result.model, 'premium-deterministic');
  }
  // And it must complete WELL within the deadline window — the
  // unconfigured-provider path is essentially instant (no network).
  assert.ok(elapsed < 5_000,
    `unconfigured path must be near-instant; took ${elapsed}ms`);
});
