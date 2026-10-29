/**
 * Installation settings
 *
 * One place for the configuration an administrator can change at runtime: AI
 * provider and models, email, integrations, optional features. A value comes
 * from, in this order:
 *
 *   1. the instance_settings table (set in the setup wizard or admin settings)
 *   2. the environment variable named in the registry below
 *   3. the registry default
 *
 * Gryffi Cloud leaves the table empty and keeps using .env, so nothing changes
 * there. The Community Edition stores everything in the table.
 *
 * Secrets are stored encrypted (enc:v1:..., AES-256-GCM with the key from
 * OAUTH_TOKEN_KEY) and are never sent to the browser unmasked. Every change is
 * written to instance_settings_audit, with secrets masked.
 */

import { query, getClient } from '../db/index.js';
import { encryptToken, decryptToken, isTokenEncryptionConfigured } from './oauthTokens.js';

// How long a process trusts its cached copy of the table. A change made in
// this process clears the cache at once; other cluster workers follow within
// this time.
const CACHE_TTL_MS = 10 * 1000;

const MAX_STRING_LENGTH = 4000;

/**
 * Every setting the application knows. A key that is not listed here cannot be
 * read or written.
 *
 * type:    'string' | 'boolean' | 'number' | 'enum' | 'url' | 'email'
 * secret:  stored encrypted, masked when shown
 * env:     environment variable used when the table has no value
 * default: value when neither the table nor the environment has one
 * internal: used by the application only, left out of describeSettings()
 */
export const SETTINGS = Object.freeze({
  // AI: any OpenAI-compatible API (Mistral, OpenAI, Azure OpenAI, OpenRouter, Ollama, vLLM)
  'ai.enabled': { type: 'boolean', default: true },
  'ai.baseUrl': { type: 'url', env: 'AI_BASE_URL', default: 'https://api.mistral.ai/v1' },
  'ai.apiKey': { type: 'string', secret: true, env: 'MISTRAL_API_KEY' },
  'ai.chatModel': { type: 'string', env: 'MISTRAL_MODEL', default: 'mistral-small-latest' },
  'ai.fallbackModel': { type: 'string', env: 'MISTRAL_MODEL_FALLBACK', default: 'mistral-small-latest' },
  'ai.classifierModel': { type: 'string', env: 'MISTRAL_CLASSIFIER_MODEL', default: 'mistral-small-latest' },
  'ai.visionModel': { type: 'string', env: 'MISTRAL_VISION_MODEL', default: 'mistral-large-latest' },
  // Embeddings may use a different provider than chat (OpenRouter, for one, has no
  // embeddings). Without these, the chat address and key are used.
  'ai.embeddingBaseUrl': { type: 'url', env: 'AI_EMBEDDING_BASE_URL' },
  'ai.embeddingApiKey': { type: 'string', secret: true, env: 'OPENAI_API_KEY' },
  'ai.embeddingModel': { type: 'string', env: 'AI_EMBEDDING_MODEL' },
  'ai.ttsModel': { type: 'string', env: 'TTS_VOXTRAL_MODEL', default: 'voxtral-mini-tts-2603' },
  'ai.ttsVoice': { type: 'string', env: 'TTS_VOXTRAL_VOICE' },
  'ai.monthlyQuestionLimit': { type: 'number', min: 0, default: null },
  // Features that need their own model; off when no suitable model is configured
  'ai.imageAnalysis': { type: 'boolean', default: true },
  'ai.speech': { type: 'boolean', default: true },

  // Email
  'email.provider': { type: 'enum', options: ['nuntly', 'smtp'], env: 'EMAIL_PROVIDER', default: 'nuntly' },
  'email.from': { type: 'string', env: 'NUNTLY_FROM_EMAIL', default: 'Gryffi <noreply@gryffi.com>' },
  'email.nuntlyApiKey': { type: 'string', secret: true, env: 'NUNTLY_API_KEY' },
  'email.smtpHost': { type: 'string', env: 'SMTP_HOST' },
  'email.smtpPort': { type: 'number', min: 1, max: 65535, env: 'SMTP_PORT', default: 587 },
  'email.smtpSecurity': { type: 'enum', options: ['starttls', 'tls', 'none'], env: 'SMTP_SECURITY', default: 'starttls' },
  'email.smtpUser': { type: 'string', env: 'SMTP_USER' },
  'email.smtpPassword': { type: 'string', secret: true, env: 'SMTP_PASSWORD' },

  // Integrations
  'pexels.apiKey': { type: 'string', secret: true, env: 'PEXELS_API_KEY' },
  'google.clientId': { type: 'string', env: 'GOOGLE_CLIENT_ID' },
  'google.clientSecret': { type: 'string', secret: true, env: 'GOOGLE_CLIENT_SECRET' },
  'microsoft.clientId': { type: 'string', env: 'MICROSOFT_CLIENT_ID' },
  'microsoft.clientSecret': { type: 'string', secret: true, env: 'MICROSOFT_CLIENT_SECRET' },

  // Optional features
  'nsfw.enabled': { type: 'boolean', default: true },
  // Document parser container (unstructured) for PDF, Word and PowerPoint.
  // Text, Markdown, CSV and Excel are always read without it.
  'documents.parserEnabled': { type: 'boolean', env: 'PARSER_ENABLED', default: true },
  'branding.poweredBy': { type: 'boolean', default: true },

  // Installation
  'setup.completed': { type: 'boolean', default: false },
  // SHA-256 of the one-time setup code and when it expires (ISO time); never shown
  'setup.codeHash': { type: 'string', internal: true },
  'setup.codeExpiresAt': { type: 'string', internal: true },
  'updates.check': { type: 'boolean', default: true }
});

let cache = null;
let cacheLoadedAt = 0;
let loading = null;
let generation = 0;

/**
 * Raised for a value that does not fit its setting. `key` names the setting.
 */
export class SettingValidationError extends Error {
  constructor(key, message) {
    super(message);
    this.name = 'SettingValidationError';
    this.key = key;
  }
}

function definitionOf(key) {
  const definition = Object.prototype.hasOwnProperty.call(SETTINGS, key) ? SETTINGS[key] : null;
  if (!definition) {
    throw new SettingValidationError(key, `Unknown setting: ${key}`);
  }
  return definition;
}

/**
 * Turn a raw value (from a form, JSON or an environment variable) into the
 * setting's type, or throw a SettingValidationError.
 * @returns {*} The normalized value; null clears the setting
 */
export function normalizeSetting(key, raw) {
  const definition = definitionOf(key);
  if (raw === null || raw === undefined || raw === '') return null;

  switch (definition.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const text = String(raw).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) return true;
      if (['false', '0', 'no', 'off'].includes(text)) return false;
      throw new SettingValidationError(key, `${key} must be true or false`);
    }
    case 'number': {
      const number = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(number)) {
        throw new SettingValidationError(key, `${key} must be a number`);
      }
      if (definition.min !== undefined && number < definition.min) {
        throw new SettingValidationError(key, `${key} must be at least ${definition.min}`);
      }
      if (definition.max !== undefined && number > definition.max) {
        throw new SettingValidationError(key, `${key} must be at most ${definition.max}`);
      }
      return number;
    }
    case 'enum': {
      const text = String(raw).trim();
      if (!definition.options.includes(text)) {
        throw new SettingValidationError(key, `${key} must be one of: ${definition.options.join(', ')}`);
      }
      return text;
    }
    case 'url': {
      const text = String(raw).trim();
      let url;
      try {
        url = new URL(text);
      } catch {
        throw new SettingValidationError(key, `${key} must be a full URL, for example https://api.mistral.ai/v1`);
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new SettingValidationError(key, `${key} must start with http:// or https://`);
      }
      return text.replace(/\/+$/, '');
    }
    case 'email': {
      const text = String(raw).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        throw new SettingValidationError(key, `${key} must be an email address`);
      }
      return text;
    }
    default: {
      const text = String(raw).trim();
      if (text.length > MAX_STRING_LENGTH) {
        throw new SettingValidationError(key, `${key} is longer than ${MAX_STRING_LENGTH} characters`);
      }
      return text;
    }
  }
}

/**
 * Show a secret as its last four characters, enough to recognize it.
 * @param {string|null} value
 * @returns {string|null}
 */
export function maskSecret(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  return text.length <= 8 ? '••••' : `••••${text.slice(-4)}`;
}

function encode(definition, value) {
  const json = JSON.stringify(value);
  return definition.secret ? encryptToken(json) : json;
}

function decode(key, definition, stored) {
  try {
    return JSON.parse(definition.secret ? decryptToken(stored) : stored);
  } catch (err) {
    // An unreadable value (wrong key, damaged row) counts as not set
    console.error(`[Settings] Could not read stored value for ${key}:`, err.message);
    return null;
  }
}

async function loadStoredValues() {
  if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;
  // Readers that arrive while the table loads share that one query. A load
  // that started before a change (generation) is used once, not cached.
  if (!loading) {
    const started = generation;
    loading = (async () => {
      const result = await query('SELECT key, value FROM instance_settings');
      const values = new Map();
      for (const row of result.rows) {
        const definition = SETTINGS[row.key];
        if (definition) values.set(row.key, decode(row.key, definition, row.value));
      }
      if (started === generation) {
        cache = values;
        cacheLoadedAt = Date.now();
      }
      return values;
    })().finally(() => {
      if (started === generation) loading = null;
    });
  }
  return loading;
}

/**
 * Forget the cached table, so the next read sees the database.
 */
export function invalidateSettingsCache() {
  cache = null;
  cacheLoadedAt = 0;
  generation++;
  loading = null;
}

function fromEnvironment(key, definition) {
  if (!definition.env) return null;
  const raw = process.env[definition.env];
  if (raw === undefined || raw === '') return null;
  try {
    return normalizeSetting(key, raw);
  } catch (err) {
    console.warn(`[Settings] Ignoring ${definition.env}: ${err.message}`);
    return null;
  }
}

/**
 * Read one setting.
 * @param {string} key - A key from SETTINGS
 * @returns {Promise<*>} The value, or null when it is not set anywhere
 */
export async function getSetting(key) {
  const definition = definitionOf(key);
  const stored = await loadStoredValues();
  const value = stored.has(key) ? stored.get(key) : null;
  if (value !== null) return value;
  const fromEnv = fromEnvironment(key, definition);
  if (fromEnv !== null) return fromEnv;
  return definition.default ?? null;
}

/**
 * Read several settings at once.
 * @param {string[]} keys
 * @returns {Promise<Object<string, *>>}
 */
export async function getSettings(keys) {
  const entries = await Promise.all(keys.map(async (key) => [key, await getSetting(key)]));
  return Object.fromEntries(entries);
}

/**
 * Every setting with its value and where the value comes from, for the admin
 * settings page. Secrets are masked.
 * @returns {Promise<Array<{key: string, type: string, secret: boolean, value: *, source: 'database'|'environment'|'default'|'unset'}>>}
 */
export async function describeSettings() {
  const stored = await loadStoredValues();
  return Object.entries(SETTINGS).filter(([, definition]) => !definition.internal).map(([key, definition]) => {
    let value = stored.has(key) ? stored.get(key) : null;
    let source = value !== null ? 'database' : 'unset';
    if (value === null) {
      value = fromEnvironment(key, definition);
      if (value !== null) source = 'environment';
    }
    if (value === null && definition.default !== undefined && definition.default !== null) {
      value = definition.default;
      source = 'default';
    }
    return {
      key,
      type: definition.type,
      secret: !!definition.secret,
      options: definition.options,
      value: definition.secret ? maskSecret(value) : value,
      source
    };
  });
}

/**
 * Store settings, all or none. A null value deletes the stored value, so the
 * environment or the default applies again.
 * @param {Object<string, *>} values - key/value pairs from the form or wizard
 * @param {{userId?: string|null}} [options]
 * @returns {Promise<string[]>} The keys that changed
 */
export async function setSettings(values, { userId = null } = {}) {
  const normalized = Object.entries(values).map(([key, raw]) => [key, definitionOf(key), normalizeSetting(key, raw)]);

  if (normalized.some(([, definition, value]) => definition.secret && value !== null) && !isTokenEncryptionConfigured()) {
    throw new SettingValidationError(null, 'Secrets cannot be stored: OAUTH_TOKEN_KEY is not set (generate one with: openssl rand -hex 32)');
  }

  const client = await getClient();
  const changed = [];
  try {
    await client.query('BEGIN');
    for (const [key, definition, value] of normalized) {
      const current = await client.query('SELECT value FROM instance_settings WHERE key = $1 FOR UPDATE', [key]);
      const oldValue = current.rows.length ? decode(key, definition, current.rows[0].value) : null;
      if (JSON.stringify(oldValue) === JSON.stringify(value)) continue;

      if (value === null) {
        await client.query('DELETE FROM instance_settings WHERE key = $1', [key]);
      } else {
        await client.query(
          `INSERT INTO instance_settings (key, value, updated_at, updated_by)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [key, encode(definition, value), userId]
        );
      }

      const shown = (v) => (v === null ? null : JSON.stringify(definition.secret ? maskSecret(v) : v));
      await client.query(
        'INSERT INTO instance_settings_audit (key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4)',
        [key, shown(oldValue), shown(value), userId]
      );
      changed.push(key);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    invalidateSettingsCache();
  }
  return changed;
}
