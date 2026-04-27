/**
 * AI logging foundation — pure-helper + DI-logger tests.
 *
 * Tests run against the analytics module with NO real DB and NO network.
 * The default logger is never invoked here — tests use createAiLogger()
 * with an injected fake query, exactly as documented for testability.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeAiMetadata,
  clampSafeText,
  normalizeAiLogInput,
  createAiLogger,
} = require('../services/analytics');

// ---------------------------------------------------------------------------
// 1–5: sanitizeAiMetadata
// ---------------------------------------------------------------------------

test('1. sanitizeAiMetadata strips dangerous keys at top level', () => {
  const out = sanitizeAiMetadata({
    safe: 'ok',
    prompt: 'leak1',
    rawResponse: 'leak2',
    apiKey: 'sk-leak',
    GEMINI_API_KEY: 'AIza-leak',
    JWT_SECRET: 'jwt-leak',
    archive_b64: 'b64-leak',
    authorization: 'Bearer leak',
  });
  assert.equal(out.safe, 'ok');
  for (const k of ['prompt', 'rawResponse', 'apiKey', 'GEMINI_API_KEY',
                   'JWT_SECRET', 'archive_b64', 'authorization']) {
    assert.equal(k in out, false, `key ${k} should be stripped`);
  }
});

test('2. sanitizeAiMetadata strips dangerous keys nested in objects', () => {
  const out = sanitizeAiMetadata({
    nested: {
      safe: 'ok',
      response: 'leak',
      deeper: { token: 'jwt-leak', label: 'fine', userPrompt: 'leak-prompt' },
    },
  });
  assert.equal(out.nested.safe, 'ok');
  assert.equal('response' in out.nested, false);
  assert.equal('token' in out.nested.deeper, false);
  assert.equal('userPrompt' in out.nested.deeper, false);
  assert.equal(out.nested.deeper.label, 'fine');
});

test('3. sanitizeAiMetadata strips dangerous keys inside arrays', () => {
  const out = sanitizeAiMetadata({
    items: [
      { name: 'A', secret: 'x' },
      { name: 'B', authorization: 'Bearer ...' },
      { name: 'C', headers: { 'X-Api-Key': 'k' } },
    ],
  });
  assert.equal(out.items.length, 3);
  assert.deepEqual(out.items[0], { name: 'A' });
  assert.deepEqual(out.items[1], { name: 'B' });
  assert.deepEqual(out.items[2], { name: 'C' }); // headers fully stripped
});

test('4. sanitizeAiMetadata clamps long string values', () => {
  const long = 'a'.repeat(1000);
  const out = sanitizeAiMetadata({ note: long, deep: { also: long } });
  assert.ok(out.note.length <= 300);
  assert.ok(out.note.startsWith('aaaa'));
  assert.ok(out.deep.also.length <= 300);
});

test('5. sanitizeAiMetadata preserves safe small metadata', () => {
  const input = { mode: 'normal', round: 2, ok: true, label: 'archive' };
  const out = sanitizeAiMetadata(input);
  assert.deepEqual(out, input);
});

// ---------------------------------------------------------------------------
// 6: normalizeAiLogInput clamps strings
// ---------------------------------------------------------------------------

test('6. normalizeAiLogInput clamps task/source/model/validatorReason', () => {
  const out = normalizeAiLogInput({
    task: 't'.repeat(200),
    source: 's'.repeat(200),
    model: 'm'.repeat(200),
    validatorReason: 'r'.repeat(500),
    ok: true,
    latencyMs: 100,
    userId: 42,
    gameId: 'g'.repeat(200),
  });
  assert.ok(out.task.length <= 80,    `task=${out.task.length}`);
  assert.ok(out.source.length <= 80,  `source=${out.source.length}`);
  assert.ok(out.model.length <= 120,  `model=${out.model.length}`);
  assert.ok(out.validatorReason.length <= 300, `vr=${out.validatorReason.length}`);
  assert.ok(out.gameId.length <= 80,  `gameId=${out.gameId.length}`);
  assert.equal(out.ok, true);
  assert.equal(out.latencyMs, 100);
  assert.equal(out.userId, 42);
});

// ---------------------------------------------------------------------------
// 7–10: createAiLogger behavior
// ---------------------------------------------------------------------------

test('7. logAiGeneration never throws if DB query fails', async () => {
  const failing = async () => { throw new Error('connection refused'); };
  const log = createAiLogger({ query: failing });
  await assert.doesNotReject(() => log({ task: 'archive', source: 'gemini', ok: true }));
});

test('8. logAiGeneration does not pass dangerous keys into query params', async () => {
  let captured = null;
  const fakeQuery = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  const log = createAiLogger({ query: fakeQuery });
  await log({
    task: 'archive', source: 'gemini', model: 'g-pro',
    latencyMs: 100, ok: true,
    metadata: {
      prompt: 'leak1',
      rawResponse: 'leak2',
      archive_b64: 'leak3',
      GEMINI_API_KEY: 'leak4',
      JWT_SECRET: 'leak5',
      safe: 'kept',
    },
  });
  // metadata is the 9th positional param (index 8). It is JSON-stringified.
  const metaJson = captured.params[8];
  assert.equal(typeof metaJson, 'string');
  for (const leak of ['leak1', 'leak2', 'leak3', 'leak4', 'leak5']) {
    assert.equal(metaJson.includes(leak), false, `metadata leaked: ${leak}`);
  }
  assert.ok(metaJson.includes('kept'), 'safe key should remain');
});

test('9. logAiGeneration defaults metadata to {}', async () => {
  let captured = null;
  const fakeQuery = async (sql, params) => { captured = params; return { rows: [] }; };
  const log = createAiLogger({ query: fakeQuery });
  await log({ task: 'archive', source: 'gemini', ok: true });
  assert.equal(captured[8], '{}');
});

test('10. logAiGeneration handles null/undefined input safely', async () => {
  let captured = null;
  const fakeQuery = async (sql, params) => { captured = params; return { rows: [] }; };
  const log = createAiLogger({ query: fakeQuery });
  await assert.doesNotReject(() => log(null));
  await assert.doesNotReject(() => log(undefined));
  await assert.doesNotReject(() => log({}));
  // Last call ({}) should still produce safe defaults in the INSERT params.
  assert.equal(captured[0], 'unknown', 'task default');
  assert.equal(captured[1], 'unknown', 'source default');
  assert.equal(captured[2], null, 'model default');
  assert.equal(captured[3], null, 'latencyMs default');
  assert.equal(captured[4], false, 'ok default');
  assert.equal(captured[5], null, 'validatorReason default');
  assert.equal(captured[6], null, 'userId default');
  assert.equal(captured[7], null, 'gameId default');
  assert.equal(captured[8], '{}', 'metadata default');
});

// ---------------------------------------------------------------------------
// Bonus: clampSafeText edge cases + metadata byte-budget guard
// ---------------------------------------------------------------------------

test('clampSafeText: null/undefined → null; short pass-through; long clamped', () => {
  assert.equal(clampSafeText(null, 10), null);
  assert.equal(clampSafeText(undefined, 10), null);
  assert.equal(clampSafeText('hi', 10), 'hi');
  assert.equal(clampSafeText('a'.repeat(100), 10), 'aaaaaaaaaa');
  // Coerces non-strings.
  assert.equal(clampSafeText(123, 10), '123');
  assert.equal(clampSafeText(true, 10), 'true');
});

test('sanitizeAiMetadata replaces oversized JSON with a safe truncation marker', () => {
  // Construct ~5 KB of safe string content (no dangerous keys).
  const big = 'x'.repeat(290);                  // each value ≤ 300 cap
  const arr = new Array(40).fill(big);          // ~12 KB raw
  const out = sanitizeAiMetadata({ chunks: arr });
  // Either the byte-budget marker fired, or the array survived intact.
  // Important contract: result is always an object and JSON.stringify-able.
  assert.equal(typeof out, 'object');
  const ser = JSON.stringify(out);
  assert.ok(ser.length <= 4 * 1024, `serialized ${ser.length} bytes should fit budget`);
  // If truncation marker fired, contract is documented:
  if (out._truncated) {
    assert.equal(out._truncated, 'metadata_too_large');
    assert.equal(typeof out._bytes, 'number');
  }
});
