/**
 * Public AI surface used by the route layer.
 *
 * Provider chain for archive generation:
 *   1. Gemini  (primary)     — config.gemini.archiveModel          (e.g. gemini-2.5-pro)
 *   2. Gemini  (internal fb) — config.gemini.archiveFallbackModel  (e.g. gemini-2.5-flash)
 *   3. OpenRouter (external) — config.openrouter.enabled
 *   4. Built-in scenario     — always available
 *
 * Provider chain for narration:
 *   1. Gemini Flash (primary) — config.gemini.narrationModel
 *   2. OpenRouter             — config.openrouter.enabled
 *   3. Built-in static line
 *
 * Public functions:
 *   generateSealedArchive(input) → { source, model?, archive, note? }
 *   narrate({ phase, context })  → { source, model?, line }
 *
 * Both are guaranteed not to throw.
 */
const config = require('../../config/env');
const { callGemini } = require('./geminiClient');
const { callOpenRouter, isConfigured: openrouterConfigured } = require('./openrouterClient');
const {
  archivePrompt, archivePromptStrict, narrationPrompt,
  voteResultPolishPrompt, clueTransitionPolishPrompt, finalRevealPolishPrompt,
  profileBioPrompt,
  identityInterviewPrompt,
} = require('./prompts');
const {
  safeJsonParse, validateArchive, validateNarration,
  validatePolishLine, validateFinalRevealPolish,
  validateBio,
  validateIdentityInterviewOutput,
} = require('./validators');
const { buildFallbackBio } = require('./bio-fallback');
const { buildFallbackIdentity } = require('./identity-fallback');
const { logAiGeneration, logEvent } = require('../analytics');

// ---------------------------------------------------------------------------
// Telemetry helpers — tiny, internal, fire-and-forget.
// ---------------------------------------------------------------------------

/**
 * Map a thrown provider error to a short, secret-free classification.
 * The original err.message may contain provider response bodies — never
 * forward it to the analytics row directly.
 */
function classifyProviderError(err) {
  const m = err && err.message ? String(err.message).toLowerCase() : '';
  if (m.includes('timeout') || m.includes('aborted')) return 'timeout';
  if (m.includes('429') || m.includes('quota') || m.includes('rate limit')
      || m.includes('401') || m.includes('403') || m.includes('unauthorized')
      || m.includes('forbidden')) return 'quota_or_auth_error';
  if (m.includes('json') || m.includes('parse') || m.includes('unexpected token')) return 'malformed_json';
  return 'provider_error';
}

// ---------------------------------------------------------------------------
// FixPack v3 / Commit 5 — per-task AI latency caps.
//
// Tight per-task timeouts so a slow provider never blocks gameplay. Each
// task carries a PER-MODEL timeout (single attempt) plus a TOTAL CHAIN
// CAP that limits the total time spent walking a multi-model chain.
//
// Rationale by task:
//   archive               — host blocks on this, so 30s per attempt;
//                          chain cap not enforced (walking 4 models on
//                          a stuck quota path can need 60–90s, and the
//                          deterministic fallback always lands).
//   final_reveal_polish   — fire-and-forget polish of the cinematic
//                          screen; 10s per model, 20s chain cap.
//   profile_identity      — user clicked a button; 10s per model, 20s
//                          chain cap. Deterministic fallback if exceeded.
//   profile_bio           — same.
//   clue_transition       — must NOT block phase transition; 7s per
//                          model, 12s chain cap.
//   vote_result           — same.
//   narration             — short prose on phase boundaries; 8s per
//                          model, 14s chain cap.
//
// Values live here (NOT in env) because shipping a deploy that
// accidentally raises a chain cap to "5 minutes" would be a worse
// foot-gun than a hard-coded constant. The exact numbers are documented
// for ops and also re-exported as _AI_TIMEOUTS for test pinning.
// ---------------------------------------------------------------------------
const AI_TIMEOUTS = Object.freeze({
  archive:                 { perModelMs: 30_000, totalCapMs: null },     // null = no aggregate cap
  final_reveal_polish:     { perModelMs: 10_000, totalCapMs: 20_000 },
  profile_identity:        { perModelMs: 10_000, totalCapMs: 20_000 },
  profile_bio:             { perModelMs: 10_000, totalCapMs: 20_000 },
  clue_transition_polish:  { perModelMs:  7_000, totalCapMs: 12_000 },
  vote_result_polish:      { perModelMs:  7_000, totalCapMs: 12_000 },
  narration:               { perModelMs:  8_000, totalCapMs: 14_000 },
});

/**
 * Resolve the timeout config for a given task LABEL. Unknown task labels
 * fall back to the narration profile (a safe medium default).
 */
function getTaskTimeout(task) {
  if (typeof task === 'string' && Object.prototype.hasOwnProperty.call(AI_TIMEOUTS, task)) {
    return AI_TIMEOUTS[task];
  }
  return AI_TIMEOUTS.narration;
}

/**
 * Fire-and-forget wrapper. The default logger never rejects, but the .catch
 * is defensive against future changes.
 *
 * Also mirrors a minimal 'ai.call' event into analytics_events (F1) so the
 * admin dashboard's events browser can correlate AI usage with sessions
 * without joining ai_generation_logs separately. The mirrored payload is a
 * strict subset of what's already in ai_generation_logs — no prompts, no
 * responses, no archive bodies.
 */
function logAi(args) {
  try {
    const p = logAiGeneration(args);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* swallow */ }
  try {
    const a = args || {};
    const ev = logEvent({
      eventType: 'ai.call',
      userId: Number.isFinite(a.userId) ? a.userId : null,
      gameId: a.gameId || null,
      payload: {
        task: typeof a.task === 'string' ? a.task : 'unknown',
        source: typeof a.source === 'string' ? a.source : 'unknown',
        model: typeof a.model === 'string' ? a.model : null,
        ok: !!a.ok,
        latencyMs: Number.isFinite(a.latencyMs) ? Math.max(0, Math.trunc(a.latencyMs)) : null,
        validatorReason: typeof a.validatorReason === 'string' ? a.validatorReason : null,
      },
    });
    if (ev && typeof ev.catch === 'function') ev.catch(() => {});
  } catch { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Built-in fallback content. The game must always be playable, even when
// every external provider is down.
// ---------------------------------------------------------------------------

const FALLBACK_ARCHIVE = {
  title: 'سرقة قصر البارون',
  story:
    'الجريمة حصلت في قصر البارون ميدو الساعة 2 الصبح. الضحية مدير البنك "أنور". المافيوزو الحقيقي هو المحاسب "كمال" — هادي وذكي ومحدش حاسس بيه. المشتبه الواضح هو الحارس "محمود" لأنه كان قريب من الخزنة في وقت الجريمة. كل الأدلة مصممة عشان تلبّس محمود لحد ما الدليل الثالث يكشف كمال.',
  mafiozo: 'كمال (المحاسب)',
  obvious_suspect: 'محمود (الحارس)',
  characters: [
    { name: 'محمود', role: 'الحارس', suspicious_detail: 'اتصرف على إنه ساهر طول الليل بس مفيش حد شافه عند البوابة.' },
    { name: 'سارة', role: 'السكرتيرة', suspicious_detail: 'لقت الجثة أول واحدة وكانت لابسة معطف غريب.' },
    { name: 'كمال', role: 'المحاسب', suspicious_detail: 'طلب تقرير عاجل قبل الجريمة بنص ساعة.' },
    { name: 'فريد', role: 'المدير', suspicious_detail: 'كان متخانق مع الضحية إمبارح قدام الكل.' },
  ],
  clues: [
    'كاميرا الباب الخلفي سجلت حد لابس بالطو غامق الساعة 1:30 — والحارس محمود كان لابس بالطو زيه.',
    '٣ ناس بس كان معاهم مفتاح الخزنة: المحاسب كمال، المدير فريد، الحارس محمود... وواحد منهم كان صاحي الساعة 2.',
    'كمال طلب "كوباية مية كبيرة" على مكتبه الساعة 9:05 — الكوباية ظهرت فاضية والحوض مبلول. شكله بيغسل حاجة من إيديه.',
  ],
};

const FALLBACK_NOTE_AR = 'الكبير اشتغل بقصة احتياطية دلوقتي. خدمة الذكاء مش متاحة للحظات.';
const FALLBACK_NARRATION = '...الكبير ساكت دلوقتي';

// E4: deterministic per-config padding pool. Used when a custom config
// requires more characters / clues than the static FALLBACK_ARCHIVE
// provides. All entries are short, Arabic-script, no placeholders.
const CHARACTER_PAD_POOL = [
  { name: 'سلمى', role: 'الجارة', suspicious_detail: 'كانت بتسأل عن وقت الجريمة قبل ما حد يسأل.' },
  { name: 'إبراهيم', role: 'سايس العمارة', suspicious_detail: 'دفتر التسجيل بتاعه فيه ساعتين ناقصين.' },
  { name: 'نادر', role: 'الساعي', suspicious_detail: 'وصّل خطاب على غير العادة في وقت متأخر.' },
  { name: 'ليلى', role: 'الطباخة', suspicious_detail: 'لقت كوباية كاسرة في المطبخ ما شافهاش حد بيستعملها.' },
  { name: 'أحمد', role: 'الكاتب', suspicious_detail: 'دفتر يومياته صفحة الليلة كاملة ممسوحة.' },
];
const CLUE_PAD_POOL = [
  'الباب الجانبي اتقفل من جوة، بس مفتاحه كان معاه واحد وبس في القصر.',
  'فيه ساعة محسوب فيها صوت خطوات بطيئة بس مفيش كاميرا شافت حد.',
  'ورقة صغيرة كُتب عليها رقم غريب اتلقت قدام مكتب الضحية.',
  'ريحة دخان قهوة كانت متواجدة في غرفة قال صاحبها إنه ما خَطاش الناحية دي.',
  'لمبة المكتب كانت لسه دفية، ومفيش حد قال إنه كان فيه ساعتها.',
];

/**
 * E4: build a config-aware fallback archive. Default config returns the
 * static FALLBACK_ARCHIVE bit-for-bit. Custom configs deterministically
 * pad (or trim) characters + clues + mafiozos to match exact counts.
 * The output is guaranteed to pass validateArchive(opts).
 */
function buildFallbackArchive(input) {
  const i = input || {};
  const playerCount  = Number.isFinite(i.players) ? i.players : (Number.isFinite(i.playerCount) ? i.playerCount : 4);
  const clueCount    = Number.isFinite(i.clueCount) ? i.clueCount : 3;
  const mafiozoCount = Number.isFinite(i.mafiozoCount) ? i.mafiozoCount : 1;

  // Default-shaped request: return the static archive untouched. This
  // preserves the pre-E4 wire shape (singular `mafiozo` string, 3 clues,
  // 4 chars) for any caller still using default-mode generation.
  if (clueCount === 3 && mafiozoCount === 1 && playerCount === 4) {
    return FALLBACK_ARCHIVE;
  }

  // Build a custom-mode archive from the static seed + deterministic pads.
  const baseChars = FALLBACK_ARCHIVE.characters.slice(0, Math.min(FALLBACK_ARCHIVE.characters.length, playerCount));
  const characters = baseChars.slice();
  for (let k = 0; characters.length < playerCount; k++) {
    const tpl = CHARACTER_PAD_POOL[k % CHARACTER_PAD_POOL.length];
    const suffix = k >= CHARACTER_PAD_POOL.length ? ` ${k + 1}` : '';
    characters.push({
      name: tpl.name + suffix,
      role: tpl.role,
      suspicious_detail: tpl.suspicious_detail,
    });
  }

  const baseClues = FALLBACK_ARCHIVE.clues.slice(0, Math.min(FALLBACK_ARCHIVE.clues.length, clueCount));
  const clues = baseClues.slice();
  for (let k = 0; clues.length < clueCount; k++) {
    clues.push(CLUE_PAD_POOL[k % CLUE_PAD_POOL.length]);
  }
  // If clueCount < 3 we may still have surplus from FALLBACK_ARCHIVE.clues.
  clues.length = clueCount;

  // Mafiozos: pull names from the character list as deterministic anchors.
  const mafiozos = Array.from({ length: mafiozoCount }, (_, k) => {
    const ch = characters[k] || characters[0];
    return {
      name: ch.name,
      role: ch.role,
      suspicious_detail: ch.suspicious_detail,
    };
  });

  return {
    title: FALLBACK_ARCHIVE.title,
    story: FALLBACK_ARCHIVE.story,
    mafiozos,
    // Keep singular `mafiozo` field for downstream code that may still read
    // it (assignRoles ignores this field; validateArchive accepts both).
    mafiozo: mafiozos[0].name,
    obvious_suspect: FALLBACK_ARCHIVE.obvious_suspect,
    characters,
    clues,
  };
}

// ---------------------------------------------------------------------------
// Internal: provider attempts. Each returns the parsed+validated archive on
// success, or null on failure. They never throw.
// ---------------------------------------------------------------------------

/**
 * Try a Gemini archive call against a specific model. Returns the parsed
 * archive on success, or null on any failure (network, quota, rate limit,
 * invalid JSON, validation rejection). Never throws.
 *
 * @param {object} input          - archive input (idea, players, mood, difficulty)
 * @param {string} modelName      - the Gemini model to use for THIS attempt
 * @param {object} [opts]
 * @param {boolean} [opts.strict] - use the compact strict prompt (Flash fallback)
 */
/**
 * E4: archive validator opts derived from a generation input. Default mode
 * keeps the pre-E4 contract (3 clues, 1 mafiozo, ≥2 chars). Custom mode
 * (input.clueCount/mafiozoCount/players supplied) enforces exact counts.
 */
function deriveValidateOpts(input) {
  const i = input || {};
  const clueCount = Number.isFinite(i.clueCount) ? i.clueCount : 3;
  const mafiozoCount = Number.isFinite(i.mafiozoCount) ? i.mafiozoCount : 1;
  // FixPack v3 / Premium archive — every PROVIDER call goes through the
  // strict quality gate. The deterministic fallback stays opted-out
  // (skipQuality is implicit; the fallback builder constructs known-good
  // content) until Commit 2 lands the premium fallback.
  return {
    expectedClues: clueCount,
    expectedMafiozos: mafiozoCount,
    enforceQuality: true,
  };
}

async function tryGeminiArchive(input, modelName, { strict = false } = {}) {
  if (!config.gemini.apiKey) return null;
  if (!modelName) return null;
  const start = Date.now();
  try {
    const raw = await callGemini({
      modelName,
      userPrompt: strict ? archivePromptStrict(input) : archivePrompt(input),
      json: true,
      temperature: strict ? 0.85 : 0.9,
      maxOutputTokens: config.gemini.archiveMaxOutputTokens,
      // FixPack v3 / Commit 5: archive needs the longest budget but is
      // still capped so a stuck Pro never holds the host indefinitely.
      timeoutMs: AI_TIMEOUTS.archive.perModelMs,
    });
    const parsed = safeJsonParse(raw);
    if (!parsed) {
      console.warn(`[ai] gemini(${modelName}) archive invalid (malformed_json)`);
      logAi({ task: 'archive', source: 'gemini', model: modelName,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'malformed_json' });
      return null;
    }
    const err = validateArchive(parsed, deriveValidateOpts(input));
    if (err) {
      console.warn(`[ai] gemini(${modelName}) archive invalid (${err})`);
      logAi({ task: 'archive', source: 'gemini', model: modelName,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task: 'archive', source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: true });
    return parsed;
  } catch (err) {
    console.warn(`[ai] gemini(${modelName}) archive failed:`, err.message);
    logAi({ task: 'archive', source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

/**
 * FixPack v2 / Commit 5: OpenRouter archive attempt against an EXPLICIT
 * model. The caller iterates the chain (primary → alternate1 → alternate2)
 * via openrouterArchiveChain(); this function handles a single attempt.
 *
 * Returns the parsed archive on success, or null on any failure. Never
 * throws. Always logs ONE row per attempt — no prompt body, no response
 * body, no api keys; only model + source + ok + latency + validatorReason.
 */
async function tryOpenRouterArchive(input, modelName) {
  if (!openrouterConfigured()) return null;
  if (!modelName || typeof modelName !== 'string' || !modelName.trim()) return null;
  const orModel = modelName;
  const start = Date.now();
  try {
    const raw = await callOpenRouter({
      userPrompt: archivePromptStrict(input),
      json: true,
      temperature: 0.8,
      maxTokens: config.openrouter.archiveMaxTokens,
      modelName: orModel,
    });
    const parsed = safeJsonParse(raw);
    if (!parsed) {
      console.warn(`[ai] openrouter(${orModel}) archive invalid (malformed_json)`);
      logAi({ task: 'archive', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'malformed_json' });
      return null;
    }
    const err = validateArchive(parsed, deriveValidateOpts(input));
    if (err) {
      console.warn(`[ai] openrouter(${orModel}) archive invalid (${err})`);
      logAi({ task: 'archive', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task: 'archive', source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: true });
    return parsed;
  } catch (err) {
    console.warn(`[ai] openrouter(${orModel}) archive failed:`, err.message);
    logAi({ task: 'archive', source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

/**
 * FixPack v3 / Commit 1: task-aware OpenRouter model chain.
 *
 * The four documented tasks are 'archive' | 'final_reveal' | 'polish' | 'bio'.
 * Each task reads its dedicated env-driven list (config.openrouter.*Models).
 * If a task list is empty, the helper falls back to the legacy archive
 * chain (fallbackModel + _MODEL_2 + _MODEL_3) so existing operators see
 * no behavior regression.
 *
 * Returns ['model_a', 'model_b', ...] in attempt order. Blanks dropped,
 * duplicates dropped, order preserved.
 *
 * @param {'archive'|'final_reveal'|'polish'|'bio'} [task='archive']
 */
function getOpenRouterModelsForTask(task) {
  const t = typeof task === 'string' ? task : 'archive';
  let list = [];
  if (t === 'archive')           list = config.openrouter.archiveModels;
  else if (t === 'final_reveal') list = config.openrouter.finalRevealModels;
  else if (t === 'polish')       list = config.openrouter.polishModels;
  else if (t === 'bio')          list = config.openrouter.bioModels;
  if (Array.isArray(list) && list.length > 0) return list;
  // Legacy fallback: keep the old chain so existing deployments still work.
  const legacy = [
    config.openrouter.fallbackModel,
    config.openrouter.fallbackModel2,
    config.openrouter.fallbackModel3,
  ].filter(m => typeof m === 'string' && m.trim().length > 0);
  return legacy;
}

/**
 * Backward-compatible alias used by existing callers.
 */
function openrouterArchiveChain() {
  return getOpenRouterModelsForTask('archive');
}

/**
 * FixPack v3 / Commit 1: generic OpenRouter model-chain runner. Walks the
 * task's model list in order, calls the model via callOpenRouter, runs
 * the supplied validator, and returns the FIRST validated output. On
 * every miss it logs ONE metadata-only row (model + source + ok +
 * latency + validatorReason) — never the prompt or response body. Never
 * throws.
 *
 * @param {object} args
 * @param {string} args.task           — log label + model-list selector
 * @param {string} args.userPrompt     — the user message
 * @param {Function} args.validate     — (raw) => string|null|undefined
 *                                       returns truthy parsed value on success
 * @param {boolean} [args.json=false]  — JSON-only output flag
 * @param {number} [args.temperature=0.85]
 * @param {number} [args.maxTokens]
 * @param {string[]} [args.models]     — override (otherwise getOpenRouterModelsForTask)
 * @returns {Promise<{ source: 'openrouter', model: string, output: any } | null>}
 */
async function tryOpenRouterModelChain({
  task,
  userPrompt,
  validate,
  json = false,
  temperature = 0.85,
  maxTokens,
  models,
  timeoutMs,        // FixPack v3 / Commit 5: per-attempt cap (override)
  totalCapMs,       // FixPack v3 / Commit 5: chain-wide cap (override)
} = {}) {
  if (!openrouterConfigured()) return null;
  if (typeof task !== 'string' || !task) return null;
  if (typeof userPrompt !== 'string' || !userPrompt) return null;
  if (typeof validate !== 'function') return null;
  const chain = Array.isArray(models) && models.length > 0
    ? models
    : getOpenRouterModelsForTask(task);
  if (!chain || chain.length === 0) return null;

  // Resolve effective timeouts. Caller overrides win; otherwise look up
  // the task's documented profile.
  const taskTimeouts = getTaskTimeout(task);
  const effectivePerModelMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : taskTimeouts.perModelMs;
  const effectiveTotalCapMs = Number.isFinite(totalCapMs) && totalCapMs > 0
    ? totalCapMs
    : taskTimeouts.totalCapMs;

  const chainStart = Date.now();
  for (let i = 0; i < chain.length; i++) {
    const orModel = chain[i];
    if (!orModel || typeof orModel !== 'string' || !orModel.trim()) continue;

    // FixPack v3 / Commit 5: honour the chain-wide cap. If the previous
    // model already burned through the budget, log the abort and stop
    // instead of starting another (potentially slow) call.
    if (effectiveTotalCapMs && (Date.now() - chainStart) >= effectiveTotalCapMs) {
      logAi({ task, source: 'openrouter', model: orModel,
        latencyMs: 0, ok: false,
        validatorReason: 'chain_cap_exceeded' });
      break;
    }

    const start = Date.now();
    let raw;
    try {
      raw = await callOpenRouter({
        userPrompt,
        json,
        temperature,
        maxTokens,
        modelName: orModel,
        timeoutMs: effectivePerModelMs,
      });
    } catch (err) {
      logAi({ task, source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false,
        validatorReason: classifyProviderError(err) });
      continue;
    }
    let cleaned;
    try {
      cleaned = validate(raw);
    } catch {
      cleaned = null;
    }
    if (!cleaned) {
      logAi({ task, source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false,
        validatorReason: 'validator_rejected' });
      continue;
    }
    logAi({ task, source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: true });
    return { source: 'openrouter', model: orModel, output: cleaned };
  }
  return null;
}

async function tryGeminiNarration(prompt, forbiddenTerms) {
  if (!config.gemini.apiKey) return null;
  const modelName = config.gemini.narrationModel;
  const start = Date.now();
  try {
    const raw = await callGemini({
      modelName,
      userPrompt: prompt,
      json: false,
      temperature: 0.95,
      maxOutputTokens: config.gemini.narrationMaxOutputTokens,
      // FixPack v3 / Commit 5: clamp Gemini narration to the documented
      // per-task cap so a slow Flash response never holds up the phase.
      timeoutMs: AI_TIMEOUTS.narration.perModelMs,
    });
    const cleaned = validateNarration(raw, { forbiddenTerms });
    if (!cleaned) {
      console.warn(`[ai] gemini(${modelName}) narration rejected by validator`);
      logAi({ task: 'narration', source: 'gemini', model: modelName,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task: 'narration', source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: true });
    return cleaned;
  } catch (err) {
    console.warn(`[ai] gemini(${modelName}) narration failed:`, err.message);
    logAi({ task: 'narration', source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

// FixPack v3 / Commit 1: tryOpenRouterNarration / tryOpenRouterPolish were
// removed. Their callers now go through tryOpenRouterModelChain with a
// task-routed model list (polish | final_reveal | bio). See callers below.

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Build a sealed archive. Always returns:
 *   { source: 'gemini' | 'openrouter' | 'fallback', model?, archive, note? }
 * Never throws.
 *
 * Provider chain (FixPack v2 / Commit 5 — extended to TWO additional
 * OpenRouter model rungs while preserving the deterministic fallback):
 *   1. Gemini archive model (default gemini-2.5-pro)
 *   2. Gemini archive fallback model (default gemini-2.5-flash) — only if
 *      different from the primary model. This gracefully absorbs Pro quota
 *      exhaustion (HTTP 429) without leaving the Gemini family.
 *   3. OpenRouter primary fallback model (config.openrouter.fallbackModel)
 *   4. OpenRouter alternate model #2 (config.openrouter.fallbackModel2)
 *      — skipped silently when blank (default).
 *   5. OpenRouter alternate model #3 (config.openrouter.fallbackModel3)
 *      — skipped silently when blank (default).
 *   6. Built-in fallback scenario (deterministic, config-aware E4 padding).
 *
 * Each rung is independent: a quota error on one OpenRouter model never
 * prevents the next from being tried. Each attempt logs ONE row to
 * ai_generation_logs (metadata only — no prompt, no response). The chain
 * is array-driven so future operators can add or remove rungs by adjusting
 * env vars without touching code.
 */
async function generateSealedArchive(input = {}) {
  // Rung 1: primary Gemini model with the full Architect prompt.
  const primaryModel = config.gemini.archiveModel;
  const fromPrimary = await tryGeminiArchive(input, primaryModel);
  if (fromPrimary) return { source: 'gemini', model: primaryModel, archive: fromPrimary };

  // Rung 2: internal Gemini fallback model — uses the STRICT compact prompt
  // because Flash-class thinking models burn budget on the verbose prompt.
  // Skip if identical to primary.
  const fbModel = config.gemini.archiveFallbackModel;
  if (fbModel && fbModel !== primaryModel) {
    const fromFallback = await tryGeminiArchive(input, fbModel, { strict: true });
    if (fromFallback) return { source: 'gemini', model: fbModel, archive: fromFallback };
  }

  // Rungs 3..N: OpenRouter chain (primary + alternates). Empty/blank rungs
  // are skipped silently inside tryOpenRouterArchive; the operator can
  // tune the chain by setting OPENROUTER_FALLBACK_MODEL_2 /
  // OPENROUTER_FALLBACK_MODEL_3 env vars.
  for (const orModel of openrouterArchiveChain()) {
    const fromOpenRouter = await tryOpenRouterArchive(input, orModel);
    if (fromOpenRouter) {
      return { source: 'openrouter', model: orModel, archive: fromOpenRouter };
    }
  }

  // Final rung: built-in fallback archive (E4: config-aware).
  logAi({ task: 'archive_fallback', source: 'fallback', model: 'built-in',
    latencyMs: 0, ok: true, validatorReason: 'fallback_used' });
  const archive = buildFallbackArchive(input);
  return { source: 'fallback', archive, note: FALLBACK_NOTE_AR };
}

/**
 * Short cinematic narration for in-game phase transitions.
 * Returns: { source, line }
 *
 * @param {object} opts
 * @param {string} opts.phase
 * @param {string} [opts.context]
 * @param {string[]} [opts.forbiddenTerms]  - terms that must not appear in
 *   the line (e.g. mafiozo identity for mid-game beats).
 */
async function narrate({ phase, context, forbiddenTerms } = {}) {
  const prompt = narrationPrompt({ phase, context });

  const fromGemini = await tryGeminiNarration(prompt, forbiddenTerms);
  if (fromGemini) return { source: 'gemini', model: config.gemini.narrationModel, line: fromGemini };

  // FixPack v3 / Commit 1: short prose uses the polish model chain.
  // Log label stays 'narration' so historical analytics queries continue
  // to work; the chain selector is 'polish'.
  const fromOpenRouter = await tryOpenRouterModelChain({
    task: 'narration',
    userPrompt: prompt,
    validate: (raw) => validateNarration(raw, { forbiddenTerms }),
    models: getOpenRouterModelsForTask('polish'),
    json: false,
    temperature: 0.9,
    maxTokens: config.openrouter.narrationMaxTokens,
  });
  if (fromOpenRouter) {
    return { source: 'openrouter', model: fromOpenRouter.model, line: fromOpenRouter.output };
  }

  logAi({ task: 'narration_fallback', source: 'fallback', model: 'built-in',
    latencyMs: 0, ok: true, validatorReason: 'fallback_used' });
  return { source: 'fallback', line: FALLBACK_NARRATION };
}

// ---------------------------------------------------------------------------
// Polish provider attempts (C2 / C3).
//
// Same provider chain shape as narration (Gemini Flash → OpenRouter), but
// with caller-supplied validators so JSON-shaped (final reveal) and line-
// shaped (vote result, clue transition) outputs each get their own gate.
// ---------------------------------------------------------------------------

async function tryGeminiPolish(prompt, validator, task, { json = false } = {}) {
  if (!config.gemini.apiKey) return null;
  const modelName = config.gemini.narrationModel;
  const start = Date.now();
  try {
    const raw = await callGemini({
      modelName,
      userPrompt: prompt,
      json,
      temperature: 0.95,
      maxOutputTokens: config.gemini.narrationMaxOutputTokens,
      // FixPack v3 / Commit 5: per-task timeout cap. The polish path
      // must not block phase transitions on a slow Flash response.
      timeoutMs: getTaskTimeout(task).perModelMs,
    });
    const cleaned = validator(raw);
    if (!cleaned) {
      logAi({ task, source: 'gemini', model: modelName,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task, source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: true });
    return cleaned;
  } catch (err) {
    logAi({ task, source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

// (tryOpenRouterPolish was removed — see comment above tryOpenRouterModelChain.)

/**
 * Embellish a vote-result deterministic payload with one short Arabic noir
 * line. Returns { source, model, line } on success; null otherwise.
 *
 * input.forbiddenTerms must include the alive Mafiozo username/character
 * names mid-game so the AI cannot expose them.
 */
async function embellishVoteResult(input) {
  const prompt = voteResultPolishPrompt(input || {});
  const forbiddenTerms = Array.isArray(input && input.forbiddenTerms) ? input.forbiddenTerms : [];
  const validator = (raw) => validatePolishLine(raw, { forbiddenTerms });
  const task = 'vote_result_polish';

  const fromGemini = await tryGeminiPolish(prompt, validator, task);
  if (fromGemini) return { source: 'gemini', model: config.gemini.narrationModel, line: fromGemini };

  // FixPack v3 / Commit 1: vote-result polish uses the 'polish' chain.
  const fromOpenRouter = await tryOpenRouterModelChain({
    task,
    userPrompt: prompt,
    validate: validator,
    models: getOpenRouterModelsForTask('polish'),
    json: false,
    temperature: 0.9,
    maxTokens: config.openrouter.narrationMaxTokens,
  });
  if (fromOpenRouter) {
    return { source: 'openrouter', model: fromOpenRouter.model, line: fromOpenRouter.output };
  }
  return null;
}

/**
 * Bridge prose between a finished round and the next clue. Same contract
 * as embellishVoteResult.
 */
async function embellishClueTransition(input) {
  const prompt = clueTransitionPolishPrompt(input || {});
  const forbiddenTerms = Array.isArray(input && input.forbiddenTerms) ? input.forbiddenTerms : [];
  const validator = (raw) => validatePolishLine(raw, { forbiddenTerms });
  const task = 'clue_transition_polish';

  const fromGemini = await tryGeminiPolish(prompt, validator, task);
  if (fromGemini) return { source: 'gemini', model: config.gemini.narrationModel, line: fromGemini };

  // FixPack v3 / Commit 1: clue-transition polish uses the 'polish' chain.
  const fromOpenRouter = await tryOpenRouterModelChain({
    task,
    userPrompt: prompt,
    validate: validator,
    models: getOpenRouterModelsForTask('polish'),
    json: false,
    temperature: 0.9,
    maxTokens: config.openrouter.narrationMaxTokens,
  });
  if (fromOpenRouter) {
    return { source: 'openrouter', model: fromOpenRouter.model, line: fromOpenRouter.output };
  }
  return null;
}

/**
 * Polish the FINAL_REVEAL screen with optional cinematic flavor fields.
 * Returns { source, model, polish } where polish is an object containing
 * only validated optional fields (heroSubtitle, caseClosingLine,
 * finalParagraph, epilogue). Returns null if no provider succeeded.
 *
 * The caller MUST guarantee phase === FINAL_REVEAL — at that point all
 * roles are public, so input may include real Mafiozo names.
 */
async function embellishFinalReveal(input) {
  const prompt = finalRevealPolishPrompt(input || {});
  const validator = (raw) => validateFinalRevealPolish(raw);
  const task = 'final_reveal_polish';

  const fromGemini = await tryGeminiPolish(prompt, validator, task, { json: true });
  if (fromGemini) return { source: 'gemini', model: config.gemini.narrationModel, polish: fromGemini };

  // FixPack v3 / Commit 1: final-reveal polish uses the 'final_reveal' chain
  // (heavier reasoning models preferred).
  const fromOpenRouter = await tryOpenRouterModelChain({
    task,
    userPrompt: prompt,
    validate: validator,
    models: getOpenRouterModelsForTask('final_reveal'),
    json: true,
    temperature: 0.9,
    maxTokens: config.openrouter.narrationMaxTokens,
  });
  if (fromOpenRouter) {
    return { source: 'openrouter', model: fromOpenRouter.model, polish: fromOpenRouter.output };
  }
  return null;
}

/**
 * Polish a user-supplied rough idea into a Mafiozo-noir bio.
 * Returns { source, model?, bio } where source is one of
 * 'gemini' | 'openrouter' | 'fallback'. NEVER throws.
 */
async function writeProfileBio(input) {
  const prompt = profileBioPrompt(input || {});
  const validator = (raw) => validateBio(raw);
  const task = 'profile_bio';

  const fromGemini = await tryGeminiPolish(prompt, validator, task);
  if (fromGemini) return { source: 'gemini', model: config.gemini.narrationModel, bio: fromGemini };

  // FixPack v3 / Commit 1: bio uses the dedicated 'bio' chain.
  const fromOpenRouter = await tryOpenRouterModelChain({
    task,
    userPrompt: prompt,
    validate: validator,
    models: getOpenRouterModelsForTask('bio'),
    json: false,
    temperature: 0.9,
    maxTokens: config.openrouter.narrationMaxTokens,
  });
  if (fromOpenRouter) {
    return { source: 'openrouter', model: fromOpenRouter.model, bio: fromOpenRouter.output };
  }

  // Deterministic fallback. Log a fallback row so admin analytics still
  // sees the bio attempt. Metadata-only (no rawIdea, no bio body).
  logAi({ task, source: 'fallback', model: 'built-in',
    latencyMs: 0, ok: true, validatorReason: 'fallback_used' });
  return { source: 'fallback', bio: buildFallbackBio(input || {}) };
}

/**
 * FixPack v3 / Commit 2 — guided identity-interview producer.
 *
 * Input shape (already validated at the route boundary):
 *   { answers: [ { questionId, question, answer }, ... ], username }
 *
 * Output:
 *   { source: 'gemini' | 'openrouter' | 'fallback',
 *     model?: string,
 *     identity: { bio, title, tone, motto, playStyleSummary } }
 *
 * Provider chain:
 *   1. Gemini (narration model, JSON mode) via tryGeminiPolish
 *   2. OpenRouter bio chain via tryOpenRouterModelChain
 *   3. Deterministic fallback via buildFallbackIdentity (always passes
 *      validateIdentityInterviewOutput by construction)
 *
 * Privacy:
 *   - The user's answers are inlined in the prompt and never logged.
 *   - The AI response is validated and never persisted to logs.
 *   - logAi rows carry only metadata (model + source + ok + latency
 *     + validatorReason) — pinned by the static-source regression test.
 */
async function runIdentityInterview(input) {
  const safe = (input && typeof input === 'object') ? input : {};
  const prompt = identityInterviewPrompt(safe);
  const validator = (raw) => validateIdentityInterviewOutput(raw);
  const task = 'profile_identity';

  const fromGemini = await tryGeminiPolish(prompt, validator, task, { json: true });
  if (fromGemini) {
    return {
      source: 'gemini',
      model: config.gemini.narrationModel,
      identity: fromGemini,
    };
  }

  const fromOpenRouter = await tryOpenRouterModelChain({
    task,
    userPrompt: prompt,
    validate: validator,
    models: getOpenRouterModelsForTask('bio'),
    json: true,
    temperature: 0.85,
    maxTokens: config.openrouter.narrationMaxTokens,
  });
  if (fromOpenRouter) {
    return {
      source: 'openrouter',
      model: fromOpenRouter.model,
      identity: fromOpenRouter.output,
    };
  }

  logAi({ task, source: 'fallback', model: 'built-in',
    latencyMs: 0, ok: true, validatorReason: 'fallback_used' });
  return {
    source: 'fallback',
    identity: buildFallbackIdentity(safe),
  };
}

module.exports = {
  generateSealedArchive,
  narrate,
  embellishVoteResult,
  embellishClueTransition,
  embellishFinalReveal,
  writeProfileBio,
  runIdentityInterview,
  // Test/diagnostic exports — not part of the route surface.
  _validateArchive: validateArchive,
  _fallbackArchive: FALLBACK_ARCHIVE,
  _buildFallbackArchive: buildFallbackArchive,
  _buildFallbackIdentity: buildFallbackIdentity,
  _openrouterArchiveChain: openrouterArchiveChain,
  _getOpenRouterModelsForTask: getOpenRouterModelsForTask,
  _tryOpenRouterModelChain: tryOpenRouterModelChain,
  _AI_TIMEOUTS: AI_TIMEOUTS,
  _getTaskTimeout: getTaskTimeout,
  _classifyProviderError: classifyProviderError,
};
