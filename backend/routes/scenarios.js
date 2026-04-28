/**
 * Scenarios route — wraps the AI service for the frontend.
 *
 * Endpoints:
 *   POST /api/scenarios/ai-generate
 *     body: { idea?, players?, mood?, difficulty? }
 *     -> { success, source, scenario, clues, archive_b64, mafiozo, obvious_suspect, characters, note? }
 *
 *   POST /api/scenarios/ai-generate-three
 *     body: { idea?, players?, mood?, difficulty? }
 *     -> { success, source, options: [3 archives] }   (used by the 3-scenario picker)
 *
 *   POST /api/scenarios/premium-fallback
 *     body: { idea?, players?, clueCount?, mafiozoCount? }
 *     -> { success, source: "fallback", model: "premium-deterministic", scenario, ... }
 *
 *   POST /api/scenarios/narrate     (auth optional)
 *     body: { phase, context }
 *     -> { success, line }
 *
 * Errors are normalized to JSON: { error: "<arabic message>" }
 */
const express = require('express');
const ai = require('../services/ai');
const { query } = require('../database');
const { buildFallbackArchive } = require('../services/ai/archive-fallback');
const { validateArchive } = require('../services/ai/validators');
const { logAiGeneration } = require('../services/analytics');

const router = express.Router();

/**
 * Encode arbitrary UTF-8 (including Arabic) to Base64. Node's Buffer handles
 * UTF-8 natively — no need for the unescape/encodeURIComponent dance.
 */
function toBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function shapeArchiveResponse(result) {
  const { source, model, archive, note } = result;
  const story = archive.story || '';
  return {
    success: true,
    source,                                  // 'gemini' | 'openrouter' | 'fallback'
    ...(model ? { model } : {}),             // e.g. 'gemini-2.5-pro' or 'gemini-2.5-flash'
    scenario: story,                         // legacy field (matches old API)
    title: archive.title || null,
    mafiozo: archive.mafiozo,
    obvious_suspect: archive.obvious_suspect,
    characters: archive.characters || [],
    clues: archive.clues || [],
    archive_b64: toBase64(JSON.stringify(archive)),
    ...(note ? { note } : {}),
  };
}

/**
 * E4: clamp + validate Custom Mode counters at the request boundary so
 * the frontend cannot drive prompts / fallback past safe ranges. Returns
 * { ok, errors, normalized } shape; always returns a normalized triple.
 */
function normalizeCustomCounters(body) {
  const b = body || {};
  const errors = [];
  let players = Number.parseInt(b.players, 10);
  let clueCount = Number.parseInt(b.clueCount, 10);
  let mafiozoCount = Number.parseInt(b.mafiozoCount, 10);

  if (!Number.isFinite(players)) players = 5;
  if (players < 3 || players > 8) errors.push('عدد اللاعبين لازم يكون من 3 لـ 8.');

  if (!Number.isFinite(clueCount)) clueCount = 3;
  if (clueCount < 1 || clueCount > 5) errors.push('عدد الأدلة لازم يكون من 1 لـ 5.');

  if (!Number.isFinite(mafiozoCount)) mafiozoCount = 1;
  const mafiozoMax = Math.max(1, Math.floor((players - 1) / 2));
  if (mafiozoCount < 1 || mafiozoCount > mafiozoMax) {
    errors.push(`عدد المافيوزو لازم يكون من 1 لـ ${mafiozoMax}.`);
  }

  return { ok: errors.length === 0, errors, normalized: { players, clueCount, mafiozoCount } };
}

router.post('/ai-generate', async (req, res, next) => {
  try {
    const { idea, mood, difficulty } = req.body || {};
    const counters = normalizeCustomCounters(req.body);
    if (!counters.ok) {
      return res.status(400).json({ error: counters.errors[0] });
    }
    const { players, clueCount, mafiozoCount } = counters.normalized;
    const result = await ai.generateSealedArchive({
      idea, players, mood, difficulty, clueCount, mafiozoCount,
    });
    const payload = shapeArchiveResponse(result);

    // Best-effort persist as a draft if we have an authenticated user.
    // (Auth middleware not wired yet for this route — that lands in Phase C.)
    try {
      const userIdHeader = req.headers['x-user-id'];
      if (userIdHeader) {
        await query(
          `INSERT INTO scenario_drafts (user_id, title, content, archive_b64, clues)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            parseInt(userIdHeader, 10) || null,
            payload.title,
            payload.scenario,
            payload.archive_b64,
            JSON.stringify(payload.clues),
          ]
        );
      }
    } catch (e) {
      // Non-fatal — never block the response on a draft persist failure.
      console.warn('draft persist failed:', e.message);
    }

    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

/**
 * Premium ready-made case generator. Reuses the deterministic premium
 * fallback archive builder — no provider call, no env, no network. The
 * output ALWAYS satisfies the same schema + quality validation that the
 * AI chain output must satisfy, so the host can offer this as a fast
 * "كبسة جاهزة" alternative when the AI route feels slow.
 *
 * Privacy contract: identical to /ai-generate. archive_b64 is host-only
 * (returned for the host dashboard to seal). gameRole is never set by
 * this route.
 */
router.post('/premium-fallback', async (req, res, next) => {
  const start = Date.now();
  try {
    const { idea } = req.body || {};
    const counters = normalizeCustomCounters(req.body);
    if (!counters.ok) {
      return res.status(400).json({ error: counters.errors[0] });
    }
    const { players, clueCount, mafiozoCount } = counters.normalized;
    const archive = buildFallbackArchive({
      idea: typeof idea === 'string' ? idea : '',
      players, clueCount, mafiozoCount,
    });
    // Schema + quality gate. Premium fallback pools are sized so this
    // never fails, but we still verify so a future tweak to the pools
    // can't quietly slip past the gate.
    const reason = validateArchive(archive, {
      expectedClues: clueCount,
      expectedMafiozos: mafiozoCount,
      expectedCharacters: players,
      enforceQuality: true,
    });
    if (reason) {
      logAiGeneration({
        task: 'archive_premium_fallback',
        source: 'fallback',
        model: 'premium-deterministic',
        latencyMs: Date.now() - start,
        ok: false,
        validatorReason: reason,
      }).catch(() => {});
      return res.status(500).json({ error: 'تعذر تجهيز قضية جاهزة الآن، حاول مرة ثانية.' });
    }
    const payload = shapeArchiveResponse({
      source: 'fallback',
      model: 'premium-deterministic',
      archive,
    });
    logAiGeneration({
      task: 'archive_premium_fallback',
      source: 'fallback',
      model: 'premium-deterministic',
      latencyMs: Date.now() - start,
      ok: true,
      validatorReason: null,
    }).catch(() => {});
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

router.post('/ai-generate-three', async (req, res, next) => {
  try {
    const { idea, mood, difficulty } = req.body || {};
    const counters = normalizeCustomCounters(req.body);
    if (!counters.ok) return res.status(400).json({ error: counters.errors[0] });
    const { players, clueCount, mafiozoCount } = counters.normalized;
    // Run three in parallel for the scenario picker (they're independent).
    const promises = [0, 1, 2].map(i =>
      ai.generateSealedArchive({
        idea: idea ? `${idea} (نسخة ${i + 1})` : undefined,
        players, clueCount, mafiozoCount,
        mood, difficulty,
      })
    );
    const results = await Promise.all(promises);
    const options = results.map(shapeArchiveResponse);
    return res.json({
      success: true,
      source: options.every(o => o.source === 'gemini') ? 'gemini'
            : options.every(o => o.source === 'fallback') ? 'fallback'
            : 'mixed',
      options,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/narrate', async (req, res, next) => {
  try {
    const { phase, context, forbiddenTerms } = req.body || {};
    if (!phase) return res.status(400).json({ error: 'phase is required' });
    const result = await ai.narrate({
      phase,
      context: context || '',
      forbiddenTerms: Array.isArray(forbiddenTerms) ? forbiddenTerms : [],
    });
    return res.json({
      success: true,
      source: result.source,
      ...(result.model ? { model: result.model } : {}),
      line: result.line,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
