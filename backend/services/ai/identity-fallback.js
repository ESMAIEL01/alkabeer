/**
 * Deterministic Mafiozo-noir identity-interview output used when every AI
 * provider fails. Pure helper — no env, no DB, no provider chain. Always
 * returns a fully-populated 5-field object that passes
 * validateIdentityInterviewOutput.
 *
 * The builder is intentionally seedless: the same answers always produce
 * the same output, so an admin re-running the chain with the same input
 * sees the same fallback. Any creativity is the AI's job; this layer is
 * the safety net.
 */

const TITLE_POOL = [
  'الظل الهادئ',
  'صاحب التفصيلة',
  'الراوي الصامت',
  'محقق العتمة',
  'الحارس البارد',
  'الشاهد الفضولي',
];

const TONE_POOL = [
  'هدوء حذر بنبرة منخفضة',
  'حضور قاطع بثقة هادية',
  'سخرية لطيفة قبل العاصفة',
  'صرامة هادئة بصوت واطي',
];

const MOTTO_POOL = [
  'الأرشيف ما بينساش، وأنا ما باخدش الصمت كإجابة.',
  'كل تفصيلة صغيرة هي بداية اعتراف كبير.',
  'بسمع أكتر مما باتكلم — والسكوت بيكشف نفسه.',
  'الحقيقة بتحب الناس اللي بيستنوها.',
];

const PLAYSTYLE_POOL = [
  'بيلاحظ التناقضات الصغيرة قبل ما يقول أي حاجة. لما يتكلم بيحط نقطة، مش علامة سؤال.',
  'بيستنى الموجة الأولى تعدي عشان يكشف اللي عايم فوقها. التصويت عنده آخر خطوة، مش أول رد فعل.',
  'بيرسم الخريطة في دماغه قبل ما يحرك أي بيدق. كل سؤال له هدف، وكل إجابة عنده ميزان.',
];

// Tiny cyclic hash that turns the answers into a deterministic index.
// Not security-relevant; only used to choose a pool entry consistently.
function indexHash(seed, modulus) {
  let h = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  if (modulus <= 0) return 0;
  return Math.abs(h) % modulus;
}

function pickPool(pool, seed) {
  if (!Array.isArray(pool) || pool.length === 0) return '';
  return pool[indexHash(seed, pool.length)];
}

/**
 * Build the deterministic fallback identity object.
 *
 * @param {object} input
 * @param {Array<{question:string, answer:string}>} [input.answers]
 * @param {string} [input.username]
 * @returns {{ bio:string, title:string, tone:string, motto:string,
 *           playStyleSummary:string }}
 */
function buildFallbackIdentity(input) {
  const i = input || {};
  const username = (typeof i.username === 'string' && i.username.trim())
    ? i.username.trim().slice(0, 60)
    : 'لاعب';
  const answers = Array.isArray(i.answers) ? i.answers : [];

  // Build a short safe summary string from the first 3 answers — used as
  // the deterministic seed AND as raw material for the bio body.
  const safeAnswers = answers
    .map(a => (a && typeof a.answer === 'string') ? a.answer.trim().slice(0, 140) : '')
    .filter(s => s.length > 0)
    .slice(0, 6);
  const seed = `${username}|${safeAnswers.join('|')}`;

  const title = pickPool(TITLE_POOL, seed) || TITLE_POOL[0];
  const tone = pickPool(TONE_POOL, seed + '|tone') || TONE_POOL[0];
  const motto = pickPool(MOTTO_POOL, seed + '|motto') || MOTTO_POOL[0];
  const playStyleSummary = pickPool(PLAYSTYLE_POOL, seed + '|style') || PLAYSTYLE_POOL[0];

  // Compose a 2-3 sentence bio that always sits in the 80..500 char window.
  const detailHint = safeAnswers[3] || safeAnswers[1] || safeAnswers[0] || 'بيراقب وبيستنى التفصيلة الغلط.';
  const composedBio =
    `${username} يدخل أرشيف Mafiozo بأسلوب ${title}. `
  + `${motto} `
  + `${detailHint}`;
  const bio = clampToWindow(composedBio, 80, 500);

  return {
    bio,
    title:            clampToWindow(title, 4, 60),
    tone:             clampToWindow(tone, 4, 80),
    motto:            clampToWindow(motto, 8, 120),
    playStyleSummary: clampToWindow(playStyleSummary, 30, 260),
  };
}

/**
 * Clamp a string into [min, max]. If too short, pad with a generic noir
 * tail. If too long, trim at the previous word boundary and append "…".
 */
function clampToWindow(s, min, max) {
  let str = (typeof s === 'string') ? s : '';
  if (str.length > max) {
    str = str.slice(0, max - 1).replace(/\s+\S*$/, '');
    str += '…';
  }
  if (str.length < min) {
    const tail = ' الأرشيف بيحفظ كل تفصيلة، وكل تفصيلة بتروح لمكانها.';
    str = (str + tail).slice(0, max);
  }
  return str;
}

module.exports = { buildFallbackIdentity };
