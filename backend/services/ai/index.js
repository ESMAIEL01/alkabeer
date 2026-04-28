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
} = require('./prompts');
const {
  safeJsonParse, validateArchive, validateNarration,
  validatePolishLine, validateFinalRevealPolish,
  validateBio,
} = require('./validators');
const { buildFallbackBio } = require('./bio-fallback');
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
  return { expectedClues: clueCount, expectedMafiozos: mafiozoCount };
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
 * FixPack v2 / Commit 5: build the OpenRouter archive chain from config.
 * Returns ['model_a', 'model_b', ...] in attempt order, with empty/blank
 * entries removed. Lets the operator add or remove rungs without code change.
 */
function openrouterArchiveChain() {
  return [
    config.openrouter.fallbackModel,
    config.openrouter.fallbackModel2,
    config.openrouter.fallbackModel3,
  ].filter(m => typeof m === 'string' && m.trim().length > 0);
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

async function tryOpenRouterNarration(prompt, forbiddenTerms) {
  if (!openrouterConfigured()) return null;
  const orModel = config.openrouter.fallbackModel;
  const start = Date.now();
  try {
    const raw = await callOpenRouter({
      userPrompt: prompt,
      json: false,
      temperature: 0.9,
      maxTokens: config.openrouter.narrationMaxTokens,
    });
    const cleaned = validateNarration(raw, { forbiddenTerms });
    if (!cleaned) {
      console.warn('[ai] openrouter narration rejected by validator');
      logAi({ task: 'narration', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task: 'narration', source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: true });
    return cleaned;
  } catch (err) {
    console.warn('[ai] openrouter narration failed:', err.message);
    logAi({ task: 'narration', source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

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

  const fromOpenRouter = await tryOpenRouterNarration(prompt, forbiddenTerms);
  if (fromOpenRouter) return { source: 'openrouter', model: config.openrouter.fallbackModel, line: fromOpenRouter };

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

async function tryOpenRouterPolish(prompt, validator, task, { json = false } = {}) {
  if (!openrouterConfigured()) return null;
  const orModel = config.openrouter.fallbackModel;
  const start = Date.now();
  try {
    const raw = await callOpenRouter({
      userPrompt: prompt,
      json,
      temperature: 0.9,
      maxTokens: config.openrouter.narrationMaxTokens,
    });
    const cleaned = validator(raw);
    if (!cleaned) {
      logAi({ task, source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task, source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: true });
    return cleaned;
  } catch (err) {
    logAi({ task, source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

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

  const fromOpenRouter = await tryOpenRouterPolish(prompt, validator, task);
  if (fromOpenRouter) return { source: 'openrouter', model: config.openrouter.fallbackModel, line: fromOpenRouter };

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

  const fromOpenRouter = await tryOpenRouterPolish(prompt, validator, task);
  if (fromOpenRouter) return { source: 'openrouter', model: config.openrouter.fallbackModel, line: fromOpenRouter };

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

  const fromOpenRouter = await tryOpenRouterPolish(prompt, validator, task, { json: true });
  if (fromOpenRouter) return { source: 'openrouter', model: config.openrouter.fallbackModel, polish: fromOpenRouter };

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

  const fromOpenRouter = await tryOpenRouterPolish(prompt, validator, task);
  if (fromOpenRouter) return { source: 'openrouter', model: config.openrouter.fallbackModel, bio: fromOpenRouter };

  // Deterministic fallback. Log a fallback row so admin analytics still
  // sees the bio attempt. Metadata-only (no rawIdea, no bio body).
  logAi({ task, source: 'fallback', model: 'built-in',
    latencyMs: 0, ok: true, validatorReason: 'fallback_used' });
  return { source: 'fallback', bio: buildFallbackBio(input || {}) };
}

module.exports = {
  generateSealedArchive,
  narrate,
  embellishVoteResult,
  embellishClueTransition,
  embellishFinalReveal,
  writeProfileBio,
  // Test/diagnostic exports — not part of the route surface.
  _validateArchive: validateArchive,
  _fallbackArchive: FALLBACK_ARCHIVE,
  _buildFallbackArchive: buildFallbackArchive,
  _openrouterArchiveChain: openrouterArchiveChain,
};
