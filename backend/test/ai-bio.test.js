/**
 * D5 — AI bio validator + request-helper tests.
 *
 * Imports from validators + profile-helpers only — no real AI, no DB,
 * no JWT, no express. The actual writeProfileBio AI surface is exercised
 * in CI / integration manually post-deploy.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateBio, BIO_MIN_LEN, BIO_MAX_LEN } = require('../services/ai/validators');
const { validateBioAiRequest, BIO_AI_RAW_MIN, BIO_AI_RAW_MAX } = require('../routes/profile-helpers');

// ---------------------------------------------------------------------------
// validateBio — content rules
// ---------------------------------------------------------------------------

const VALID_BIO =
  'محقق هاوي بحب القهوة السادة وسجائر القرنفل. يدخل أرشيف Mafiozo بصمت ويسمع أكتر مما يتكلم. ' +
  'لما الضوء يعتم، عينه بتشوف اللي الناس بتفوته.';

test('1. validateBio accepts a clean Arabic noir bio', () => {
  const out = validateBio(VALID_BIO);
  assert.equal(typeof out, 'string');
  assert.ok(out.length >= BIO_MIN_LEN);
  assert.ok(out.length <= BIO_MAX_LEN);
});

test('2. validateBio rejects URLs (https/http/www)', () => {
  assert.equal(validateBio(`${VALID_BIO} https://example.com`), null);
  assert.equal(validateBio(`${VALID_BIO} www.example.com`),     null);
  assert.equal(validateBio(`${VALID_BIO} http://x.local`),      null);
});

test('3. validateBio rejects emails and phone numbers', () => {
  assert.equal(validateBio(`${VALID_BIO} ابعتلي على me@example.com`),  null);
  assert.equal(validateBio(`${VALID_BIO} اتصل بي 01234567890`),         null);
  assert.equal(validateBio(`${VALID_BIO} +201234567890`),               null);
  // Arabic-Indic digits also rejected.
  assert.equal(validateBio(`${VALID_BIO} ٠١٢٣٤٥٦٧٨٩٠`),                 null);
});

test('4. validateBio rejects markdown headings, bold, hashtags', () => {
  assert.equal(validateBio('## ' + VALID_BIO),               null);
  assert.equal(validateBio('**' + VALID_BIO + '**'),         null);
  assert.equal(validateBio(`${VALID_BIO} #tag`),             null);
  assert.equal(validateBio(`${VALID_BIO} @mention`),         null);
  assert.equal(validateBio('```\n' + VALID_BIO + '\n```'),   null);
});

test('5. validateBio rejects "undefined" and hidden-token leaks', () => {
  assert.equal(validateBio(`${VALID_BIO} undefined`),       null);
  assert.equal(validateBio(`${VALID_BIO} gameRole`),         null);
  assert.equal(validateBio(`${VALID_BIO} roleAssignments`),  null);
});

test('6. validateBio rejects English-dominant text', () => {
  // Build an English bio long enough to satisfy length, dominated by Latin letters.
  const englishBio =
    'A quiet hunter who watches the smoke before the bullet. ' +
    'He listens to the silence between words and trusts only the second clue. ' +
    'When the night thins, his shadow stays a beat longer than the rest.';
  assert.equal(validateBio(englishBio), null);
});

test('7. validateBio rejects AI disclaimers (English + Arabic)', () => {
  assert.equal(validateBio(`${VALID_BIO} as an AI`),         null);
  assert.equal(validateBio(`${VALID_BIO} كذكاء اصطناعي`),    null);
});

test('8. validateBio rejects too-short and too-long', () => {
  assert.equal(validateBio('قصير جداً'), null);                // < 80
  assert.equal(validateBio('ا'.repeat(BIO_MAX_LEN + 1)), null); // > 500
});

test('9. validateBio rejects JSON braces', () => {
  assert.equal(validateBio('{ "bio": "' + VALID_BIO + '" }'), null);
  assert.equal(validateBio('[' + VALID_BIO + ']'),            null);
});

// ---------------------------------------------------------------------------
// validateBioAiRequest — request-side helper
// ---------------------------------------------------------------------------

test('10. validateBioAiRequest accepts valid rawIdea', () => {
  const r = validateBioAiRequest({ rawIdea: 'محقق هاوي بحب الورق وقهوة سادة' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized.rawIdea, 'محقق هاوي بحب الورق وقهوة سادة');
});

test('11. validateBioAiRequest rejects too-short rawIdea', () => {
  const r = validateBioAiRequest({ rawIdea: 'short' });   // < 10
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});

test('12. validateBioAiRequest rejects too-long rawIdea', () => {
  const r = validateBioAiRequest({ rawIdea: 'ا'.repeat(BIO_AI_RAW_MAX + 1) });
  assert.equal(r.ok, false);
});

test('13. validateBioAiRequest rejects URLs in rawIdea', () => {
  const r = validateBioAiRequest({ rawIdea: 'محقق هاوي https://example.com' });
  assert.equal(r.ok, false);
});

test('14. validateBioAiRequest rejects <script> in rawIdea', () => {
  const r = validateBioAiRequest({ rawIdea: 'محقق <script>alert(1)</script> صامت' });
  assert.equal(r.ok, false);
});

test('15. validateBioAiRequest rejects non-string / null / undefined', () => {
  assert.equal(validateBioAiRequest({}).ok, false);
  assert.equal(validateBioAiRequest({ rawIdea: 42 }).ok, false);
  assert.equal(validateBioAiRequest({ rawIdea: null }).ok, false);
  assert.equal(validateBioAiRequest(null).ok, false);
  assert.equal(validateBioAiRequest(undefined).ok, false);
});

// ---------------------------------------------------------------------------
// Fallback bio shape — written from buildFallbackBio in services/ai/index.js.
// We import it via the test-only export.
// ---------------------------------------------------------------------------

test('16. fallback bio stays within BIO_MAX_LEN and contains identity tokens', () => {
  // The fallback builder lives in services/ai/bio-fallback.js so it can be
  // imported without dragging in dotenv / database / provider clients.
  const { buildFallbackBio } = require('../services/ai/bio-fallback');
  const out = buildFallbackBio({
    username: 'investigator',
    rawIdea: 'ا'.repeat(500),  // very long input — should clip + fit
  });
  assert.ok(typeof out === 'string');
  assert.ok(out.length <= BIO_MAX_LEN, `fallback length ${out.length} > ${BIO_MAX_LEN}`);
  assert.ok(out.includes('investigator'));
  assert.ok(out.includes('Mafiozo'));
});

test('17. fallback bio handles missing username/rawIdea defensively', () => {
  const { buildFallbackBio } = require('../services/ai/bio-fallback');
  const a = buildFallbackBio({});
  const b = buildFallbackBio(undefined);
  const c = buildFallbackBio({ username: '', rawIdea: '' });
  for (const out of [a, b, c]) {
    assert.ok(typeof out === 'string' && out.length > 0);
    assert.ok(out.includes('Mafiozo'));
    assert.ok(out.length <= BIO_MAX_LEN);
  }
});
