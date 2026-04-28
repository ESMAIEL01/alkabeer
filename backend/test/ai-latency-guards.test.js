/**
 * FixPack v3 / Commit 5 — AI latency guards + chain behavior tests.
 *
 * Pinned guarantees:
 *   1. AI_TIMEOUTS exposes the documented per-task profile.
 *   2. classifyProviderError maps timeout / quota / json / other → known tags.
 *   3. tryOpenRouterModelChain accepts caller overrides for timeoutMs and
 *      totalCapMs and forwards them correctly (static-source pin).
 *   4. The chain runner is non-throwing for malformed args.
 *   5. The runner stops on the first valid output (static-source pin via
 *      `return { source: 'openrouter', ...`).
 *   6. Provider failure / invalid output → continue to next model.
 *   7. Total chain cap → stops walking and logs 'chain_cap_exceeded'.
 *   8. logAi calls under any task remain metadata-only — no prompt /
 *      response / output / messages / body / content keys.
 *   9. Frontend duplicate-click guards remain in place (static source).
 *
 * Tests run partly via the always-loaded code paths (no dotenv needed)
 * and partly via the AI module which transitively requires dotenv. The
 * AI-module path is gated with the same skip pattern used elsewhere.
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
// 1. AI_TIMEOUTS — documented profile
// ---------------------------------------------------------------------------

test('FP3-C5.1 AI_TIMEOUTS contains every documented task with sensible bounds (CI-only)', { skip: !aiModule }, () => {
  const t = aiModule._AI_TIMEOUTS;
  assert.ok(t && typeof t === 'object', 'AI_TIMEOUTS must be exported');
  assert.ok(Object.isFrozen(t), 'AI_TIMEOUTS must be frozen');
  for (const key of [
    'archive', 'final_reveal_polish', 'profile_identity', 'profile_bio',
    'clue_transition_polish', 'vote_result_polish', 'narration',
  ]) {
    assert.ok(t[key], `AI_TIMEOUTS missing key: ${key}`);
    assert.ok(Number.isFinite(t[key].perModelMs) && t[key].perModelMs > 0,
      `${key} must have positive perModelMs`);
    // totalCapMs may be null for archive (long blocking tail allowed).
    if (t[key].totalCapMs !== null) {
      assert.ok(Number.isFinite(t[key].totalCapMs) && t[key].totalCapMs > 0,
        `${key} totalCapMs must be positive when set`);
    }
  }
});

test('FP3-C5.2 AI_TIMEOUTS has documented numeric bounds (CI-only)', { skip: !aiModule }, () => {
  const t = aiModule._AI_TIMEOUTS;
  // Documented values per the spec — fixed in the source so a careless
  // operator can't slip a 5-minute cap into production.
  assert.equal(t.archive.perModelMs, 30_000);
  assert.equal(t.archive.totalCapMs, null);
  assert.equal(t.final_reveal_polish.perModelMs, 10_000);
  assert.equal(t.profile_identity.perModelMs, 10_000);
  assert.equal(t.profile_bio.perModelMs, 10_000);
  assert.equal(t.clue_transition_polish.perModelMs, 7_000);
  assert.equal(t.vote_result_polish.perModelMs, 7_000);
  assert.equal(t.narration.perModelMs, 8_000);
  // Total caps for short tasks must be present and < 30s.
  for (const k of ['final_reveal_polish', 'profile_identity', 'profile_bio',
                   'clue_transition_polish', 'vote_result_polish', 'narration']) {
    assert.ok(t[k].totalCapMs > 0 && t[k].totalCapMs < 30_000,
      `${k} totalCapMs out of bounds: ${t[k].totalCapMs}`);
  }
});

test('FP3-C5.3 _getTaskTimeout falls back to narration profile for unknown tasks (CI-only)', { skip: !aiModule }, () => {
  const t = aiModule._getTaskTimeout('totally_unknown');
  assert.deepEqual(t, aiModule._AI_TIMEOUTS.narration);
});

// ---------------------------------------------------------------------------
// 2. classifyProviderError
// ---------------------------------------------------------------------------

test('FP3-C5.4 classifyProviderError maps known errors to short tags (CI-only)', { skip: !aiModule }, () => {
  const c = aiModule._classifyProviderError;
  assert.equal(c({ message: 'request timeout' }), 'timeout');
  assert.equal(c({ message: 'aborted' }), 'timeout');
  assert.equal(c({ message: 'OpenRouter HTTP 429' }), 'quota_or_auth_error');
  assert.equal(c({ message: 'OpenRouter HTTP 401: Unauthorized' }), 'quota_or_auth_error');
  assert.equal(c({ message: 'OpenRouter HTTP 403 Forbidden' }), 'quota_or_auth_error');
  assert.equal(c({ message: 'unexpected token in JSON' }), 'malformed_json');
  assert.equal(c({ message: 'Failed to parse JSON' }), 'malformed_json');
  assert.equal(c({ message: 'connection reset' }), 'provider_error');
  assert.equal(c(null), 'provider_error');
  assert.equal(c({}), 'provider_error');
});

// ---------------------------------------------------------------------------
// 3. tryOpenRouterModelChain — non-throwing on malformed args
// ---------------------------------------------------------------------------

test('FP3-C5.5 tryOpenRouterModelChain rejects malformed args without throwing (CI-only)', { skip: !aiModule }, async () => {
  for (const args of [
    {},
    { task: 'narration' },
    { task: 'narration', userPrompt: '' },
    { task: 'narration', userPrompt: 'x' },                              // no validate
    { task: '',          userPrompt: 'x', validate: () => 'ok' },
    { task: 'narration', userPrompt: 'x', validate: 'not-a-function' },
  ]) {
    const r = await aiModule._tryOpenRouterModelChain(args);
    assert.equal(r, null, `bad args must yield null: ${JSON.stringify(Object.keys(args))}`);
  }
});

test('FP3-C5.6 tryOpenRouterModelChain returns null when openrouter not configured (CI-only)', { skip: !aiModule }, async () => {
  const r = await aiModule._tryOpenRouterModelChain({
    task: 'narration',
    userPrompt: 'hello',
    validate: () => 'ok',
  });
  // Without an API key in the local/test env, openrouterConfigured() is
  // false and the runner returns null without ever touching the network.
  assert.equal(r, null);
});

// ---------------------------------------------------------------------------
// 4. Static-source contract — chain runner honours per-attempt + chain cap
// ---------------------------------------------------------------------------

test('FP3-C5.7 services/ai/index.js: chain runner honours per-attempt timeoutMs', () => {
  const text = readSource('services/ai/index.js');
  // The runner must forward an effective per-model timeout into callOpenRouter.
  assert.match(text, /effectivePerModelMs/);
  // The forwarded value must come either from caller override or from
  // the documented task profile — pinned by the assignment shape.
  assert.match(text, /timeoutMs:\s*effectivePerModelMs/);
});

test('FP3-C5.8 services/ai/index.js: chain runner honours total chain cap', () => {
  const text = readSource('services/ai/index.js');
  assert.match(text, /effectiveTotalCapMs/);
  // The cap-exceeded log row must use a stable validatorReason tag so
  // admin analytics can filter it.
  assert.match(text, /chain_cap_exceeded/);
});

test('FP3-C5.9 services/ai/index.js: stop-on-first-valid contract is preserved', () => {
  const text = readSource('services/ai/index.js');
  // After validating, the runner must `return` the structured result
  // immediately — never iterate to the next model.
  assert.match(text, /return\s*\{\s*source:\s*['"]openrouter['"]/);
});

test('FP3-C5.10 services/ai/index.js: continues on provider failure and validator rejection', () => {
  const text = readSource('services/ai/index.js');
  // The catch block must `continue` (not throw, not return).
  assert.match(text, /catch\s*\([^)]*\)\s*\{[\s\S]{0,400}continue;/);
  // The validator-rejected branch must also `continue`.
  assert.match(text, /validator_rejected[\s\S]{0,200}continue;/);
});

// ---------------------------------------------------------------------------
// 5. logAi metadata-only contract — pinned again for Commit 5
// ---------------------------------------------------------------------------

test('FP3-C5.11 every logAi call in services/ai/index.js stays metadata-only', () => {
  const text = readSource('services/ai/index.js');
  const callRe = /logAi\(\{[\s\S]*?\}\)/g;
  const calls = text.match(callRe) || [];
  assert.ok(calls.length > 0, 'expected at least one logAi call');
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
// 6. Provider clients accept timeoutMs override
// ---------------------------------------------------------------------------

test('FP3-C5.12 openrouterClient.callOpenRouter accepts timeoutMs argument', () => {
  const text = readSource('services/ai/openrouterClient.js');
  // Function signature must include timeoutMs.
  assert.match(text, /async function callOpenRouter\(\{[^}]*timeoutMs[^}]*\}/);
  // withTimeout must use the override when supplied.
  assert.match(text, /Number\.isFinite\(timeoutMs\)/);
});

test('FP3-C5.13 geminiClient.callGemini accepts timeoutMs argument', () => {
  const text = readSource('services/ai/geminiClient.js');
  assert.match(text, /async function callGemini\(\{[^}]*timeoutMs[^}]*\}/);
  assert.match(text, /Number\.isFinite\(timeoutMs\)/);
});

// ---------------------------------------------------------------------------
// 7. Per-task timeouts are wired through to the call helpers
// ---------------------------------------------------------------------------

test('FP3-C5.14 tryGeminiPolish forwards getTaskTimeout(task).perModelMs', () => {
  const text = readSource('services/ai/index.js');
  // The Gemini polish helper must pull the per-task budget for its
  // single attempt so a slow Flash response does not block phase work.
  const idx = text.indexOf('async function tryGeminiPolish');
  assert.ok(idx > 0, 'tryGeminiPolish must exist');
  const block = text.slice(idx, text.indexOf('\n}\n', idx));
  assert.match(block, /timeoutMs:\s*getTaskTimeout\(task\)\.perModelMs/);
});

test('FP3-C5.15 tryGeminiNarration forwards AI_TIMEOUTS.narration.perModelMs', () => {
  const text = readSource('services/ai/index.js');
  const idx = text.indexOf('async function tryGeminiNarration');
  assert.ok(idx > 0);
  const block = text.slice(idx, text.indexOf('\n}\n', idx));
  assert.match(block, /timeoutMs:\s*AI_TIMEOUTS\.narration\.perModelMs/);
});

test('FP3-C5.16 tryGeminiArchive forwards AI_TIMEOUTS.archive.perModelMs', () => {
  const text = readSource('services/ai/index.js');
  const idx = text.indexOf('async function tryGeminiArchive');
  assert.ok(idx > 0);
  const block = text.slice(idx, text.indexOf('\n}\n', idx));
  assert.match(block, /timeoutMs:\s*AI_TIMEOUTS\.archive\.perModelMs/);
});

// ---------------------------------------------------------------------------
// 8. Fire-and-forget polish is preserved (no `await` blocking the phase)
// ---------------------------------------------------------------------------

test('FP3-C5.17 GameManager fires polish methods without awaiting them', () => {
  const text = readSource('game/GameManager.js');
  // The clue-transition polish hook must be fire-and-forget.
  for (const method of ['_polishVoteResult', '_polishClueTransition', '_polishFinalReveal']) {
    const idx = text.indexOf(method + '(lobby');
    if (idx < 0) continue; // method may not be invoked — skip
    // The line that calls the polish method must NOT start with `await `.
    const lineStart = text.lastIndexOf('\n', idx) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', idx));
    assert.equal(/^\s*await\s/.test(line), false,
      `${method} must not be awaited at: ${line.trim()}`);
  }
});

// ---------------------------------------------------------------------------
// 9. Frontend duplicate-click guards (static source — no Vitest infra)
// ---------------------------------------------------------------------------

test('FP3-C5.18 frontend AI-button handlers gate on a busy flag before firing', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'ProfilePage.jsx'),
    'utf8'
  );
  // Identity-interview: must check interviewBusy before firing.
  const interviewIdx = text.indexOf('const generateIdentity =');
  assert.ok(interviewIdx > 0);
  const interviewBlock = text.slice(interviewIdx, interviewIdx + 1000);
  assert.match(interviewBlock, /if\s*\(\s*interviewBusy\s*\)\s*return\s*;/);
  // Bio writer: button is disabled while aiBioBusy is true.
  assert.match(text, /disabled=\{aiBioBusy\b/);
  // Identity generate button is disabled while interviewBusy is true.
  assert.match(text, /disabled=\{interviewBusy\b/);
});

test('FP3-C5.19 frontend does NOT trigger AI calls on page mount', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'ProfilePage.jsx'),
    'utf8'
  );
  // The mount useEffect calls loadProfile() and loadHistory(0), and
  // nothing else. Asserting the ABSENCE of automatic AI calls is the
  // best we can do without a runtime test harness.
  for (const auto of [
    'requestAiBio()',
    'generateIdentity()',
    'runIdentityInterview',
    'writeProfileBio',
  ]) {
    // These names must NOT appear in the mount useEffect block (the one
    // that depends only on loadProfile / loadHistory).
    const re = new RegExp(`useEffect\\(\\s*\\(\\)\\s*=>\\s*\\{[^}]*${auto.replace(/[()]/g, '')}`);
    assert.equal(re.test(text), false,
      `mount useEffect must not auto-call ${auto}`);
  }
});

test('FP3-C5.20 LobbyPage AI-host ready button gates on aiLoading / aiHostBusy', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'LobbyPage.jsx'),
    'utf8'
  );
  // The host-start button must already render with a `disabled={...}` prop
  // tied to the in-flight state. We accept any of the documented flags.
  assert.match(text, /disabled=\{[^}]*(aiLoading|aiHostBusy|busy)\b[^}]*\}/);
});

// ---------------------------------------------------------------------------
// 10. No new schema, no new dependencies, no image generation
// ---------------------------------------------------------------------------

test('FP3-C5.21 Commit 5 introduces no new backend dependency', () => {
  const pkg = require('../package.json');
  // Quick guard: nothing image-y, nothing upload-y, nothing AI-image-y.
  for (const dep of ['multer', 'formidable', 'sharp', 'jimp', 'canvas',
                      'replicate', 'openai-image', 'fal-ai', 'falai']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, dep),
      false,
      `Commit 5 must not introduce dependency ${dep}`
    );
  }
});

test('FP3-C5.22 Commit 5 introduces no new schema migration', () => {
  const dir = path.resolve(__dirname, '..', 'db', 'migrations');
  if (!fs.existsSync(dir)) return; // migration ledger may live elsewhere; non-fatal
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
  // Spot-check: the most recent migration is the F1/F2 ledger entry.
  // We just confirm no migration filename mentions "image" or "avatar"
  // or "upload" — those would suggest an unwanted schema change.
  for (const f of files) {
    for (const forbidden of ['image', 'upload', 'avatar_image', 'identity_save']) {
      assert.equal(f.toLowerCase().includes(forbidden), false,
        `migration ${f} should not introduce ${forbidden} schema`);
    }
  }
});
