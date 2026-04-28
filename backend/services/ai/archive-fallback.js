/**
 * Premium deterministic fallback archive (FixPack v3 / Commit 2).
 *
 * Pure helper — no env, no DB, no provider clients. Lives in its own
 * file so unit tests can import it without dragging in dotenv via
 * config/env.js (mirrors bio-fallback.js / identity-fallback.js).
 *
 * The output ALWAYS satisfies validateArchiveQuality from validators.js:
 *   - title       8..70 chars
 *   - story       180..900 chars
 *   - role        8..80 chars
 *   - detail      30..220 chars
 *   - clue        50..260 chars
 *   - Arabic      ≥80% letter ratio
 *   - no placeholder strings
 *   - no username-like names
 *   - no near-duplicate clues
 *
 * Pools are intentionally large enough that custom games up to 8/5/3
 * (the documented maximum) produce unique character names and unique
 * clues within a single archive.
 */

const TITLE_POOL = Object.freeze([
  'الرسالة التي وصلت بعد الإغلاق',
  'آخر من غادر القاعة الذهبية',
  'سرقة دفتر الحجوزات الصامت',
  'الظل الذي مرّ في الممر الخلفي',
  'لوحة الفناء التي اختفت قبل الفجر',
  'خمس دقائق بين الإقفال والفتح',
  'صفحة ممزقة من سجل الفندق',
  'مكالمة لم يردّ عليها أحد',
  'ساعة الحائط التي توقفت فجأة',
  'مفتاح الخزانة المفقود في الورشة',
  'سرقة لوحة المتحف القديم',
  'الورقة التي خبأها المحاسب',
]);

const LOCATION_POOL = Object.freeze([
  'فندق قديم على طرف المدينة',
  'متحف صغير في وسط البلد',
  'ورشة كاتب تجريبي في حي قديم',
  'مكتب محاماة في الطابق الخامس',
  'قصر أحد الأعيان في الحي الراقي',
  'مكتبة عامة بعد ساعات الإغلاق',
  'عيادة طبية في عمارة هادئة',
  'قاعة أفراح في فندق متوسط',
  'شركة شحن صغيرة قرب الميناء',
  'مطعم على الكورنيش',
  'مكتب صحيفة محلية ليلًا',
  'صالون فني خاص',
]);

const NAME_POOL = Object.freeze([
  'نادر الكيلاني', 'سارة الجمل',     'كمال الحسيني',  'فريد الجزار',
  'ريم سيف الدين', 'هادي الزرعوني',  'منى الشاذلي',   'محسن العطار',
  'ليلى المرعشي',  'باسل الخطيب',   'هبة فايق',     'علاء حنفي',
  'نورا البدوي',   'طارق غنام',     'وفاء عاشور',    'أحمد ياقوت',
]);

const ROLE_POOL = Object.freeze([
  'مدير استقبال أغلق الخزنة قبل العشاء',
  'سكرتيرة جديدة بدأت أمس فقط',
  'محاسب الفندق المسؤول عن السجلات',
  'مدير الفندق الذي شارك في العشاء',
  'حارس ليلي يعمل منذ خمس سنوات',
  'عاملة نظافة تنهي ورديتها قبل منتصف الليل',
  'سائق خاص ينتظر في موقف السيارات',
  'مصور يلتقط الحدث الخاص للفندق',
  'ضيف مدعو من خارج المدينة',
  'كاتب عمود يجمع مادة عن المكان',
  'طباخ المساء في المطبخ الرئيسي',
  'ساقي قاعة الاستقبال الجديدة',
  'مهندس صيانة الكاميرات',
  'أمين المكتبة بعد ساعات الدوام',
  'مدير العلاقات العامة الإقليمي',
  'منسق الحفل المسؤول عن قائمة الضيوف',
]);

const SUSPICIOUS_DETAIL_POOL = Object.freeze([
  'ادّعى أنه لم يلمس المفاتيح، رغم أن شاهدًا سمع رنينها معه في الممر الخلفي قرب الساعة العاشرة.',
  'كان آخر من غادر المكتب، وعطر معطفه بقي على ظرف الرسالة المفقودة في الصباح التالي.',
  'طلب نسخة من السجل قبل الحادث بربع ساعة، وأخفى الورقة في درج مكتبه السفلي قبل الإقفال.',
  'تبادل النظرات مع أحد الضيوف طوال السهرة، وغادر القاعة لدقيقتين بحجة مكالمة عاجلة.',
  'وقّع على دخوله مرتين في نفس الورقة، وقال إنه نسي. كاميرا الباب لم تسجّل الدخول الثاني.',
  'أعاد ترتيب الكراسي في القاعة قبل الصباح، رغم أن الترتيب لم يكن جزءًا من واجباته الليلية.',
  'ادّعى أنه نائم منذ منتصف الليل، لكن جاره أكّد أن النور بقي مضاءً حتى الفجر في غرفته.',
  'حمل في يده دفترًا أزرق صغيرًا حين دخل، وخرج بدونه. لم يجد المحققون الدفتر في غرفته بعد ذلك.',
  'كان يضحك بصوت عالٍ على بُعد متر من الخزنة، ثم اختفى صوته فجأة لعشر دقائق كاملة قبل الإقفال.',
  'استدعى نفس الموظفين ثلاث مرات قبل الإقفال، وكلٌّ منهم قال إن السبب لم يكن واضحًا أبدًا.',
  'غيّر مكان قلمه الأحمر مرتين في الليلة، وأصرّ أنه لم يكتب شيئًا منذ المساء حتى الصباح.',
  'كان شعره مبللًا بعد العشاء، رغم أنه أكّد لشاهد آخر أنه لم يدخل الحمام مطلقًا في تلك الليلة.',
  'حمل غلاف ظرف فارغ في جيبه، وعندما سُئل قال إنه يحتفظ به للذكرى فقط ولا شيء آخر.',
  'ادّعى أنه كان يقرأ كتابًا في غرفته، لكن الكتاب وُجد في صالة الاستقبال السفلية بعد الفجر.',
  'وضع كأسه فارغة على طاولة بعيدة عن مكان جلوسه قبل الحادث بدقائق قليلة من غير سبب واضح.',
  'كان يضع نظارة سوداء داخل القاعة المضاءة، وأزالها فقط بعد أن غادر شخصان آخران معًا.',
]);

const CLUE_POOL = Object.freeze([
  'توقيت الكاميرا توقف قبل الحادث بدقيقتين فقط، بينما ظل جهاز تسجيل الدخول يعمل داخل مكتب الاستقبال طوال الليل.',
  'أثر حبر أزرق ظهر على ظرف الرسالة المفقودة، وهو نفس الحبر المستخدم في سجل الحجوزات الصغير على المكتب الرئيسي.',
  'ثلاثة أشخاص فقط يحملون نسخة من مفتاح الخزنة، لكن الوحيد الذي طلب السجل قبل الحادث جلس قريبًا من باب المكتب الجانبي.',
  'باب الطوارئ كان موصدًا من الداخل بمفتاح غريب، ولا توجد كاميرا تسجل من فتحه أو من أعاد إغلاقه قبل الفجر.',
  'ساعة الحائط في الردهة توقفت عند الواحدة وأربع وأربعين، وهو نفس الوقت الذي اختفى فيه دفتر الحجوزات من المكتب.',
  'أحد الموظفين بدّل بطاقة دخوله مرتين في نفس الليلة، والبطاقة المسجَّلة الثانية لا تنتمي لأي اسم في قائمة العاملين.',
  'بقعة قهوة جافة على ورقة سجل الزيارات تطابق في زاويتها كأس قهوة فارغة وُجدت في غرفة بعيدة عن مكتب الاستقبال.',
  'صوت خطوات بطيئة سُمع في الممر الخلفي قبل الحادث بدقيقة، رغم أن جميع الضيوف كانوا قد جلسوا في القاعة الرئيسية وقتها.',
  'ورقة ممزقة من دفتر صغير وُجدت في سلة المهملات، وعليها بقايا توقيع ناقص يبدأ بنفس الحرف الذي يبدأ به اسم أحد الموظفين.',
  'أحد المصابيح في الردهة كان لا يزال دافئًا بعد منتصف الليل بساعة، رغم أن آخر شخص قال إنه أطفأ الإضاءة قبل العشاء بنصف ساعة.',
]);

/** Tiny deterministic hash → integer offset. */
function _seedHash(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Build a deterministic premium fallback archive.
 *
 * Supports:
 *   players      3..8
 *   clueCount    1..5
 *   mafiozoCount 1..floor((players-1)/2)
 *
 * Default-shape calls (4/3/1) keep the legacy wire layout (singular
 * `mafiozo` string field) so old frontends don't break.
 */
function buildFallbackArchive(input) {
  const i = input || {};
  const playerCount  = Number.isFinite(i.players)
    ? i.players
    : (Number.isFinite(i.playerCount) ? i.playerCount : 4);
  const clueCount    = Number.isFinite(i.clueCount) ? i.clueCount : 3;
  const mafiozoCount = Number.isFinite(i.mafiozoCount) ? i.mafiozoCount : 1;
  const idea         = typeof i.idea === 'string' ? i.idea : '';

  const seed = _seedHash(`${idea}|${playerCount}|${clueCount}|${mafiozoCount}`);

  const title    = TITLE_POOL[seed % TITLE_POOL.length];
  const location = LOCATION_POOL[(seed + 3) % LOCATION_POOL.length];

  const characters = [];
  for (let k = 0; k < playerCount; k++) {
    characters.push({
      name:              NAME_POOL[(seed + k) % NAME_POOL.length],
      role:              ROLE_POOL[(seed + k * 3) % ROLE_POOL.length],
      suspicious_detail: SUSPICIOUS_DETAIL_POOL[(seed + k * 5) % SUSPICIOUS_DETAIL_POOL.length],
    });
  }

  // Stride 7 over 10 clues yields a permutation (gcd(7,10)=1) so any
  // contiguous slice up to 5 entries is unique.
  const clues = [];
  for (let k = 0; k < clueCount; k++) {
    clues.push(CLUE_POOL[(seed + k * 7) % CLUE_POOL.length]);
  }

  const mafiozosArr = characters.slice(0, mafiozoCount).map(ch => ({
    name: ch.name,
    role: ch.role,
    suspicious_detail: ch.suspicious_detail,
  }));

  const obviousSuspectChar = characters[Math.min(mafiozoCount, characters.length - 1)] || characters[0];
  const obviousSuspectLabel = `${obviousSuspectChar.name} — ${obviousSuspectChar.role}`;

  const story = `في ${location} وقع الحادث بعد منتصف الليل بقليل، حين اجتمع ${playerCount} أشخاص حول مناسبة خاصة. ` +
    `الكاميرات لم تسجل سوى دقائق ناقصة، والباب الرئيسي ظل موصدًا، لكن السجل الصغير على المكتب اختفى قبل الفجر بنصف ساعة. ` +
    `كل واحد منهم يملك سببًا لإخفاء جزء صغير من الحقيقة، و${obviousSuspectLabel} يبدو الأقرب للشبهة بسبب موقعه قبل الحادث، ` +
    `لكن التفاصيل الصغيرة تشير إلى أن الفاعل الحقيقي كان أهدأ من أن يلفت النظر. ` +
    `الأرشيف يحتفظ الآن بكل التوقيتات والشهادات، وعلى المحققين أن يربطوا الخيوط قبل أن يهرب الظل من القاعة.`;

  const out = {
    title,
    story,
    obvious_suspect: obviousSuspectLabel,
    characters,
    clues,
  };
  if (mafiozoCount === 1) {
    out.mafiozo = `${mafiozosArr[0].name} — ${mafiozosArr[0].role}`;
  } else {
    out.mafiozos = mafiozosArr;
    out.mafiozo = `${mafiozosArr[0].name} — ${mafiozosArr[0].role}`;
  }
  return out;
}

module.exports = {
  buildFallbackArchive,
  TITLE_POOL,
  LOCATION_POOL,
  NAME_POOL,
  ROLE_POOL,
  SUSPICIOUS_DETAIL_POOL,
  CLUE_POOL,
};
