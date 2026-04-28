/**
 * FixPack v3 / Commit 2 — guided identity-interview tests.
 *
 * Pinned contracts:
 *   - request validator (length, char limits, URL/email/phone/HTML/script
 *     /markdown/code-fence rejection, per-answer char windows)
 *   - output validator (5 fields, individual length windows, denylist)
 *   - deterministic fallback builder (always passes the output validator)
 *   - route wiring (authRequired → aiLimiter → handler) via static-source
 *   - logAi calls under the 'profile_identity' task label remain
 *     metadata-only (no raw prompts, no raw responses)
 *
 * No DB, no network. Uses dep-free helper imports where possible.
 * The validator + fallback runtime tests run in CI via npm ci.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Always-load pure helpers.
const {
  validateIdentityInterviewRequest,
  IDENTITY_ANSWERS_MIN,
  IDENTITY_ANSWERS_MAX,
  IDENTITY_ANSWER_MIN,
  IDENTITY_ANSWER_MAX,
} = require('../routes/profile-helpers');
const { buildFallbackIdentity } = require('../services/ai/identity-fallback');

// Conditionally-load (services/ai/validators pulls no deps but
// transitively the AI module needs dotenv — load validators directly).
const { validateIdentityInterviewOutput, IDENTITY_FIELD_LIMITS } =
  require('../services/ai/validators');

// ---------------------------------------------------------------------------
// 1. Request validator — happy path
// ---------------------------------------------------------------------------

function makeAnswers(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      questionId: `q${i + 1}`,
      question: `سؤال رقم ${i + 1}؟`,
      answer: `إجابة قصيرة على السؤال ${i + 1}.`,
    });
  }
  return out;
}

test('FP3-C2.1 request validator: 3..6 valid answers pass and are normalized', () => {
  for (const n of [3, 4, 5, 6]) {
    const r = validateIdentityInterviewRequest({ answers: makeAnswers(n) });
    assert.equal(r.ok, true, `length ${n} should pass: ${r.error || 'ok'}`);
    assert.equal(r.normalized.answers.length, n);
    for (const a of r.normalized.answers) {
      assert.ok(a.questionId && a.question && a.answer);
    }
  }
});

test('FP3-C2.2 request validator: rejects fewer than 3 or more than 6 answers', () => {
  const r1 = validateIdentityInterviewRequest({ answers: makeAnswers(2) });
  assert.equal(r1.ok, false);
  assert.match(r1.error, new RegExp(String(IDENTITY_ANSWERS_MIN)));
  const r2 = validateIdentityInterviewRequest({ answers: makeAnswers(7) });
  assert.equal(r2.ok, false);
  assert.match(r2.error, new RegExp(String(IDENTITY_ANSWERS_MAX)));
});

test('FP3-C2.3 request validator: rejects missing/non-array body', () => {
  for (const body of [null, undefined, {}, { answers: 'not-array' }, { answers: 42 }]) {
    const r = validateIdentityInterviewRequest(body);
    assert.equal(r.ok, false);
  }
});

// ---------------------------------------------------------------------------
// 2. Request validator — per-answer rejection patterns
// ---------------------------------------------------------------------------

function answerWith(text) {
  // 3 valid + 1 hostile candidate.
  return [
    ...makeAnswers(3),
    { questionId: 'qX', question: 'سؤال X؟', answer: text },
  ];
}

test('FP3-C2.4 request validator: rejects URLs in answers', () => {
  for (const url of [
    'visit https://example.com now',
    'http://x.test',
    'go to www.example.org',
  ]) {
    const r = validateIdentityInterviewRequest({ answers: answerWith(url) });
    assert.equal(r.ok, false, `must reject URL: ${url}`);
    assert.match(r.error, /رابط/);
  }
});

test('FP3-C2.5 request validator: rejects emails in answers', () => {
  const r = validateIdentityInterviewRequest({
    answers: answerWith('contact me at hi@example.com please'),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /إيميل/);
});

test('FP3-C2.6 request validator: rejects phone numbers (ASCII + Arabic-Indic digits)', () => {
  for (const phone of [
    'call me on +1-555-123-4567',
    'هاتف 0102345678',
    'رقم ٠١٠٢٣٤٥٦٧٨',
  ]) {
    const r = validateIdentityInterviewRequest({ answers: answerWith(phone) });
    assert.equal(r.ok, false, `must reject phone: ${phone}`);
    assert.match(r.error, /تليفون/);
  }
});

test('FP3-C2.7 request validator: rejects HTML/script tags', () => {
  for (const html of [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src=evil></iframe>',
    '<div>hello</div>',
  ]) {
    const r = validateIdentityInterviewRequest({ answers: answerWith(html) });
    assert.equal(r.ok, false, `must reject HTML: ${html}`);
  }
});

test('FP3-C2.8 request validator: rejects code fences and markdown', () => {
  for (const md of [
    'check this ```javascript\nbad()\n```',
    '## Big heading',
    'use **bold** here',
    '__underline__ trick',
  ]) {
    const r = validateIdentityInterviewRequest({ answers: answerWith(md) });
    assert.equal(r.ok, false, `must reject markdown/code: ${md}`);
  }
});

test('FP3-C2.9 request validator: rejects empty / too-short / too-long answers', () => {
  const tooShort = validateIdentityInterviewRequest({
    answers: [...makeAnswers(3), { questionId: 'qX', question: 'q', answer: 'a' }],
  });
  assert.equal(tooShort.ok, false);
  const tooLong = validateIdentityInterviewRequest({
    answers: [
      ...makeAnswers(3),
      { questionId: 'qX', question: 'q', answer: 'ا'.repeat(IDENTITY_ANSWER_MAX + 1) },
    ],
  });
  assert.equal(tooLong.ok, false);
  const empty = validateIdentityInterviewRequest({
    answers: [...makeAnswers(3), { questionId: 'qX', question: 'q', answer: '   ' }],
  });
  assert.equal(empty.ok, false);
});

test('FP3-C2.10 request validator: rejects duplicate questionIds', () => {
  const dup = validateIdentityInterviewRequest({
    answers: [
      { questionId: 'q1', question: 'q', answer: 'إجابة كافية واحدة.' },
      { questionId: 'q1', question: 'q', answer: 'إجابة كافية اتنين.' },
      { questionId: 'q3', question: 'q', answer: 'إجابة كافية تلاتة.' },
    ],
  });
  assert.equal(dup.ok, false);
});

// ---------------------------------------------------------------------------
// 3. Output validator — happy path + rejections
// ---------------------------------------------------------------------------

function makeValidOutput(overrides = {}) {
  return {
    bio: 'فلان يدخل أرشيف Mafiozo بهدوء لافت. بيلاحظ التفصيلة قبل ما تتقال، وبيستنى الموجة الأولى تعدي قبل ما يتكلم. الأرشيف بيحفظ كل خطوة منه.',
    title: 'الظل الهادئ',
    tone: 'هدوء حذر بنبرة منخفضة',
    motto: 'الأرشيف ما بينساش، وأنا ما بسكتش طول الوقت.',
    playStyleSummary: 'بيلاحظ التناقضات الصغيرة قبل ما يقول حاجة. لما يتكلم بيحط نقطة، مش علامة سؤال.',
    ...overrides,
  };
}

test('FP3-C2.11 output validator: accepts a fully valid identity object', () => {
  const out = validateIdentityInterviewOutput(makeValidOutput());
  assert.ok(out, 'valid output must pass');
  for (const k of Object.keys(IDENTITY_FIELD_LIMITS)) {
    assert.ok(typeof out[k] === 'string' && out[k].length > 0);
  }
});

test('FP3-C2.12 output validator: accepts a JSON string (parsed via safeJsonParse)', () => {
  const raw = '```json\n' + JSON.stringify(makeValidOutput()) + '\n```';
  const out = validateIdentityInterviewOutput(raw);
  assert.ok(out, 'JSON-fenced output must parse and validate');
});

test('FP3-C2.13 output validator: rejects when any field is below min length', () => {
  for (const k of Object.keys(IDENTITY_FIELD_LIMITS)) {
    const bad = makeValidOutput({ [k]: 'x' });
    assert.equal(validateIdentityInterviewOutput(bad), null, `must reject short ${k}`);
  }
});

test('FP3-C2.14 output validator: rejects when any field exceeds max length', () => {
  for (const k of Object.keys(IDENTITY_FIELD_LIMITS)) {
    const limit = IDENTITY_FIELD_LIMITS[k].max;
    const bad = makeValidOutput({ [k]: 'ا'.repeat(limit + 5) });
    assert.equal(validateIdentityInterviewOutput(bad), null, `must reject long ${k}`);
  }
});

test('FP3-C2.15 output validator: rejects URLs / emails / phones / @mentions / #hashtags', () => {
  for (const evil of [
    'visit https://leak.example.com soon enough today.',
    'email me at evil@example.com later please now.',
    'call now +1-555-123-4567 quickly please.',
    '@ghost is on this case',
    '#mafiozo trending now',
  ]) {
    const bad = makeValidOutput({
      bio: 'فلان يدخل أرشيف Mafiozo بهدوء لافت. بيلاحظ التفصيلة قبل ما تتقال. ' + evil,
    });
    assert.equal(validateIdentityInterviewOutput(bad), null, `must reject: ${evil}`);
  }
});

test('FP3-C2.16 output validator: rejects markdown / code fences / JSON outer braces', () => {
  for (const evil of [
    '## heading',
    '```code\nleak\n```',
    '{ "leak": true } extra',
  ]) {
    const bad = makeValidOutput({ bio: evil + ' ' + 'ا'.repeat(120) });
    assert.equal(validateIdentityInterviewOutput(bad), null, `must reject: ${evil}`);
  }
});

test('FP3-C2.17 output validator: rejects forbidden tokens (gameRole, undefined, AI disclaimer)', () => {
  for (const evil of ['gameRole', 'roleAssignments', 'undefined', 'as an AI', 'كنموذج لغة']) {
    const bad = makeValidOutput({
      bio: 'فلان يدخل أرشيف Mafiozo بهدوء لافت. بيلاحظ التفصيلة قبل ما تتقال. ' + evil + ' في القصة.',
    });
    assert.equal(validateIdentityInterviewOutput(bad), null, `must reject token: ${evil}`);
  }
});

test('FP3-C2.18 output validator: rejects English-dominant output (Arabic <60%)', () => {
  const bad = makeValidOutput({
    bio: 'this is mostly english text describing a mafiozo player who likes to think before they speak. just a tiny bit of arabic عربي here.',
  });
  assert.equal(validateIdentityInterviewOutput(bad), null);
});

test('FP3-C2.19 output validator: rejects missing fields', () => {
  for (const k of Object.keys(IDENTITY_FIELD_LIMITS)) {
    const bad = makeValidOutput();
    delete bad[k];
    assert.equal(validateIdentityInterviewOutput(bad), null, `must reject missing ${k}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Deterministic fallback — always passes the output validator
// ---------------------------------------------------------------------------

test('FP3-C2.20 fallback builder produces all 5 fields and passes the output validator', () => {
  const id = buildFallbackIdentity({
    username: 'فلان',
    answers: makeAnswers(4),
  });
  for (const k of Object.keys(IDENTITY_FIELD_LIMITS)) {
    assert.ok(typeof id[k] === 'string' && id[k].length > 0,
      `fallback must produce ${k}`);
  }
  const validated = validateIdentityInterviewOutput(id);
  assert.ok(validated, 'fallback output must pass validateIdentityInterviewOutput');
});

test('FP3-C2.21 fallback builder is deterministic for the same input', () => {
  const a = buildFallbackIdentity({ username: 'X', answers: makeAnswers(3) });
  const b = buildFallbackIdentity({ username: 'X', answers: makeAnswers(3) });
  assert.deepEqual(a, b, 'same input → same output');
});

test('FP3-C2.22 fallback builder is resilient to empty/missing input', () => {
  for (const input of [undefined, null, {}, { answers: [] }, { username: '   ' }]) {
    const id = buildFallbackIdentity(input);
    assert.ok(validateIdentityInterviewOutput(id),
      `fallback must always be valid even for input=${JSON.stringify(input)}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Route wiring (static-source, no express runtime needed)
// ---------------------------------------------------------------------------

function readSource(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

test('FP3-C2.23 routes/profile.js mounts the identity interview behind authRequired → aiLimiter', () => {
  const text = readSource('routes/profile.js');
  // Match the route registration. The middleware order matters: authRequired
  // must fire BEFORE aiLimiter so a missing JWT returns 401 without burning
  // a rate-limit slot.
  const re = /router\.post\(\s*['"]\/identity\/interview['"]\s*,\s*authRequired\s*,\s*aiLimiter\s*,\s*async/;
  assert.match(text, re,
    'POST /identity/interview must be: authRequired → aiLimiter → handler');
});

test('FP3-C2.24 routes/profile.js calls validateIdentityInterviewRequest before invoking AI', () => {
  const text = readSource('routes/profile.js');
  // The handler must validate before calling ai.runIdentityInterview.
  const idx1 = text.indexOf('validateIdentityInterviewRequest');
  const idx2 = text.indexOf('ai.runIdentityInterview');
  assert.ok(idx1 > 0, 'validateIdentityInterviewRequest must be referenced');
  assert.ok(idx2 > 0, 'ai.runIdentityInterview must be referenced');
  assert.ok(idx1 < idx2, 'validation must come BEFORE the AI call');
});

test('FP3-C2.25 services/ai/index.js wires runIdentityInterview through Gemini → bio chain → fallback', () => {
  const text = readSource('services/ai/index.js');
  assert.match(text, /runIdentityInterview/);
  assert.match(text, /buildFallbackIdentity/);
  // The OpenRouter chain must use the 'bio' task selector (per the routing
  // doc). The task LABEL stays 'profile_identity' for analytics.
  assert.match(text, /getOpenRouterModelsForTask\(\s*['"]bio['"]\s*\)/);
});

// ---------------------------------------------------------------------------
// 6. Privacy regression — logAi for profile_identity stays metadata-only
// ---------------------------------------------------------------------------

test('FP3-C2.26 services/ai/index.js logAi calls do not leak prompt or response bodies', () => {
  const text = readSource('services/ai/index.js');
  const callRe = /logAi\(\{[\s\S]*?\}\)/g;
  const calls = text.match(callRe) || [];
  assert.ok(calls.length > 0);
  for (const c of calls) {
    for (const dangerous of [
      'prompt:', 'response:', 'rawResponse:', 'rawPrompt:',
      'output:', 'body:', 'content:', 'messages:', 'answers:',
    ]) {
      assert.equal(c.includes(dangerous), false,
        `logAi must not include "${dangerous}": ${c.slice(0, 200)}`);
    }
  }
});

test('FP3-C2.27 routes/profile.js does NOT persist the identity interview output anywhere', () => {
  const text = readSource('routes/profile.js');
  // Locate the /identity/interview handler block and confirm it does NOT
  // run an INSERT/UPDATE in that scope.
  const start = text.indexOf("router.post('/identity/interview'");
  assert.ok(start > 0);
  const end = text.indexOf('});', start);
  assert.ok(end > start);
  const handlerBody = text.slice(start, end);
  assert.equal(/INSERT INTO/i.test(handlerBody), false,
    'identity interview handler must not INSERT (no auto-persist)');
  assert.equal(/UPDATE\s+\w+\s+SET/i.test(handlerBody), false,
    'identity interview handler must not UPDATE (no auto-persist)');
});
