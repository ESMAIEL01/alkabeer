/**
 * Deterministic Mafiozo-noir bio used when every AI provider fails.
 *
 * Pure helper — no env, no DB, no provider chain. Lives in its own
 * file so tests can import it without dragging in services/ai/index.js
 * (which transitively requires dotenv).
 */
const { BIO_MAX_LEN } = require('./validators');

function buildFallbackBio({ rawIdea, username } = {}) {
  const safeUser = (typeof username === 'string' && username.trim()) ? username.trim() : 'لاعب';
  const safeIdea = (typeof rawIdea === 'string' ? rawIdea.trim() : '').slice(0, 220);
  const tail = safeIdea ? ` ${safeIdea}` : ' يدخل القضية بهدوء، ويسمع أكتر مما يتكلم.';
  const composed = `${safeUser} يدخل أرشيف Mafiozo كظل هادئ، يراقب التفاصيل الصغيرة ويترك الشك يمشي قبله.${tail}`;
  if (composed.length <= BIO_MAX_LEN) return composed;
  return composed.slice(0, BIO_MAX_LEN - 1).replace(/\s+\S*$/, '') + '…';
}

module.exports = { buildFallbackBio };
