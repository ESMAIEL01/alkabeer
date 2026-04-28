/**
 * FixPack v3 / Commit 4 — final reveal quality safeguards.
 *
 * Pinned guarantees:
 *   - validateFinalRevealPolish enforces per-field MIN length (was
 *     max-only), so empty/one-word polish is rejected.
 *   - Arabic-letter ratio tightened from 60% → 80%.
 *   - Premium-archive placeholder patterns ("الجملة 1", etc.) rejected
 *     in any polish field.
 *   - Sharia-safe denylist applied per field.
 *   - Generic template phrases ("حدث شيء", "الحقيقة انكشفت") rejected.
 *   - Hidden-token leaks ("undefined", "gameRole", "كذكاء اصطناعي")
 *     still rejected (regression pin from existing contract).
 *   - All-fields-failing returns null (deterministic reveal stands).
 *   - Strong polish JSON is accepted and trimmed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateFinalRevealPolish,
  FINAL_REVEAL_FIELD_LIMITS,
  FINAL_REVEAL_GENERIC_PHRASES,
} = require('../services/ai/validators');

// ---------------------------------------------------------------------------
// Strong baseline polish
// ---------------------------------------------------------------------------

const STRONG_POLISH = {
  heroSubtitle: 'الأرشيف فُتح أخيرًا، والظل خرج من الممر الخلفي بهدوء.',
  caseClosingLine: 'القضية أُغلقت على ورقة بحبر أزرق وذكاء صبور لم يخطئ ولو لمرة واحدة طوال الليلة.',
  finalParagraph: 'حين توقفت الكاميرا لدقيقتين، وحين توقفت ساعة الردهة عند الواحدة وأربع وأربعين، كانت الإجابة تنتظر صبر المحققين قبل أن تقول نفسها بنفسها. الأدلة لم تتهم أحدًا مباشرة، لكنها رتبت الوقائع بحيث لا يبقى سوى احتمال واحد عند الفجر.',
  epilogue: 'الأرشيف يحتفظ الآن بكل التوقيتات والشهادات، والمحققون يعرفون أن قضية أخرى ستُفتح في الليلة القادمة، بصبر مماثل ودقة جديدة لا تخطئ.',
};

// ---------------------------------------------------------------------------
// 1. Length windows
// ---------------------------------------------------------------------------

test('FR.1 strong polish JSON is accepted and returns all 4 fields', () => {
  const out = validateFinalRevealPolish(STRONG_POLISH);
  assert.ok(out, 'strong polish must be accepted');
  for (const k of Object.keys(FINAL_REVEAL_FIELD_LIMITS)) {
    assert.ok(out[k], `field ${k} must survive`);
  }
});

test('FR.2 polish JSON parsed from a JSON string passes', () => {
  const out = validateFinalRevealPolish(JSON.stringify(STRONG_POLISH));
  assert.ok(out);
});

test('FR.3 below MIN length per field is rejected', () => {
  for (const k of Object.keys(FINAL_REVEAL_FIELD_LIMITS)) {
    const tooShort = { ...STRONG_POLISH, [k]: 'قصير' };
    const out = validateFinalRevealPolish(tooShort);
    // The other fields still pass; the too-short field must be DROPPED.
    assert.ok(out, 'other fields should still survive');
    assert.equal(out[k], undefined,
      `field ${k} must be dropped when below MIN: ${out[k]}`);
  }
});

test('FR.4 above MAX length per field is rejected', () => {
  for (const k of Object.keys(FINAL_REVEAL_FIELD_LIMITS)) {
    const tooLong = { ...STRONG_POLISH, [k]: 'ا'.repeat(FINAL_REVEAL_FIELD_LIMITS[k].max + 5) };
    const out = validateFinalRevealPolish(tooLong);
    assert.equal(out && out[k], undefined,
      `field ${k} must be dropped when above MAX`);
  }
});

// ---------------------------------------------------------------------------
// 2. Premium-archive placeholder leakage
// ---------------------------------------------------------------------------

test('FR.5 placeholder patterns ("الجملة 1", "الشخص 1") rejected per field', () => {
  for (const k of Object.keys(FINAL_REVEAL_FIELD_LIMITS)) {
    const tainted = { ...STRONG_POLISH, [k]: 'الجملة 1 على كاملة عشان النوار يبدو طويل ومتسق ولا يبتر في النص.' };
    const out = validateFinalRevealPolish(tainted);
    assert.equal(out && out[k], undefined,
      `placeholder must reject ${k}`);
  }
});

test('FR.6 username-shape "الشخص N" rejected per field', () => {
  const tainted = { ...STRONG_POLISH, finalParagraph: 'الشخص 1 كان قريبًا من الباب الجانبي طوال السهرة، وكل التوقيتات تنتهي عند نقطة واحدة في الردهة.' };
  const out = validateFinalRevealPolish(tainted);
  assert.equal(out && out.finalParagraph, undefined,
    'finalParagraph with "الشخص N" must be dropped');
});

// ---------------------------------------------------------------------------
// 3. Hidden-token / AI-disclaimer leaks (regression)
// ---------------------------------------------------------------------------

test('FR.7 "undefined" / "gameRole" / "roleAssignments" rejected per field', () => {
  for (const tok of ['undefined', 'gameRole', 'roleAssignments']) {
    const tainted = { ...STRONG_POLISH, heroSubtitle: `الأرشيف ${tok} والظل خرج بهدوء من الممر.` };
    const out = validateFinalRevealPolish(tainted);
    assert.equal(out && out.heroSubtitle, undefined,
      `forbidden token "${tok}" must be dropped`);
  }
});

test('FR.8 AI disclaimers ("as an AI", "كذكاء اصطناعي") rejected', () => {
  for (const tok of ['as an AI', 'كذكاء اصطناعي', 'كنموذج لغة']) {
    const tainted = { ...STRONG_POLISH, finalParagraph: `النص هنا ${tok} والباقي يدخل في تفاصيل ضرورية لا تختصر.` };
    const out = validateFinalRevealPolish(tainted);
    assert.equal(out && out.finalParagraph, undefined,
      `disclaimer "${tok}" must be dropped`);
  }
});

// ---------------------------------------------------------------------------
// 4. Generic phrases
// ---------------------------------------------------------------------------

test('FR.9 generic template phrases rejected per field', () => {
  for (const phrase of FINAL_REVEAL_GENERIC_PHRASES) {
    const tainted = { ...STRONG_POLISH, caseClosingLine: `${phrase} في الردهة قبل الفجر بدقائق قليلة.` };
    const out = validateFinalRevealPolish(tainted);
    assert.equal(out && out.caseClosingLine, undefined,
      `generic phrase "${phrase}" must be dropped`);
  }
});

// ---------------------------------------------------------------------------
// 5. Sharia-safe denylist
// ---------------------------------------------------------------------------

test('FR.10 sharia-safe denylist applied per field (alcohol / occult / blasphemy)', () => {
  for (const evil of [
    'شرب خمر بعد العشاء',
    'عبادة الشيطان في الردهة',
    'أنا إله القضية',
    'تعاويذ سوداء على المكتب',
  ]) {
    const tainted = { ...STRONG_POLISH, finalParagraph: `الأرشيف فُتح أخيرًا، و${evil} في تلك الليلة الطويلة، ثم خرج الجميع بهدوء.` };
    const out = validateFinalRevealPolish(tainted);
    assert.equal(out && out.finalParagraph, undefined,
      `sharia-safe denylist must reject: ${evil}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Arabic ≥80% threshold
// ---------------------------------------------------------------------------

test('FR.11 English-dominant polish rejected (≥80% Arabic threshold)', () => {
  const tainted = {
    ...STRONG_POLISH,
    finalParagraph: 'this is mostly english noir prose describing the final reveal, with a tiny قطرة عربية في النهاية بسيطة جدًا فقط من اجل ان تظهر ولا تكون الغالبة.',
  };
  const out = validateFinalRevealPolish(tainted);
  assert.equal(out && out.finalParagraph, undefined);
});

// ---------------------------------------------------------------------------
// 7. All-fields-failing → null (deterministic reveal stands)
// ---------------------------------------------------------------------------

test('FR.12 if every field fails, validator returns null', () => {
  const out = validateFinalRevealPolish({
    heroSubtitle: 'gameRole',
    caseClosingLine: 'الجملة 1 على كاملة',
    finalParagraph: 'حدث شيء غامض',
    epilogue: 'تعاويذ سوداء',
  });
  assert.equal(out, null,
    'when all fields fail, the validator must return null so the deterministic reveal stays');
});

// ---------------------------------------------------------------------------
// 8. Backwards compat — non-string / non-object input
// ---------------------------------------------------------------------------

test('FR.13 non-string / non-object input is rejected gracefully', () => {
  for (const bad of [null, undefined, 42, true, [], 'not json']) {
    const out = validateFinalRevealPolish(bad);
    assert.equal(out, null);
  }
});

// ---------------------------------------------------------------------------
// 9. Field-mix — one valid, one invalid → return only valid
// ---------------------------------------------------------------------------

test('FR.14 mixed-validity input keeps only the valid fields', () => {
  const mixed = {
    heroSubtitle: STRONG_POLISH.heroSubtitle,                        // VALID
    caseClosingLine: 'this is too english to pass the eighty percent floor and most of it is latin letters with little arabic عربي.',  // INVALID
    finalParagraph: STRONG_POLISH.finalParagraph,                    // VALID
    epilogue: 'undefined leaked here unfortunately enough chars',    // INVALID
  };
  const out = validateFinalRevealPolish(mixed);
  assert.ok(out);
  assert.ok(out.heroSubtitle, 'valid heroSubtitle survives');
  assert.ok(out.finalParagraph, 'valid finalParagraph survives');
  assert.equal(out.caseClosingLine, undefined);
  assert.equal(out.epilogue, undefined);
});
