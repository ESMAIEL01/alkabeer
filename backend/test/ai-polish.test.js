/**
 * C2 / C3 — AI polish validator tests.
 *
 * Exercises validatePolishLine and validateFinalRevealPolish without any
 * real AI, network, or DB. The GameManager wiring is integration-tested
 * implicitly: existing voting/privacy/lobby tests still pass, which proves
 * the deterministic vote_result / final_reveal payloads are unchanged.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePolishLine,
  validateFinalRevealPolish,
} = require('../services/ai/validators');

// ---------------------------------------------------------------------------
// validatePolishLine
// ---------------------------------------------------------------------------

const VALID_LINE = 'الجولة دي خلصت والظلام لسه ماشي. الكبير شايف خيوط مش باينة.';

test('1. validatePolishLine rejects "undefined" substring', () => {
  assert.equal(validatePolishLine('الجولة undefined خلصت بدون حسم. الكبير لسه شايف.'), null);
});

test('2. validatePolishLine rejects "gameRole" leak', () => {
  assert.equal(validatePolishLine('الجولة خلصت. gameRole كشف الحقيقة فجأة.'), null);
});

test('3. validatePolishLine rejects "roleAssignments" leak', () => {
  assert.equal(validatePolishLine('الجولة خلصت. roleAssignments بقت واضحة.'), null);
});

test('4. validatePolishLine rejects forbidden Mafiozo name (mid-game)', () => {
  // The forbidden name is what the caller would pass for an alive Mafiozo
  // mid-game so the AI cannot expose them.
  const out = validatePolishLine('الجولة دي كشفت أن كمال هو اللي كان وراها.', { forbiddenTerms: ['كمال'] });
  assert.equal(out, null);
});

test('5. validatePolishLine rejects markdown headings and bold', () => {
  assert.equal(validatePolishLine('## الجولة خلصت\nوالنتيجة واضحة دلوقتي.'), null);
  assert.equal(validatePolishLine('**الجولة خلصت** والكبير لسه شايف الخيوط.'), null);
});

test('6. validatePolishLine rejects JSON fragments and code fences', () => {
  assert.equal(validatePolishLine('{ "line": "الجولة خلصت" }'), null);
  assert.equal(validatePolishLine('[ "الجولة خلصت" ]'), null);
  assert.equal(validatePolishLine('```\nالجولة خلصت بدون حسم.\n```'), null);
});

test('7. validatePolishLine rejects AI disclaimers', () => {
  assert.equal(validatePolishLine('as an AI، الجولة خلصت بدون حسم في النوبة دي.'), null);
  assert.equal(validatePolishLine('كذكاء اصطناعي ما اقدرش اقول الحقيقة.'), null);
});

test('8. validatePolishLine accepts a clean Arabic noir line', () => {
  const out = validatePolishLine(VALID_LINE);
  assert.equal(typeof out, 'string');
  assert.ok(out.length >= 8 && out.length <= 600);
});

test('9. validatePolishLine clamps long output (rejects beyond NARRATION_MAX_LEN)', () => {
  const tooLong = 'الجولة دي خلصت. '.repeat(200); // > 600 chars
  assert.equal(validatePolishLine(tooLong), null);
});

// ---------------------------------------------------------------------------
// validateFinalRevealPolish
// ---------------------------------------------------------------------------

// FixPack v3 / Commit 4 — bumped fixture lengths to satisfy the new
// per-field MIN floors (heroSubtitle 12, caseClosingLine 16,
// finalParagraph 60, epilogue 40).
const VALID_POLISH_JSON = JSON.stringify({
  heroSubtitle: 'الستارة سقطت — والقضية اتقفلت بعد ليلة طويلة من الشكوك.',
  caseClosingLine: 'الأرشيف اتختم. الحقيقة باقية والظل بقي ذاكرة في كل الزوايا.',
  finalParagraph: 'في القاعة الباردة، كل دليل كان بيوصل لإجابة واحدة. الكبير صبر لحد ما الخيوط اتجمعت في نقطة واحدة عند الفجر، ثم بدأت القصة تكتب نفسها بنفسها.',
  epilogue: 'وفي السكون، الرواية تنامت لخاتمتها بهدوء، والأرشيف صار يحفظ تفاصيلها لكل الليالي القادمة.',
});

test('10. validateFinalRevealPolish parses valid JSON and keeps optional fields', () => {
  const out = validateFinalRevealPolish(VALID_POLISH_JSON);
  assert.ok(out, 'should accept clean polish JSON');
  assert.ok(typeof out.heroSubtitle === 'string');
  assert.ok(typeof out.caseClosingLine === 'string');
  assert.ok(typeof out.finalParagraph === 'string');
  assert.ok(typeof out.epilogue === 'string');
});

test('11. validateFinalRevealPolish rejects malformed JSON', () => {
  assert.equal(validateFinalRevealPolish('not json'), null);
  assert.equal(validateFinalRevealPolish('{bad: json}'), null);
  assert.equal(validateFinalRevealPolish(''), null);
  assert.equal(validateFinalRevealPolish(null), null);
});

test('12. validateFinalRevealPolish drops oversized fields silently', () => {
  const tooLong = 'ا'.repeat(1500);
  const out = validateFinalRevealPolish(JSON.stringify({
    heroSubtitle: tooLong,                           // > 240 chars → dropped
    caseClosingLine: 'سطر ختام قصير ومعقول.',           // valid
  }));
  assert.ok(out);
  assert.equal('heroSubtitle' in out, false, 'oversized hero subtitle should be dropped');
  assert.equal(out.caseClosingLine, 'سطر ختام قصير ومعقول.');
});

test('13. validateFinalRevealPolish rejects markdown / code fences in any field', () => {
  // FixPack v3 / Commit 4 — per-field MIN length added. Bumped the
  // surviving epilogue past the new 40-char floor.
  const cleanEpilogue = 'خاتمة عربية فيها معنى وملمح سينمائي يختم القضية بهدوء وثقة.';
  const out = validateFinalRevealPolish(JSON.stringify({
    heroSubtitle: '## عنوان كبير ممنوع',
    caseClosingLine: '```\nblock\n```',
    finalParagraph: '**bold not allowed** خاتمة عربية.',
    epilogue: cleanEpilogue,
  }));
  // None of the markdown-tainted fields should pass; only epilogue survives.
  assert.ok(out);
  assert.equal('heroSubtitle' in out, false);
  assert.equal('caseClosingLine' in out, false);
  assert.equal('finalParagraph' in out, false);
  assert.equal(out.epilogue, cleanEpilogue);
});

test('14. validateFinalRevealPolish rejects fields with AI disclaimers and hidden tokens', () => {
  // FixPack v3 / Commit 4 — finalParagraph MIN bumped to 60.
  const cleanParagraph = 'فقرة عربية نظيفة تمامًا ومن غير أي خرق للقواعد، تختم القضية بأسلوب نوار سينمائي رصين ومتسق.';
  const out = validateFinalRevealPolish(JSON.stringify({
    heroSubtitle: 'as an AI، الستارة سقطت اخيراً.',
    caseClosingLine: 'roleAssignments بقت واضحة دلوقتي.',
    epilogue: 'gameRole بقي ظاهر.',
    finalParagraph: cleanParagraph,
  }));
  assert.ok(out);
  assert.equal('heroSubtitle' in out, false);
  assert.equal('caseClosingLine' in out, false);
  assert.equal('epilogue' in out, false);
  assert.equal(out.finalParagraph, cleanParagraph);
});

test('15. validateFinalRevealPolish returns null when no field survives', () => {
  const out = validateFinalRevealPolish(JSON.stringify({
    heroSubtitle: '## bad',
    caseClosingLine: 'gameRole leak',
    finalParagraph: 'as an AI نص.',
    epilogue: 'undefined leak',
  }));
  assert.equal(out, null, 'all-rejected polish should return null, not {}');
});

test('16. validateFinalRevealPolish rejects English-dominant fields', () => {
  // FixPack v3 / Commit 4 — finalParagraph MIN bumped from 0 → 60. The
  // Arabic paragraph below is now 110+ chars so it sits above the new
  // floor, while the English heroSubtitle stays English-dominant.
  const out = validateFinalRevealPolish(JSON.stringify({
    heroSubtitle: 'The curtain fell on the case tonight.',
    finalParagraph: 'فقرة عربية نظيفة تمامًا ومن غير أي خرق للقواعد، تتدفق بهدوء وتختم القضية بأسلوب نوار سينمائي مكتمل ومتسق دون مفاجآت.',
  }));
  assert.ok(out);
  assert.equal('heroSubtitle' in out, false, 'English-dominant subtitle dropped');
  assert.ok(out.finalParagraph);
});
