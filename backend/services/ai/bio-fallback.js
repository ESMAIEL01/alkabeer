/**
 * Deterministic Mafiozo-noir bio used when every AI provider fails.
 *
 * Pure helper — no env, no DB, no provider chain. Lives in its own
 * file so tests can import it without dragging in services/ai/index.js
 * (which transitively requires dotenv).
 */
const { BIO_MAX_LEN } = require('./validators');

function buildFallbackBio({ rawIdea, username } = {}) {
  // Hotfix — sanitize the user-supplied rawIdea defensively. The validator
  // already rejected hostile output, but this is the deterministic
  // fallback that ships when AI fails entirely; we shouldn't echo back
  // any raw idea content because we can't re-validate it here without
  // pulling the safe-content filter (kept dep-free on purpose). Strip
  // it and use a clean noir tail instead. The username is rendered
  // verbatim — usernames have already been validated at registration.
  const safeUser = (typeof username === 'string' && username.trim()) ? username.trim() : 'لاعب';
  const composed = `${safeUser} يدخل أرشيف مافيوزو كظل هادئ، يراقب التفاصيل الصغيرة ويترك الشك يمشي قبله. يدخل القضية بهدوء، ويسمع أكتر مما يتكلم.`;
  if (composed.length <= BIO_MAX_LEN) return composed;
  return composed.slice(0, BIO_MAX_LEN - 1).replace(/\s+\S*$/, '') + '…';
}

module.exports = { buildFallbackBio };
