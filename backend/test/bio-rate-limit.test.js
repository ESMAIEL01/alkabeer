/**
 * D5a — regression pin for the AI bio writer rate limit.
 *
 * Importing routes/profile.js in the local sandbox pulls in express +
 * dotenv + database + services/ai (chain dependencies that npm install
 * is forbidden from materializing here). To keep the rate-limit wiring
 * test runnable without those deps, this file does a static-source
 * inspection of routes/profile.js — pinning the canonical wiring
 * shape that production must keep:
 *
 *   router.post('/bio/ai', authRequired, aiLimiter, async (req, res, next) => { ... }
 *
 * If a future edit moves middleware out of order, removes aiLimiter,
 * or forgets to import it from middleware/rateLimit, this test fails
 * before the change can land. CI's npm test (with full deps installed)
 * also exercises the route through the regular Express stack.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROFILE_ROUTE_PATH = path.join(__dirname, '..', 'routes', 'profile.js');
const RATELIMIT_PATH     = path.join(__dirname, '..', 'middleware', 'rateLimit.js');

function readFileSafe(p) {
  return fs.readFileSync(p, 'utf8');
}

test('rateLimit module exports an aiLimiter', () => {
  const src = readFileSafe(RATELIMIT_PATH);
  assert.match(src, /aiLimiter/, 'aiLimiter symbol must exist in middleware/rateLimit.js');
  assert.match(src, /module\.exports[^}]*aiLimiter/, 'aiLimiter must be in module.exports');
});

test('routes/profile.js imports aiLimiter from middleware/rateLimit', () => {
  const src = readFileSafe(PROFILE_ROUTE_PATH);
  assert.match(
    src,
    /require\(\s*['"]\.\.\/middleware\/rateLimit['"]\s*\)/,
    'profile.js must require ../middleware/rateLimit'
  );
  assert.match(
    src,
    /\baiLimiter\b/,
    'profile.js must reference the aiLimiter symbol after import'
  );
});

test('POST /bio/ai applies authRequired then aiLimiter, in that order', () => {
  const src = readFileSafe(PROFILE_ROUTE_PATH);
  // Tolerate single OR double quotes around '/bio/ai' and arbitrary whitespace.
  const re = /router\s*\.\s*post\s*\(\s*['"]\/bio\/ai['"]\s*,\s*authRequired\s*,\s*aiLimiter\s*,/;
  assert.match(
    src,
    re,
    'router.post("/bio/ai", authRequired, aiLimiter, ...) wiring must be present and in this order'
  );
});

test('POST /bio/ai is the only AI-cost route on the profile router (defensive boundary)', () => {
  // Ensure no future edit accidentally adds another AI-burning POST under
  // /api/profile without the limiter. Today only /bio/ai exists.
  const src = readFileSafe(PROFILE_ROUTE_PATH);
  const aiPostMatches = src.match(/router\s*\.\s*post\s*\(\s*['"][^'"]*ai[^'"]*['"]/gi) || [];
  assert.equal(aiPostMatches.length, 1, `expected exactly one AI-named POST route, found ${aiPostMatches.length}: ${aiPostMatches.join(', ')}`);
});
