/**
 * Single source of truth for environment configuration.
 * Loads .env, validates required values, and exposes a frozen config object.
 * Throws synchronously at boot if any required variable is missing or invalid.
 */
require('dotenv').config();

const REQUIRED_IN_ALL_ENVS = ['NODE_ENV', 'DATABASE_URL', 'JWT_SECRET'];
const REQUIRED_IN_PROD = ['FRONTEND_URL', 'GEMINI_API_KEY'];

const NODE_ENV = (process.env.NODE_ENV || 'development').toLowerCase();
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const missing = [];
for (const k of REQUIRED_IN_ALL_ENVS) if (!process.env[k]) missing.push(k);
if (isProd) for (const k of REQUIRED_IN_PROD) if (!process.env[k]) missing.push(k);

if (missing.length) {
  const msg = `Missing required environment variables: ${missing.join(', ')}`;
  console.error('\n❌ ' + msg);
  console.error('   Copy backend/.env.example to backend/.env and fill in real values.\n');
  throw new Error(msg);
}

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32 && isProd) {
  throw new Error('JWT_SECRET must be at least 32 characters in production. Generate one with: openssl rand -hex 64');
}

const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isProd,
  isTest,
  port: parseInt(process.env.PORT || '5000', 10),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  guestJwtExpiresIn: process.env.GUEST_JWT_EXPIRES_IN || '24h',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  // Comma-separated additional origins (for preview deployments, custom domains, etc.)
  extraCorsOrigins: (process.env.EXTRA_CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    archiveModel: process.env.GEMINI_ARCHIVE_MODEL || 'gemini-2.5-pro',
    // Internal Gemini fallback used when the primary archive model returns
    // a quota/rate-limit/availability error. Stays inside the "gemini" source
    // so callers can distinguish a Gemini-Flash success from an OpenRouter
    // fallback. Set to the same value as archiveModel to disable.
    archiveFallbackModel: process.env.GEMINI_ARCHIVE_FALLBACK_MODEL || 'gemini-2.5-flash',
    narrationModel: process.env.GEMINI_NARRATION_MODEL || 'gemini-2.5-flash',
    timeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS || '30000', 10),
    // Output-token ceilings. For Gemini 2.5 thinking models this budget covers
    // BOTH the hidden reasoning tokens AND the visible response — so an
    // archive call needs headroom (~8K) to finish the JSON without hitting
    // MAX_TOKENS. Narration is short and 1K is plenty.
    archiveMaxOutputTokens: parseInt(process.env.GEMINI_ARCHIVE_MAX_OUTPUT_TOKENS || '8192', 10),
    narrationMaxOutputTokens: parseInt(process.env.GEMINI_NARRATION_MAX_OUTPUT_TOKENS || '1024', 10),
  },
  // OpenRouter is an OPTIONAL secondary AI fallback. Never required at boot.
  // Enabled only when AI_FALLBACK_PROVIDER=openrouter AND a key is present.
  //
  // FixPack v2 / Commit 5: extra OpenRouter model slots so the archive
  // chain can attempt up to THREE OpenRouter models (primary fallback +
  // alternate1 + alternate2) before the deterministic built-in fallback
  // kicks in. Slots are blank by default so a misconfigured operator does
  // not pick up unknown model ids; set OPENROUTER_FALLBACK_MODEL_2 and/or
  // OPENROUTER_FALLBACK_MODEL_3 to enable each rung. Empty/blank rungs
  // are skipped silently — never error.
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    fallbackModel: process.env.OPENROUTER_FALLBACK_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free',
    fallbackModel2: process.env.OPENROUTER_FALLBACK_MODEL_2 || '',
    fallbackModel3: process.env.OPENROUTER_FALLBACK_MODEL_3 || '',
    timeoutMs: parseInt(process.env.OPENROUTER_TIMEOUT_MS || '30000', 10),
    // Output-token ceilings. Nemotron has no hidden thinking budget so all
    // tokens are visible output. A full Arabic JSON archive can need ~5K
    // because Arabic letters cost more tokens than Latin.
    archiveMaxTokens: parseInt(process.env.OPENROUTER_ARCHIVE_MAX_TOKENS || '6000', 10),
    narrationMaxTokens: parseInt(process.env.OPENROUTER_NARRATION_MAX_TOKENS || '800', 10),
    enabled:
      ((process.env.AI_FALLBACK_PROVIDER || '').toLowerCase() === 'openrouter') &&
      !!process.env.OPENROUTER_API_KEY,
  },
  rateLimit: {
    authWindowMs: parseInt(process.env.AUTH_RATE_WINDOW_MS || '900000', 10), // 15 min
    authMax: parseInt(process.env.AUTH_RATE_MAX || '20', 10),
    aiWindowMs: parseInt(process.env.AI_RATE_WINDOW_MS || '60000', 10), // 1 min
    aiMax: parseInt(process.env.AI_RATE_MAX || '6', 10),
  },
});

if (!isTest) {
  console.log(`🔧 Environment: ${config.nodeEnv}`);
  console.log(`🔧 Frontend origin: ${config.frontendUrl}`);
  console.log(`🔧 AI archive model: ${config.gemini.archiveModel} (fallback: ${config.gemini.archiveFallbackModel})`);
  if (!config.gemini.apiKey) {
    console.warn('⚠️  GEMINI_API_KEY is not set — AI features will fall back to a built-in scenario.');
  }
  // Log presence/absence only — never the key itself.
  console.log(`🔧 OpenRouter fallback: ${config.openrouter.enabled ? 'enabled (' + config.openrouter.fallbackModel + ')' : 'disabled'}`);
}

module.exports = config;
