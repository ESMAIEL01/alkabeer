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
  // FixPack v3 / Latency hotfix — production observed 121 s archive
  // generation even with the 40 s "cap" because the cap was checked
  // BETWEEN rungs and each rung could still run a full 25 s. The new
  // contract:
  //   * perModelMs caps a single attempt.
  //   * totalCapMs is the public deadline; generateSealedArchive races
  //     the chain against this deadline and returns a pre-validated
  //     premium fallback if the deadline expires.
  //   * minAttemptMs is the smallest remaining budget that justifies
  //     starting another model. Below it, the chain bails to the
  //     fallback rather than spinning up a likely-to-be-cut-short call.
  //   * Each model attempt receives min(perModelMs, remainingMs) so a
  //     stuck rung CAN'T extend past the deadline.
  // Tighter values keep the user experience inside the 40 s envelope
  // even when 3 of 4 OpenRouter models are slow / weak / quota'd.
  archive:                 { perModelMs: 12_000, totalCapMs: 40_000, minAttemptMs: 3_000 },
  final_reveal_polish:     { perModelMs: 10_000, totalCapMs: 20_000, minAttemptMs: 2_000 },
  profile_identity:        { perModelMs: 10_000, totalCapMs: 20_000, minAttemptMs: 2_000 },
  profile_bio:             { perModelMs: 10_000, totalCapMs: 20_000, minAttemptMs: 2_000 },
  clue_transition_polish:  { perModelMs:  7_000, totalCapMs: 12_000, minAttemptMs: 1_500 },
  vote_result_polish:      { perModelMs:  7_000, totalCapMs: 12_000, minAttemptMs: 1_500 },
  narration:               { perModelMs:  8_000, totalCapMs: 14_000, minAttemptMs: 1_500 },
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
 * FixPack v3 / Latency hotfix — deadline helper.
 *
 * Wraps a wall-clock deadline so callers can:
 *   - check remaining time at any point
 *   - decide whether another attempt is worth starting
 *   - clamp per-attempt timeouts to never exceed the deadline
 *
 * Returns a frozen-shaped object so the helper is cheap and immutable
 * from the caller's perspective.
 */
function createDeadline(totalMs) {
  const startedAt = Date.now();
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 30_000;
  const deadlineAt = startedAt + total;
  return {
    startedAt,
    deadlineAt,
    totalMs: total,
    elapsedMs() { return Date.now() - startedAt; },
    remainingMs() { return Math.max(0, deadlineAt - Date.now()); },
    expired() { return Date.now() >= deadlineAt; },
    canAttempt(minMs) {
      const m = Number.isFinite(minMs) && minMs > 0 ? minMs : 0;
      return (deadlineAt - Date.now()) >= m;
    },
    /** clamp(perModelMs) → min(perModelMs, remaining). Never returns 0. */
    clamp(perModelMs) {
      const remaining = Math.max(0, deadlineAt - Date.now());
      const cap = Number.isFinite(perModelMs) && perModelMs > 0
        ? Math.min(perModelMs, remaining)
        : remaining;
      return Math.max(1, cap);  // never 0; caller already gated via canAttempt
    },
  };
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
// Built-in fallback content (FixPack v3 / Premium archive).
//
// The game must always be playable. The fallback archive is constructed
// from curated noir pools so the output ALWAYS satisfies the Commit 1
// quality gate: every title, role, suspicious_detail, and clue sits
// inside the documented length windows; every character name is a real
// Arabic name (no usernames, no underscores, no parens, no repeated
// letters); clues are distinctive enough that no two are near-duplicates.
//
// Deterministic by construction: the same (players, clueCount,
// mafiozoCount, idea) produces the same archive. A small seed hash over
// the `idea` string rotates the pool offsets so different host ideas
// yield different stories.
// ---------------------------------------------------------------------------

const FALLBACK_NOTE_AR = 'الكبير اشتغل بقصة احتياطية دلوقتي. خدمة الذكاء مش متاحة للحظات.';
const FALLBACK_NARRATION = '...الكبير ساكت دلوقتي';

// FixPack v3 / Commit 2 — pull the premium fallback builder from its
// dep-free module. The pools below are kept in sync as a SOURCE OF
// TRUTH for the prompt examples; the actual generator lives in
// archive-fallback.js so unit tests can import it without booting
// dotenv.
const _archiveFallback = require('./archive-fallback');

// FixPack v3 / Commit 2 — premium fallback delegated to the dep-free
// archive-fallback.js so unit tests can run locally without dotenv. The
// pools (12 titles, 12 locations, 16 names, 16 roles, 16 details, 10
// clues) are documented in archive-fallback.js — single source of truth.
const buildFallbackArchive = _archiveFallback.buildFallbackArchive;

// Legacy compat — the FALLBACK_ARCHIVE constant was previously frozen at
// module scope. The premium fallback is generated once at boot for the
// default 4/3/1 shape; downstream callers may inspect it but should not
// mutate the returned object.
const FALLBACK_ARCHIVE = buildFallbackArchive({ players: 4, clueCount: 3, mafiozoCount: 1 });

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

async function tryGeminiArchive(input, modelName, { strict = false, timeoutMs } = {}) {
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
      // FixPack v3 / Latency hotfix — caller-supplied per-attempt cap
      // (typically deadline.clamp(perModelMs)). Falls back to the
      // task profile when not supplied so legacy callers still work.
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : AI_TIMEOUTS.archive.perModelMs,
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
      // FixPack v3 / Commit 3 — pass the specific quality reason
      // (weak_clue@2, placeholder_detected, username_like_name@1, etc.)
      // through to analytics so admins can see WHY a model failed,
      // not just that it failed. Reason string is short + stable.
      logAi({ task: 'archive', source: 'gemini', model: modelName,
        latencyMs: Date.now() - start, ok: false,
        validatorReason: classifyValidatorReason(err) });
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
 * FixPack v3 / Commit 3 — map a validator reason string to a stable
 * short tag for analytics. Quality reasons from Commit 1 carry an "@N"
 * suffix (e.g. "weak_clue@2"); this strips the index so admin queries
 * group by category. Schema reasons pass through.
 *
 * Stable tags emitted (subset, expandable):
 *   weak_clue | clue_too_short | clue_too_long | clues_too_similar |
 *   weak_character_name | username_like_name | character_role_length |
 *   weak_suspicious_detail | suspicious_detail_length |
 *   weak_title | title_length | weak_story | story_length |
 *   story_arabic_low | clue_arabic_low | weak_mafiozo_name |
 *   weak_obvious_suspect | placeholder_detected |
 *   schema_invalid (for any other unrecognized reason)
 */
function classifyValidatorReason(reason) {
  if (typeof reason !== 'string' || !reason) return 'schema_invalid';
  // Strip the optional "@N" or "@N,M" suffix from quality reasons.
  const head = reason.split('@')[0];
  // Schema reasons currently start with phrases like "missing", "expected",
  // etc. — fold them into a single bucket so the catalog stays stable.
  if (/^(weak_|clue_too_|clues_too_|username_|character_role_|suspicious_detail_|title_|story_|placeholder_|arabic_)/.test(head)) {
    return head;
  }
  return 'schema_invalid';
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
async function tryOpenRouterArchive(input, modelName, { timeoutMs } = {}) {
  if (!openrouterConfigured()) return null;
  if (!modelName || typeof modelName !== 'string' || !modelName.trim()) return null;
  const orModel = modelName;
  const start = Date.now();
  try {
    const raw = await callOpenRouter({
      userPrompt: archivePromptStrict(input),
      json: true,
      // FixPack v3 / Latency hotfix — caller-supplied per-attempt cap
      // (typically deadline.clamp(perModelMs)). Defaults to the task
      // profile so any direct caller still gets a bounded attempt.
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : AI_TIMEOUTS.archive.perModelMs,
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
      // FixPack v3 / Commit 3 — emit the specific quality category.
      logAi({ task: 'archive', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false,
        validatorReason: classifyValidatorReason(err) });
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
 * FixPack v3 / Commit 3 — OPTIONAL JSON repair pass.
 *
 * Only fires when:
 *   - OPENROUTER_REPAIR_MODELS is configured (env opt-in).
 *   - OpenRouter is configured (otherwise no model to call).
 *   - The caller has a malformed-but-non-empty raw text from a prior
 *     model attempt that we want to coerce into valid JSON.
 *
 * Walks the configured repair models in order and returns the FIRST
 * repaired+validated archive. Each attempt logs metadata-only via
 * logAi under task='archive_repair'. The repair prompt explicitly
 * forbids inventing missing story content; if the source is too far
 * gone the repair model returns invalid output and we fall through.
 */
async function tryArchiveJsonRepair(rawText, input) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  if (!openrouterConfigured()) return null;
  const repairModels = Array.isArray(config.openrouter.repairModels)
    ? config.openrouter.repairModels
    : [];
  if (repairModels.length === 0) return null;

  const opts = deriveValidateOpts(input);
  const repairPrompt = [
    'You are a strict JSON repair tool. Convert the input below into valid',
    'archive JSON matching the documented schema. Do NOT invent missing',
    'story content. If the input is mostly placeholder text or weak content,',
    'return exactly the literal token "INVALID" instead of any JSON.',
    'Return strict JSON only — no prose, no markdown, no code fences.',
    '',
    'Required schema:',
    '{ "title": string, "story": string, "obvious_suspect": string,',
    '  "characters": [{ "name": string, "role": string, "suspicious_detail": string }, ...],',
    '  "clues": [string, ...],',
    `  ${opts.expectedMafiozos === 1 ? '"mafiozo": string' : '"mafiozos": [{ "name": string, "role": string, "suspicious_detail": string }, ...]'}`,
    '}',
    '',
    'Input:',
    rawText.slice(0, 6000),
  ].join('\n');

  for (const orModel of repairModels) {
    if (!orModel || typeof orModel !== 'string' || !orModel.trim()) continue;
    const start = Date.now();
    let raw;
    try {
      raw = await callOpenRouter({
        userPrompt: repairPrompt,
        json: true,
        temperature: 0.1,                  // deterministic repair pass
        maxTokens: config.openrouter.archiveMaxTokens,
        modelName: orModel,
        timeoutMs: AI_TIMEOUTS.archive.perModelMs,
      });
    } catch (err) {
      logAi({ task: 'archive_repair', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false,
        validatorReason: classifyProviderError(err) });
      continue;
    }
    if (typeof raw === 'string' && raw.trim().toUpperCase() === 'INVALID') {
      logAi({ task: 'archive_repair', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false,
        validatorReason: 'repair_marked_invalid' });
      continue;
    }
    const parsed = safeJsonParse(raw);
    if (!parsed) {
      logAi({ task: 'archive_repair', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'malformed_json' });
      continue;
    }
    const err = validateArchive(parsed, opts);
    if (err) {
      logAi({ task: 'archive_repair', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false,
        validatorReason: classifyValidatorReason(err) });
      continue;
    }
    logAi({ task: 'archive_repair', source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: true });
    return { source: 'openrouter', model: orModel, archive: parsed };
  }
  return null;
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
  // FixPack v3 / Latency hotfix — deadline-driven generation.
  //
  // Production observed 121 s wall-clock generation even with the previous
  // 40 s "totalCapMs" because the cap was checked BETWEEN rungs only and
  // each rung could still run a full 25 s. The new contract:
  //
  //   1. Public deadline = AI_TIMEOUTS.archive.totalCapMs (40 s).
  //   2. Pre-build the premium deterministic fallback at the very start.
  //      It is always validated by construction (archive-fallback.js).
  //   3. Run the chain INSIDE Promise.race against a deadline timer.
  //      When the deadline fires, the race returns the fallback even if
  //      a slow provider call is still in-flight.
  //   4. Each provider attempt receives min(perModelMs, remainingMs) so a
  //      stuck rung CANNOT extend past the deadline.
  //   5. If remainingMs < minAttemptMs, skip the rung entirely.
  //
  // The fallback is selected when the chain genuinely fails OR when the
  // deadline beats it. Either way, the returned archive passes the same
  // quality gate as model output.
  const deadline = createDeadline(AI_TIMEOUTS.archive.totalCapMs || 40_000);
  const PER_MODEL = AI_TIMEOUTS.archive.perModelMs;
  const MIN_ATTEMPT = AI_TIMEOUTS.archive.minAttemptMs;

  // Pre-build the validated premium fallback. archive-fallback.js
  // guarantees by construction that this always passes schema + quality;
  // we keep it ready so the deadline race has something to return.
  const premiumFallback = buildFallbackArchive(input);

  // The chain promise tries every viable rung in order, stopping on
  // first success. On any provider failure the chain logs metadata and
  // continues. If the chain finishes with no success, it resolves to
  // null so the deadline-race fallback path takes over.
  const chainPromise = (async () => {
    // Rung 1: primary Gemini model.
    const primaryModel = config.gemini.archiveModel;
    if (deadline.canAttempt(MIN_ATTEMPT)) {
      const fromPrimary = await tryGeminiArchive(input, primaryModel, {
        timeoutMs: deadline.clamp(PER_MODEL),
      });
      if (fromPrimary) {
        return { source: 'gemini', model: primaryModel, archive: fromPrimary };
      }
    }

    // Rung 2: Gemini Flash strict.
    const fbModel = config.gemini.archiveFallbackModel;
    if (fbModel && fbModel !== primaryModel && deadline.canAttempt(MIN_ATTEMPT)) {
      const fromFlash = await tryGeminiArchive(input, fbModel, {
        strict: true,
        timeoutMs: deadline.clamp(PER_MODEL),
      });
      if (fromFlash) {
        return { source: 'gemini', model: fbModel, archive: fromFlash };
      }
    }

    // Rungs 3..N: OpenRouter chain (task-aware list).
    for (const orModel of openrouterArchiveChain()) {
      if (!deadline.canAttempt(MIN_ATTEMPT)) {
        logAi({ task: 'archive', source: 'openrouter', model: orModel,
          latencyMs: 0, ok: false,
          validatorReason: 'chain_cap_exceeded' });
        break;
      }
      const fromOpenRouter = await tryOpenRouterArchive(input, orModel, {
        timeoutMs: deadline.clamp(PER_MODEL),
      });
      if (fromOpenRouter) {
        return { source: 'openrouter', model: orModel, archive: fromOpenRouter };
      }
    }

    return null;  // chain exhausted without a winner; let race resolve
                  // to fallback below.
  })();

  // Deadline timer — resolves to a sentinel that signals "use fallback".
  const DEADLINE_SENTINEL = Symbol('archive_deadline');
  const deadlineTimer = new Promise((resolve) => {
    setTimeout(() => resolve(DEADLINE_SENTINEL), deadline.totalMs).unref();
  });

  const winner = await Promise.race([chainPromise, deadlineTimer]);

  if (winner && winner !== DEADLINE_SENTINEL && winner.archive) {
    return winner;
  }

  // Deadline expired OR chain exhausted → premium deterministic fallback.
  // The fallback is always playable; no provider call has poisoned it
  // because we constructed it independently at function entry.
  const reason = winner === DEADLINE_SENTINEL ? 'chain_cap_exceeded' : 'fallback_used';
  logAi({ task: 'archive_fallback', source: 'fallback', model: 'built-in',
    latencyMs: deadline.elapsedMs(), ok: true,
    validatorReason: reason });
  return {
    source: 'fallback',
    model: 'premium-deterministic',
    archive: premiumFallback,
    note: FALLBACK_NOTE_AR,
  };
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
  _classifyValidatorReason: classifyValidatorReason,
  _tryArchiveJsonRepair: tryArchiveJsonRepair,
  _createDeadline: createDeadline,
  _getTaskTimeout: getTaskTimeout,
  _classifyProviderError: classifyProviderError,
};
