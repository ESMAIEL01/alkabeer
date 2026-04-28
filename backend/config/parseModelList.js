/**
 * parseModelList — pure helper that parses comma-separated model lists
 * from environment variables (e.g. OPENROUTER_ARCHIVE_MODELS).
 *
 * Behavior:
 *   - Trims whitespace around each entry.
 *   - Drops empty entries.
 *   - Drops duplicates while preserving FIRST-occurrence order.
 *   - Returns [] for null/undefined/empty/whitespace-only input.
 *
 * No dependencies — safe to import from tests that run without dotenv
 * installed locally.
 */
function parseModelList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const seen = new Set();
  const out = [];
  for (const part of raw.split(',')) {
    const m = part.trim();
    if (!m) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * uniqueModelList — defensive de-duplicator for arrays already supplied
 * by callers. Preserves order of first occurrence; drops blanks.
 */
function uniqueModelList(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    if (typeof m !== 'string') continue;
    const t = m.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

module.exports = { parseModelList, uniqueModelList };
