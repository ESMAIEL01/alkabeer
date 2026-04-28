/**
 * Polish Pack / Feature 1 — POST /api/scenarios/premium-fallback contract.
 *
 * Pinned guarantees:
 *   - The route exists, validates counts via normalizeCustomCounters, and
 *     reuses buildFallbackArchive (no AI provider call).
 *   - On success, the response carries source="fallback",
 *     model="premium-deterministic", a complete archive_b64 payload, and
 *     the same wire shape as /ai-generate.
 *   - Schema + quality validation runs before the response is shaped, so
 *     the route can never ship a placeholder/weak archive even if the
 *     pools are tweaked later.
 *   - logAiGeneration is called for the new task tag
 *     'archive_premium_fallback' and is metadata-only — no prompt,
 *     response, output, body, content, or messages keys.
 *   - Invalid counts return 400 with an Arabic error.
 *
 * Style: static-source assertions for the wiring contract, plus a thin
 * programmatic invocation of the route handler with mock req/res. The
 * router is loaded lazily under try/catch so the test runs in CI (full
 * env) and skips locally when env is unset (mirrors archive-deadline /
 * archive-chain-rejection / ai-latency-guards).
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

let scenariosRouter;
try {
  scenariosRouter = require('../routes/scenarios');
} catch (_) {
  scenariosRouter = null;
}

function readSource(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Static-source wiring (always run)
// ---------------------------------------------------------------------------

test('PFR.1 routes/scenarios.js declares POST /premium-fallback', () => {
  const text = readSource('routes/scenarios.js');
  assert.match(text, /router\.post\(['"]\/premium-fallback['"]/);
});

test('PFR.2 premium-fallback handler imports the deterministic builder + validator', () => {
  const text = readSource('routes/scenarios.js');
  assert.match(text, /require\(['"]\.\.\/services\/ai\/archive-fallback['"]\)/);
  assert.match(text, /buildFallbackArchive/);
  assert.match(text, /require\(['"]\.\.\/services\/ai\/validators['"]\)/);
  assert.match(text, /validateArchive/);
});

test('PFR.3 premium-fallback handler enforces schema + quality validation', () => {
  const text = readSource('routes/scenarios.js');
  // Locate the route block for /premium-fallback and verify it calls
  // validateArchive(...) with enforceQuality: true (which transitively
  // runs validateArchiveQuality after the schema check).
  const idx = text.indexOf("router.post('/premium-fallback'");
  assert.ok(idx > 0, 'must locate /premium-fallback handler');
  const tail = text.slice(idx);
  const nextIdx = tail.indexOf("router.post(");
  // Skip the opening 'router.post' itself, look at the block until the next route.
  const handlerEnd = tail.indexOf("router.post(", 1);
  const block = handlerEnd > 0 ? tail.slice(0, handlerEnd) : tail;
  assert.match(block, /buildFallbackArchive\(/, 'must call buildFallbackArchive');
  assert.match(block, /validateArchive\(/, 'must call validateArchive');
  assert.match(block, /enforceQuality:\s*true/, 'must enforce quality gate');
  void nextIdx;
});

test('PFR.4 premium-fallback handler logs analytics under the new task tag, metadata-only', () => {
  const text = readSource('routes/scenarios.js');
  const idx = text.indexOf("router.post('/premium-fallback'");
  const handlerEnd = text.indexOf("router.post(", idx + 10);
  const block = handlerEnd > 0 ? text.slice(idx, handlerEnd) : text.slice(idx);
  // Two logAiGeneration calls expected: one on quality failure, one on success.
  const calls = block.match(/logAiGeneration\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(calls.length >= 1, 'must log at least once');
  for (const c of calls) {
    assert.match(c, /task:\s*['"]archive_premium_fallback['"]/);
    assert.match(c, /source:\s*['"]fallback['"]/);
    assert.match(c, /model:\s*['"]premium-deterministic['"]/);
    for (const dangerous of [
      'prompt:', 'response:', 'rawPrompt:', 'rawResponse:',
      'output:', 'body:', 'content:', 'messages:', 'archive_b64:',
    ]) {
      assert.equal(c.includes(dangerous), false,
        `logAiGeneration must not include "${dangerous}": ${c.slice(0, 200)}`);
    }
  }
});

test('PFR.5 premium-fallback handler must NOT call ai.generateSealedArchive (no provider call)', () => {
  const text = readSource('routes/scenarios.js');
  const idx = text.indexOf("router.post('/premium-fallback'");
  const handlerEnd = text.indexOf("router.post(", idx + 10);
  const block = handlerEnd > 0 ? text.slice(idx, handlerEnd) : text.slice(idx);
  assert.equal(/ai\.generateSealedArchive/.test(block), false,
    'premium-fallback must never call the AI service');
  assert.equal(/ai\.narrate/.test(block), false,
    'premium-fallback must never call narrate');
});

// ---------------------------------------------------------------------------
// 2. Programmatic invocation of the route handler (skip when env unavailable)
// ---------------------------------------------------------------------------

function findHandler(router, p) {
  if (!router || !router.stack) return null;
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === p) {
      const stack = layer.route.stack || [];
      for (const s of stack) {
        if (typeof s.handle === 'function') return s.handle;
      }
    }
  }
  return null;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    finished: false,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; this.finished = true; return this; },
  };
  return res;
}

async function callHandler(handler, body) {
  const req = { body: body || {}, headers: {} };
  const res = makeRes();
  let nextErr = null;
  await handler(req, res, (err) => { nextErr = err; });
  return { req, res, nextErr };
}

test('PFR.6 default 4/3/1 → success with source=fallback, model=premium-deterministic',
  { skip: !scenariosRouter }, async () => {
    const handler = findHandler(scenariosRouter, '/premium-fallback');
    assert.ok(handler, 'route handler must exist on the router stack');
    const { res, nextErr } = await callHandler(handler, {});
    assert.equal(nextErr, null, `next(err) must not fire: ${nextErr && nextErr.message}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.source, 'fallback');
    assert.equal(res.body.model, 'premium-deterministic');
    assert.ok(typeof res.body.scenario === 'string' && res.body.scenario.length > 60);
    assert.ok(typeof res.body.archive_b64 === 'string' && res.body.archive_b64.length > 100);
    assert.ok(Array.isArray(res.body.characters) && res.body.characters.length === 5);
    assert.ok(Array.isArray(res.body.clues) && res.body.clues.length === 3);
    // archive_b64 must be valid base64 JSON of the same archive.
    const decoded = JSON.parse(Buffer.from(res.body.archive_b64, 'base64').toString('utf8'));
    assert.ok(typeof decoded.title === 'string');
    assert.ok(Array.isArray(decoded.clues) && decoded.clues.length === 3);
  });

test('PFR.7 custom 5/2/4 → success with mafiozos array of length 2',
  { skip: !scenariosRouter }, async () => {
    const handler = findHandler(scenariosRouter, '/premium-fallback');
    const { res, nextErr } = await callHandler(handler, {
      players: 5, clueCount: 2, mafiozoCount: 2, idea: 'سرقة لوحة',
    });
    assert.equal(nextErr, null);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.source, 'fallback');
    assert.equal(res.body.model, 'premium-deterministic');
    assert.equal(res.body.characters.length, 5);
    assert.equal(res.body.clues.length, 2);
    const decoded = JSON.parse(Buffer.from(res.body.archive_b64, 'base64').toString('utf8'));
    assert.ok(Array.isArray(decoded.mafiozos));
    assert.equal(decoded.mafiozos.length, 2);
    // Legacy singular field preserved for old clients.
    assert.equal(typeof decoded.mafiozo, 'string');
  });

test('PFR.8 invalid players=2 → 400 Arabic error',
  { skip: !scenariosRouter }, async () => {
    const handler = findHandler(scenariosRouter, '/premium-fallback');
    const { res } = await callHandler(handler, { players: 2, clueCount: 3, mafiozoCount: 1 });
    assert.equal(res.statusCode, 400);
    assert.equal(typeof res.body.error, 'string');
    assert.match(res.body.error, /[؀-ۿ]/, 'error must be Arabic');
  });

test('PFR.9 invalid mafiozoCount above floor((N-1)/2) → 400',
  { skip: !scenariosRouter }, async () => {
    const handler = findHandler(scenariosRouter, '/premium-fallback');
    // players=5 → max mafiozo = 2; passing 4 must reject.
    const { res } = await callHandler(handler, { players: 5, clueCount: 3, mafiozoCount: 4 });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /[؀-ۿ]/);
  });

test('PFR.10 response NEVER carries gameRole or any role-flagged field',
  { skip: !scenariosRouter }, async () => {
    const handler = findHandler(scenariosRouter, '/premium-fallback');
    const { res } = await callHandler(handler, { players: 6, clueCount: 3, mafiozoCount: 2 });
    const s = JSON.stringify(res.body);
    for (const banned of ['gameRole', 'roleAssignments', 'role_assignments', 'gameRoleId']) {
      assert.equal(s.includes(banned), false, `response must not contain "${banned}"`);
    }
  });
