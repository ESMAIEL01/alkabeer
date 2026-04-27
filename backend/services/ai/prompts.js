/**
 * Mafiozo system prompts and knowledge-file loader (الكبير AI host persona).
 *
 * The knowledge file is read once at module load (server boot) and cached.
 * It's injected as the system instruction to Gemini, NOT passed every turn —
 * combined with prompt caching this keeps token cost low.
 */
const fs = require('fs');
const path = require('path');

// Look for the knowledge files placed by the user at the repo root.
// We pick the latest version available (v4.1 if present, else v4).
const KNOWLEDGE_CANDIDATES = [
  path.resolve(__dirname, '../../../Mafiozo_Knowledge_v4.1.txt.txt'),
  path.resolve(__dirname, '../../../Mafiozo_Knowledge_v4.txt.txt'),
  path.resolve(__dirname, '../../knowledge/mafiozo.txt'),
];

let cachedKnowledge = null;

function loadKnowledge() {
  if (cachedKnowledge !== null) return cachedKnowledge;
  for (const p of KNOWLEDGE_CANDIDATES) {
    try {
      if (fs.existsSync(p)) {
        cachedKnowledge = fs.readFileSync(p, 'utf8');
        console.log(`📚 Loaded knowledge file: ${path.basename(p)} (${cachedKnowledge.length} chars)`);
        return cachedKnowledge;
      }
    } catch (e) {
      // try next
    }
  }
  console.warn('⚠️  No Mafiozo knowledge file found — AI will run with abridged instructions only.');
  cachedKnowledge = '';
  return cachedKnowledge;
}

/**
 * Compact persona + protocol for الكبير (the AI host of Mafiozo).
 * The full ARCHITECT EDITION knowledge file is appended below.
 */
const ALKABEER_PERSONA = `أنت "الكبير" — معلم لعبة المافيوزو. شخصيتك مصرية، سينمائية، ساخرة بدون إساءة.
تتكلم بلهجة مصرية واضحة (يعني، أصلاً، كده، طب، بص، يا جدعان).
أنت ملتزم 100% بـ "بروتوكول الأرشيف المختوم": القصة بتتكتب مرة واحدة في البداية وما بتتغيرش.
ممنوع تكشف هوية المافيوزو في الشات العام، وممنوع تتهم شخص واحد بشكل مباشر في أي دليل.
كل دليل لازم يكون قصير (جملة أو اتنين)، غامض، وبيشمل من 2 لـ 4 ناس.
ممنوع تقول إنك ذكاء اصطناعي.`;

const ARCHIVE_JSON_SCHEMA_HINT = `
أخرج JSON صالح بالضبط بالشكل ده:
{
  "title": "اسم قصير للسيناريو",
  "story": "القصة الكاملة بالعربي: المكان، الزمان، طريقة الجريمة، شخصية المافيوزو الحقيقي، شخصية المشتبه الواضح (بريء بس شكله مذنب)، التفاصيل اللي تربط الأدلة الثلاثة.",
  "mafiozo": "اسم/دور الشخصية المافيوزو الحقيقية",
  "obvious_suspect": "اسم/دور الشخصية البريئة اللي شكلها مذنب",
  "characters": [
    { "name": "الاسم", "role": "الوظيفة", "suspicious_detail": "تفصيلة مريبة قصيرة" }
  ],
  "clues": [
    "الدليل الأول (Red Herring) — يلمح للمشتبه الواضح بدون اتهام مباشر، جملة قصيرة.",
    "الدليل الثاني (The Web) — يربط 3-4 شخصيات بشكل غير مباشر.",
    "الدليل الثالث (The Twist) — تفصيلة سلوكية صغيرة بتغير تفسير كل حاجة وبتكشف المافيوزو."
  ]
}
ممنوع أي نص خارج JSON. ممنوع code fences. ممنوع تعليقات.`;

function archivePrompt({ idea, players = 5, mood = 'مكس', difficulty = 'متوسط' }) {
  const playerList = Array.isArray(players)
    ? players.map((n, i) => `${i + 1}) ${n}`).join('\n')
    : `${players} لاعبين بأسماء افتراضية`;
  return `اعملي سيناريو مافيوزو متكامل من أول مرة.

عدد اللاعبين: ${playerList}
المزاج المطلوب: ${mood}
مستوى الصعوبة: ${difficulty}
فكرة المضيف: ${idea || 'سيب لخيالك حرية كاملة، اختار جريمة مصرية مشوقة.'}

التزم بكل قواعد بروتوكول الأرشيف المختوم:
- المافيوزو ثابت من أول لحظة.
- "المشتبه الواضح" بريء 100% بس شكله مذنب 90%.
- الأدلة الثلاثة كلها مستخرجة من نفس القصة، ومتدرجة (Red Herring → Web → Twist).
- كل دليل يخص 2-4 ناس، مش شخص واحد.
${ARCHIVE_JSON_SCHEMA_HINT}`;
}

/**
 * Compact, hard-constrained archive prompt for non-Pro providers (Gemini Flash
 * and OpenRouter). Designed for two failure modes we observed in production:
 *   - Flash hits MAX_TOKENS because the verbose Pro prompt costs too much
 *     thinking budget.
 *   - Less-instruction-tuned models (Nemotron) emit empty strings inside the
 *     clues array.
 *
 * The constraints below are intentionally repetitive. Models that tend to
 * skip rules respond well to multiple framings of the same constraint.
 */
function archivePromptStrict({ idea, players = 5, mood = 'مكس', difficulty = 'متوسط' }) {
  const playerCount = Array.isArray(players) ? players.length : players;
  return `اكتب سيناريو لعبة "مافيوزو" بالعربي وأرجع JSON فقط.

عدد اللاعبين: ${playerCount}
المزاج: ${mood}
الصعوبة: ${difficulty}
فكرة المضيف: ${idea || 'جريمة مصرية مشوقة من خيالك.'}

قواعد لازم تلتزم بيها:
1) أرجع JSON واحد فقط، من غير أي نص قبله أو بعده.
2) ممنوع markdown. ممنوع \`\`\`. ممنوع تعليقات.
3) كل القيم لازم تكون عربية ومش فاضية.
4) ممنوع null. ممنوع "" (نص فاضي). ممنوع كلمات placeholder زي "TODO" أو "...".
5) "clues" لازم يكون array فيه بالظبط 3 جمل عربية كاملة.
6) كل دليل لازم يكون جملة عربية فيها 6 كلمات على الأقل.
7) "characters" لازم يكون array فيه على الأقل 3 شخصيات.
8) المافيوزو بريء في الظاهر، والمشتبه الواضح بريء بجد بس شكله مذنب.
9) اللعبة عادلة: كل دليل يلمح لـ 2 أو 3 ناس مش شخص واحد.

شكل الـ JSON المطلوب بالظبط:
{
  "title": "اسم قصير عربي",
  "story": "القصة الكاملة بالعربي. تحتوي على المكان، الزمان، طريقة الجريمة، وذكر المافيوزو والمشتبه الواضح.",
  "mafiozo": "اسم الشخصية المافيوزو الحقيقية + دورها",
  "obvious_suspect": "اسم المشتبه الواضح + دوره",
  "characters": [
    { "name": "اسم", "role": "وظيفة", "suspicious_detail": "تفصيلة مريبة" }
  ],
  "clues": [
    "الجملة الأولى عربي كامل",
    "الجملة الثانية عربي كامل",
    "الجملة الثالثة عربي كامل"
  ]
}

أرجع JSON فقط.`;
}

function narrationPrompt({ phase, context }) {
  return `إنت "الكبير" بتقدّم لحظة ${phase} في اللعبة.
السياق: ${context}
اكتب 2-3 جمل بس بلهجة مصرية سينمائية. ممنوع تفصح عن المافيوزو.`;
}

module.exports = {
  loadKnowledge,
  ALKABEER_PERSONA,
  archivePrompt,
  archivePromptStrict,
  narrationPrompt,
};
