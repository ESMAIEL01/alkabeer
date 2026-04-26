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
 *   POST /api/scenarios/narrate     (auth optional)
 *     body: { phase, context }
 *     -> { success, line }
 *
 * Errors are normalized to JSON: { error: "<arabic message>" }
 */
const express = require('express');
const ai = require('../services/ai');
const { query } = require('../database');

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

router.post('/ai-generate', async (req, res, next) => {
  try {
    const { idea, players, mood, difficulty } = req.body || {};
    const result = await ai.generateSealedArchive({ idea, players, mood, difficulty });
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

router.post('/ai-generate-three', async (req, res, next) => {
  try {
    const { idea, players, mood, difficulty } = req.body || {};
    // Run three in parallel for the scenario picker (they're independent).
    const promises = [0, 1, 2].map(i =>
      ai.generateSealedArchive({
        idea: idea ? `${idea} (نسخة ${i + 1})` : undefined,
        players,
        mood,
        difficulty,
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
