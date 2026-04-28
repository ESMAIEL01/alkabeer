/**
 * FixPack v3 / Premium archive — quality validator tests.
 *
 * Pinned guarantees:
 *   - validateArchiveQuality rejects the exact placeholder strings
 *     observed in production ("الجملة 1 على كاملة", etc).
 *   - It rejects username-like / silly character names (Guest, sssss,
 *     800000, names with underscores or parentheses).
 *   - It rejects clues that are too short, too long, or near-duplicates.
 *   - It rejects English-dominant fields.
 *   - It accepts a strong Arabic noir archive.
 *   - validateArchive(a, { enforceQuality: true }) routes through the
 *     quality gate end-to-end; default validateArchive(a) does NOT
 *     (existing tests preserved).
 *   - The strict prompt no longer contains the literal placeholder
 *     template ("الجملة 1 عربي كامل") that weak models were copying.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateArchive,
  validateArchiveQuality,
  ARCHIVE_QUALITY_LIMITS,
} = require('../services/ai/validators');

// ---------------------------------------------------------------------------
// Strong-content baseline
// ---------------------------------------------------------------------------

function strongArchive(overrides = {}) {
  return {
    title: 'الرسالة التي وصلت بعد الإغلاق',
    story:
      'في فندق قديم على طرف المدينة، اختفى دفتر الحجوزات بعد عشاء خاص جمع خمسة أشخاص. ' +
      'الكاميرات توقفت لدقيقتين فقط، والباب لم يُكسر، لكن كل شخص كان يملك سببًا صغيرًا ليخفي الحقيقة. ' +
      'موظف الاستقبال سمع رنين المفاتيح في الممر الخلفي، والسكرتيرة الجديدة كانت آخر من غادر المكتب، ' +
      'والمحاسب طلب نسخة من السجل قبل العشاء بربع ساعة بدون تفسير واضح، وكلهم اتفقوا أن لا أحد يعترف بشيء قبل الفجر.',
    mafiozo: 'كمال — المحاسب الذي طلب النسخة',
    obvious_suspect: 'محمود — موظف الاستقبال',
    characters: [
      { name: 'نادر الكيلاني', role: 'مدير استقبال أغلق الخزنة قبل العشاء', suspicious_detail: 'ادّعى أنه لم يلمس المفاتيح، رغم أن شاهدًا سمع رنينها معه في الممر الخلفي الساعة عشرة.' },
      { name: 'سارة الجمل',     role: 'سكرتيرة جديدة بدأت أمس فقط',         suspicious_detail: 'كانت آخر من غادر المكتب، وعطرها ظهر على ظرف الرسالة المفقودة في الصباح التالي.' },
      { name: 'كمال الحسيني',   role: 'محاسب الفندق المسؤول عن السجلات',     suspicious_detail: 'طلب نسخة من سجل الحجوزات قبل العشاء بربع ساعة، وأخفى الورقة في درج مكتبه السفلي.' },
      { name: 'فريد الجزار',    role: 'مدير الفندق الذي شارك في العشاء',     suspicious_detail: 'كان يتبادل النظرات مع المحاسب طوال السهرة، وغادر القاعة لدقيقتين بحجة مكالمة عاجلة.' },
    ],
    clues: [
      'توقيت الكاميرا توقف قبل الحادث بدقيقتين فقط، بينما ظل جهاز تسجيل الدخول يعمل داخل مكتب الاستقبال طوال الليل.',
      'أثر حبر أزرق ظهر على ظرف الرسالة المفقودة، وهو نفس الحبر المستخدم في سجل الحجوزات الصغير على المكتب الرئيسي.',
      'ثلاثة أشخاص كان معاهم نسخة من مفتاح الخزنة، لكن الوحيد اللي طلب السجل قبل الحادث كان جالسًا قريبًا من باب المكتب الجانبي.',
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Quality validator — rejects the exact production-bug strings
// ---------------------------------------------------------------------------

test('AQ.1 quality validator rejects the exact "الجملة N على كاملة" placeholder string', () => {
  const a = strongArchive({
    clues: [
      'الجملة 1 على كاملة عشان تبقى أطول من خمسين حرف عربي بالظبط ودا اللي حصل في الإنتاج',
      'الجملة 2 على كاملة عشان تبقى أطول من خمسين حرف عربي بالظبط ودا اللي حصل في الإنتاج',
      'الجملة 3 على كاملة عشان تبقى أطول من خمسين حرف عربي بالظبط ودا اللي حصل في الإنتاج',
    ],
  });
  const r = validateArchiveQuality(a);
  assert.match(r || '', /weak_clue|placeholder/, `must reject placeholder pattern, got: ${r}`);
});

test('AQ.2 quality validator rejects "الشخص N" / "المشتبه N" / "اللاعب N" character names', () => {
  for (const badName of ['الشخص 1', 'المشتبه 2', 'اللاعب 3', 'مافيوزو 1']) {
    const a = strongArchive({
      characters: [
        { name: badName, role: 'محقق رئيسي مسؤول عن القضية', suspicious_detail: 'كان يدخل ويخرج من الغرفة طوال السهرة بدون شرح واضح وحامل ملف رمادي.' },
        ...strongArchive().characters.slice(1),
      ],
    });
    const r = validateArchiveQuality(a);
    assert.match(r || '', /weak_character_name|placeholder/,
      `must reject character name "${badName}": ${r}`);
  }
});

test('AQ.3 quality validator rejects "الدليل N يقول" / "الدليل N على كاملة" weak clues', () => {
  for (const badClue of [
    'الدليل 1 يقول إن الجاني كان موجودًا في غرفة المكتب وقت الحادث على الأرجح بدون شك',
    'الدليل 2 على كاملة عشان تبقى جملة طويلة كفاية تعدي حد الطول الأدنى للأدلة',
  ]) {
    const a = strongArchive({
      clues: [
        badClue,
        strongArchive().clues[1],
        strongArchive().clues[2],
      ],
    });
    const r = validateArchiveQuality(a);
    assert.match(r || '', /weak_clue|placeholder/, `must reject weak clue: ${r}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Username-like / silly names
// ---------------------------------------------------------------------------

test('AQ.4 quality validator rejects username-like character names', () => {
  for (const badName of [
    'Guest',
    'sssssss',
    'looooooo',
    '800000',
    '3aaaaaaaa',
    'name_with_underscore',
    'كمال (Guest)',
    'Player1',
  ]) {
    const a = strongArchive({
      characters: [
        { name: badName, role: 'مدير استقبال أغلق الخزنة قبل العشاء', suspicious_detail: 'ادّعى أنه لم يلمس المفاتيح، رغم أن شاهدًا سمع رنينها معه في الممر الخلفي الساعة عشرة.' },
        ...strongArchive().characters.slice(1),
      ],
    });
    const r = validateArchiveQuality(a);
    assert.match(r || '', /username_like_name|weak_character_name/,
      `must reject username-like "${badName}": ${r}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Clue length / similarity
// ---------------------------------------------------------------------------

test('AQ.5 quality validator rejects clues shorter than CLUE_MIN', () => {
  const short = 'دليل قصير جدًا.';
  const a = strongArchive({
    clues: [short, strongArchive().clues[1], strongArchive().clues[2]],
  });
  const r = validateArchiveQuality(a);
  assert.match(r || '', /clue_too_short|weak_clue/, `got: ${r}`);
});

test('AQ.6 quality validator rejects near-duplicate clues', () => {
  const dup = 'توقيت الكاميرا توقف قبل الحادث بدقيقتين فقط، بينما ظل جهاز تسجيل الدخول يعمل داخل مكتب الاستقبال طوال الليل.';
  const a = strongArchive({
    clues: [dup, dup, dup],
  });
  const r = validateArchiveQuality(a);
  assert.match(r || '', /clues_too_similar|weak_clue/, `got: ${r}`);
});

// ---------------------------------------------------------------------------
// 4. Field length windows
// ---------------------------------------------------------------------------

test('AQ.7 quality validator rejects too-short title / story', () => {
  const shortTitle = strongArchive({ title: 'X' });
  assert.match(validateArchiveQuality(shortTitle) || '', /title_length/);
  const shortStory = strongArchive({ story: 'قصة قصيرة.' });
  assert.match(validateArchiveQuality(shortStory) || '', /story_length/);
});

test('AQ.8 quality validator rejects too-short suspicious_detail / role', () => {
  const a1 = strongArchive({
    characters: [
      { name: 'نادر الكيلاني', role: 'مدير', suspicious_detail: 'تفصيلة كافية الطول لتعدي العشرين حرفا الادنى' },
      ...strongArchive().characters.slice(1),
    ],
  });
  assert.match(validateArchiveQuality(a1) || '', /character_role_length|weak_character_role/);
  const a2 = strongArchive({
    characters: [
      { name: 'نادر الكيلاني', role: 'مدير استقبال أغلق الخزنة', suspicious_detail: 'قصير جدا' },
      ...strongArchive().characters.slice(1),
    ],
  });
  assert.match(validateArchiveQuality(a2) || '', /suspicious_detail_length|weak_suspicious_detail/);
});

// ---------------------------------------------------------------------------
// 5. Arabic dominance
// ---------------------------------------------------------------------------

test('AQ.9 quality validator rejects English-dominant story', () => {
  const a = strongArchive({
    story: 'this is a long noir story written almost entirely in english with just a tiny قطرة من العربية في النهاية بسيطة جدا فقط من اجل ان تظهر ولا تكون فعلا غالبة.',
  });
  assert.match(validateArchiveQuality(a) || '', /story_arabic_low|story_length/);
});

// ---------------------------------------------------------------------------
// 6. Strong content passes
// ---------------------------------------------------------------------------

test('AQ.10 quality validator accepts a strong Arabic noir archive', () => {
  assert.equal(validateArchiveQuality(strongArchive()), null,
    'strong archive must pass the quality gate');
});

test('AQ.11 validateArchive(a) default behavior — schema-only, no quality gate', () => {
  // The strong archive trivially passes both. To verify the default path
  // is schema-only, build an archive that PASSES schema but FAILS quality
  // (placeholder names) and confirm validateArchive() default returns null
  // while validateArchive(..., { enforceQuality: true }) returns a reason.
  const weak = strongArchive({
    characters: [
      { name: 'الشخص 1', role: 'وظيفة كافية الطول', suspicious_detail: 'تفصيلة قصيرة لكنها تجاوز ثلاثين حرف عربي بسهولة بسيطة جدًا.' },
      ...strongArchive().characters.slice(1),
    ],
  });
  assert.equal(validateArchive(weak), null,
    'default validateArchive must remain schema-only (legacy contract)');
  const reason = validateArchive(weak, { enforceQuality: true });
  assert.ok(reason, 'enforceQuality must surface a rejection reason');
  assert.match(reason, /weak_character_name|placeholder/);
});

test('AQ.12 strong archive passes validateArchive with enforceQuality=true', () => {
  assert.equal(validateArchive(strongArchive(), { enforceQuality: true }), null);
});

// ---------------------------------------------------------------------------
// 7. Static-source: strict prompt no longer carries the placeholder template
// ---------------------------------------------------------------------------

test('AQ.13 archivePromptStrict no longer emits the literal "الجملة N عربي كامل" template', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'prompts.js'),
    'utf8'
  );
  // The old template was constructed with backtick interpolation:
  //   `"الجملة ${i + 1} عربي كامل"`.
  // The new prompt no longer contains this exact pattern.
  assert.equal(/الجملة \$\{i \+ 1\} عربي كامل/.test(text), false,
    'old placeholder-shaped clue example must be removed from the strict prompt');
  assert.equal(/مافيوزو \$\{i \+ 1\}/.test(text), false,
    'old placeholder-shaped mafiozo example must be removed');
});

test('AQ.14 archivePromptStrict embeds a concrete noir example so the model has tone reference', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'prompts.js'),
    'utf8'
  );
  // The new prompt body is referenced via a labeled section the model
  // can lock onto. We pin a stable Arabic substring from the example.
  assert.match(text, /مثال على المستوى المطلوب/);
  assert.match(text, /الرسالة التي وصلت بعد الإغلاق/);
});

test('AQ.15 services/ai/index.js passes enforceQuality:true into validateArchive', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'services', 'ai', 'index.js'),
    'utf8'
  );
  assert.match(text, /enforceQuality:\s*true/);
});

// ---------------------------------------------------------------------------
// 8. ARCHIVE_QUALITY_LIMITS exposes the documented thresholds
// ---------------------------------------------------------------------------

test('AQ.16 ARCHIVE_QUALITY_LIMITS matches the documented thresholds', () => {
  assert.equal(ARCHIVE_QUALITY_LIMITS.TITLE_MIN, 8);
  assert.equal(ARCHIVE_QUALITY_LIMITS.TITLE_MAX, 70);
  assert.equal(ARCHIVE_QUALITY_LIMITS.STORY_MIN, 180);
  assert.equal(ARCHIVE_QUALITY_LIMITS.STORY_MAX, 900);
  assert.equal(ARCHIVE_QUALITY_LIMITS.CLUE_MIN, 50);
  assert.equal(ARCHIVE_QUALITY_LIMITS.CLUE_MAX, 260);
  assert.equal(ARCHIVE_QUALITY_LIMITS.DETAIL_MIN, 30);
  assert.equal(ARCHIVE_QUALITY_LIMITS.DETAIL_MAX, 220);
  assert.equal(ARCHIVE_QUALITY_LIMITS.ARABIC_RATIO_MIN, 0.8);
});
