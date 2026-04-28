/**
 * Hotfix — Arabic + sharia-safe profile bio / identity output.
 *
 * Pinned guarantees:
 *   1. containsForbiddenTerm correctly flags each documented category.
 *   2. validateBio rejects bios containing alcohol / drugs / gambling /
 *      sexual / satanic-occult / blasphemous / profanity tokens.
 *   3. validateBio rejects English-dominant text (Arabic-letter ratio
 *      tightened from 60% → 80%).
 *   4. validateBio still accepts clean Arabic noir bios.
 *   5. validateIdentityInterviewOutput rejects forbidden tokens in any
 *      of the 5 fields.
 *   6. validateIdentityInterviewOutput rejects English-dominant output.
 *   7. Deterministic buildFallbackBio + buildFallbackIdentity output
 *      always passes the tightened validators.
 *   8. Deterministic fallbacks use "مافيوزو" (Arabic) — not "Mafiozo".
 *   9. profileBioPrompt and identityInterviewPrompt include the shared
 *      sharia-safe rules string so the model sees the rules the
 *      validator enforces.
 *  10. logAi calls remain metadata-only (regression pin).
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  containsForbiddenTerm,
  SAFE_DENY_CATEGORIES,
  SAFE_PROMPT_RULES_AR,
} = require('../services/ai/safe-content');
const { validateBio, validateIdentityInterviewOutput, IDENTITY_FIELD_LIMITS } =
  require('../services/ai/validators');
const { buildFallbackBio } = require('../services/ai/bio-fallback');
const { buildFallbackIdentity } = require('../services/ai/identity-fallback');
const { profileBioPrompt, identityInterviewPrompt } =
  require('../services/ai/prompts');

// ---------------------------------------------------------------------------
// 1. containsForbiddenTerm — categorical hits
// ---------------------------------------------------------------------------

test('SS.1 containsForbiddenTerm flags alcohol terms (AR + EN)', () => {
  for (const t of ['شربت خمر امبارح', 'كان فيه نبيذ على الطاولة', 'drank some beer', 'a glass of wine']) {
    const r = containsForbiddenTerm(t);
    assert.equal(r.hit, true, `must flag: ${t}`);
    assert.equal(r.category, 'alcohol');
  }
});

test('SS.2 containsForbiddenTerm flags drugs', () => {
  for (const t of ['حشيش في الجيب', 'pure cocaine deal', 'بانجو', 'marijuana stash']) {
    const r = containsForbiddenTerm(t);
    assert.equal(r.hit, true);
    assert.equal(r.category, 'drugs');
  }
});

test('SS.3 containsForbiddenTerm flags gambling', () => {
  for (const t of ['طاولة قمار', 'big poker night', 'مراهنة كبيرة', 'casino royale']) {
    const r = containsForbiddenTerm(t);
    assert.equal(r.hit, true);
    assert.equal(r.category, 'gambling');
  }
});

test('SS.4 containsForbiddenTerm flags sexual content', () => {
  for (const t of ['مشهد جنسي', 'sexual scene', 'porn flick']) {
    const r = containsForbiddenTerm(t);
    assert.equal(r.hit, true);
    assert.equal(r.category, 'sexual');
  }
});

test('SS.5 containsForbiddenTerm flags satanic / occult phrases', () => {
  for (const t of ['عبادة الشيطان', 'satanic ritual', 'witchcraft and شعوذة', 'تعاويذ الظلام']) {
    const r = containsForbiddenTerm(t);
    assert.equal(r.hit, true);
    assert.equal(r.category, 'satanic_occult');
  }
});

test('SS.6 containsForbiddenTerm flags blasphemy / self-deification', () => {
  for (const t of ['أنا إله', 'I am god', 'قدري مقدس', 'أعبد الظلام']) {
    const r = containsForbiddenTerm(t);
    assert.equal(r.hit, true);
    assert.equal(r.category, 'blasphemy');
  }
});

test('SS.7 containsForbiddenTerm flags explicit English profanity', () => {
  for (const t of ['fuck this', 'a shit show', 'son of a bitch']) {
    const r = containsForbiddenTerm(t);
    assert.equal(r.hit, true);
    assert.equal(r.category, 'profanity');
  }
});

test('SS.8 containsForbiddenTerm does NOT flag legitimate noir vocabulary', () => {
  for (const t of [
    'يدخل القضية بهدوء',
    'الظل الهادئ يتقدم',
    'شخصية مريبة جداً',
    'غموض القصة كبير',
    'أرشيف مافيوزو',
    'محقق ذكي',
    'مشتبه واضح',
    'شاهد فضولي',
  ]) {
    const r = containsForbiddenTerm(t);
    assert.equal(r.hit, false, `must NOT flag legitimate noir: ${t}`);
  }
});

test('SS.9 SAFE_DENY_CATEGORIES has the expected category keys', () => {
  for (const k of ['alcohol', 'drugs', 'gambling', 'sexual',
                   'satanic_occult', 'blasphemy', 'profanity']) {
    assert.ok(SAFE_DENY_CATEGORIES[k], `missing category ${k}`);
    assert.ok(Array.isArray(SAFE_DENY_CATEGORIES[k]) && SAFE_DENY_CATEGORIES[k].length > 0);
  }
});

// ---------------------------------------------------------------------------
// 2. validateBio — sharia-safe + Arabic-dominant tightened to 80%
// ---------------------------------------------------------------------------

const CLEAN_BIO = 'فلان يدخل أرشيف مافيوزو بهدوء لافت. بيلاحظ التفصيلة قبل ما تتقال، وبيستنى الموجة الأولى تعدي قبل ما يتكلم. الأرشيف بيحفظ كل خطوة منه.';

test('SS.10 validateBio accepts a clean Arabic noir bio', () => {
  const out = validateBio(CLEAN_BIO);
  assert.ok(out, `clean bio must pass: ${out}`);
});

test('SS.11 validateBio rejects bios containing alcohol terms', () => {
  for (const evil of ['شرب خمر بعد الجريمة', 'a glass of wine before the case']) {
    const bad = `${CLEAN_BIO} ${evil}`;
    assert.equal(validateBio(bad), null, `must reject: ${evil}`);
  }
});

test('SS.12 validateBio rejects drugs / gambling / sexual / occult / blasphemy', () => {
  for (const evil of [
    'كان معاه حشيش',
    'تابع طاولة قمار',
    'مشهد جنسي مفصل',
    'عبادة الشيطان',
    'أنا إله القضية',
    'تعاويذ سوداء',
  ]) {
    const bad = `${CLEAN_BIO} ${evil}`;
    assert.equal(validateBio(bad), null, `must reject: ${evil}`);
  }
});

test('SS.13 validateBio rejects English-dominant text (≥80% Arabic threshold)', () => {
  // ~30% Arabic letters — was acceptable at 60% threshold, now rejected.
  const englishHeavy = 'this is mostly english noir prose describing the character with just a tiny قطرة عربية في النهاية بسيطة جداً.';
  assert.equal(validateBio(englishHeavy), null,
    'English-dominant bio must fail the new 80% threshold');
});

test('SS.14 validateBio still accepts a bio with the brand name "مافيوزو"', () => {
  const out = validateBio(CLEAN_BIO);
  assert.ok(out);
  assert.ok(out.includes('مافيوزو'));
});

// ---------------------------------------------------------------------------
// 3. validateIdentityInterviewOutput — same denylist applied per field
// ---------------------------------------------------------------------------

function makeCleanIdentity(overrides = {}) {
  return {
    bio: CLEAN_BIO,
    title: 'الظل الهادئ',
    tone: 'هدوء حذر بنبرة منخفضة',
    motto: 'الأرشيف ما بينساش، وأنا ما باخدش الصمت كإجابة.',
    playStyleSummary: 'بيلاحظ التناقضات الصغيرة قبل ما يقول حاجة. لما يتكلم بيحط نقطة، مش علامة سؤال.',
    ...overrides,
  };
}

test('SS.15 validateIdentityInterviewOutput accepts a clean noir identity', () => {
  const out = validateIdentityInterviewOutput(makeCleanIdentity());
  assert.ok(out, 'clean identity must pass');
});

test('SS.16 validateIdentityInterviewOutput rejects forbidden term in ANY field', () => {
  for (const field of ['bio', 'title', 'tone', 'motto', 'playStyleSummary']) {
    const limits = IDENTITY_FIELD_LIMITS[field];
    // Build a clean-length string for that field that contains the
    // forbidden term. Add a long clean prefix so length window is satisfied.
    const padding = 'ا'.repeat(Math.max(0, limits.min - 20));
    const tainted = makeCleanIdentity({ [field]: padding + ' عبادة الشيطان' });
    assert.equal(validateIdentityInterviewOutput(tainted), null,
      `forbidden token in ${field} must be rejected`);
  }
});

test('SS.17 validateIdentityInterviewOutput rejects English-dominant output (≥80%)', () => {
  const englishHeavy = makeCleanIdentity({
    bio: 'this is mostly english noir prose describing the character with just a tiny قطرة عربية في النهاية بسيطة جداً.',
  });
  assert.equal(validateIdentityInterviewOutput(englishHeavy), null);
});

// ---------------------------------------------------------------------------
// 4. Deterministic fallbacks pass the tightened validators
// ---------------------------------------------------------------------------

test('SS.18 buildFallbackBio output passes validateBio (no forbidden terms, ≥80% Arabic)', () => {
  for (const username of ['فلان', 'لاعب جديد', 'Ahmed', 'X']) {
    const out = buildFallbackBio({ username });
    const validated = validateBio(out);
    assert.ok(validated, `fallback bio must pass validator for username=${username}: ${out}`);
  }
});

test('SS.19 buildFallbackBio uses "مافيوزو" (Arabic) — not "Mafiozo"', () => {
  const out = buildFallbackBio({ username: 'فلان' });
  assert.ok(out.includes('مافيوزو'),
    `fallback bio must use "مافيوزو" (Arabic): ${out}`);
  assert.equal(out.includes('Mafiozo'), false,
    'fallback bio must NOT contain "Mafiozo" (latin)');
});

test('SS.20 buildFallbackBio ignores potentially-tainted rawIdea', () => {
  // A hostile rawIdea must not appear verbatim in the output.
  for (const tainted of ['عبادة الشيطان والظلام', 'fuck mafiozo', 'حشيش في الجيب']) {
    const out = buildFallbackBio({ username: 'فلان', rawIdea: tainted });
    for (const cat of Object.keys(SAFE_DENY_CATEGORIES)) {
      for (const tok of SAFE_DENY_CATEGORIES[cat]) {
        assert.equal(out.toLowerCase().includes(tok.toLowerCase()), false,
          `fallback bio must not echo forbidden token "${tok}" from rawIdea`);
      }
    }
  }
});

test('SS.21 buildFallbackIdentity output passes validateIdentityInterviewOutput', () => {
  for (const input of [
    { username: 'فلان', answers: [{ question: 'q', answer: 'إجابة كافية واحدة' }] },
    { username: 'Ahmed' },
    {},
    null,
  ]) {
    const id = buildFallbackIdentity(input);
    const validated = validateIdentityInterviewOutput(id);
    assert.ok(validated, `fallback identity must pass validator for input=${JSON.stringify(input)}`);
  }
});

test('SS.22 buildFallbackIdentity bio uses "مافيوزو" — not "Mafiozo"', () => {
  const id = buildFallbackIdentity({ username: 'فلان' });
  assert.ok(id.bio.includes('مافيوزو'),
    `fallback identity bio must use "مافيوزو": ${id.bio}`);
  assert.equal(id.bio.includes('Mafiozo'), false,
    'fallback identity bio must NOT contain "Mafiozo" (latin)');
});

// ---------------------------------------------------------------------------
// 5. Prompt rules
// ---------------------------------------------------------------------------

test('SS.23 SAFE_PROMPT_RULES_AR contains the documented Arabic rule lines', () => {
  const joined = SAFE_PROMPT_RULES_AR.join('\n');
  assert.match(joined, /عربي فقط/);
  assert.match(joined, /80%/);
  assert.match(joined, /الشيطان|إبليس/);
  assert.match(joined, /الخمور|المخدرات|القمار/);
  assert.match(joined, /إيحاء جنسي/);
  assert.match(joined, /شتائم|نابية/);
});

test('SS.24 profileBioPrompt embeds the SAFE_PROMPT_RULES_AR rules', () => {
  const out = profileBioPrompt({ rawIdea: 'مثال', username: 'فلان' });
  for (const rule of SAFE_PROMPT_RULES_AR) {
    assert.ok(out.includes(rule), `prompt must include: ${rule}`);
  }
  // The product name must be referenced as "مافيوزو" (Arabic).
  assert.match(out, /مافيوزو/);
});

test('SS.25 identityInterviewPrompt embeds the SAFE_PROMPT_RULES_AR rules', () => {
  const out = identityInterviewPrompt({
    answers: [{ question: 'بتحب تلعب بهدوء؟', answer: 'نعم بهدوء' }],
    username: 'فلان',
  });
  for (const rule of SAFE_PROMPT_RULES_AR) {
    assert.ok(out.includes(rule), `prompt must include: ${rule}`);
  }
  assert.match(out, /مافيوزو/);
});

// ---------------------------------------------------------------------------
// 6. Privacy regression — logAi metadata-only contract
// ---------------------------------------------------------------------------

test('SS.26 services/ai/index.js logAi calls remain metadata-only', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'index.js'),
    'utf8'
  );
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

test('SS.27 safe-content.js has zero matches for the standard secret-leak patterns', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'safe-content.js'),
    'utf8'
  );
  for (const dangerous of ['JWT_SECRET', 'DATABASE_URL', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY',
                            'password_hash', 'archive_b64', 'roleAssignments', 'gameRole',
                            'rawPrompt', 'rawResponse']) {
    assert.equal(text.includes(dangerous), false,
      `safe-content.js must not mention ${dangerous}`);
  }
});
