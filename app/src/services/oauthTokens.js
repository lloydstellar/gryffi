/**
 * Encryption of OAuth tokens at rest (Google Workspace and Microsoft 365 sync)
 *
 * Tokens are stored as "enc:v1:<iv>:<tag>:<ciphertext>" (base64url, AES-256-GCM).
 * The key comes from OAUTH_TOKEN_KEY: 32 bytes, as 64 hex characters or base64.
 * Generate one with: openssl rand -hex 32
 *
 * Values without the prefix are plaintext tokens from before encryption.
 * decryptToken() still accepts them, and encryptStoredTokens() converts them
 * at startup and every hour (a restored backup can bring them back).
 * Losing the key means organizations have to reconnect.
 */

import crypto from 'crypto';
import { query } from '../db/index.js';

const PREFIX = 'enc:v1:';

// Token columns on organizations
const TOKEN_COLUMNS = [
  'google_access_token',
  'google_refresh_token',
  'microsoft_access_token',
  'microsoft_refresh_token'
];

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const raw = (process.env.OAUTH_TOKEN_KEY || '').trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else if (raw) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) key = decoded;
  }
  if (!key) {
    throw new Error('OAUTH_TOKEN_KEY is missing or not 32 bytes (use: openssl rand -hex 32)');
  }
  cachedKey = key;
  return key;
}

/**
 * True when OAUTH_TOKEN_KEY holds a usable key
 */
export function isTokenEncryptionConfigured() {
  try {
    getKey();
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Encrypt a token for storage. null/undefined stay null.
 */
export function encryptToken(value) {
  if (value === null || value === undefined || value === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map(b => b.toString('base64url')).join(':');
}

/**
 * Decrypt a stored token. Plaintext from before encryption is returned as is.
 */
export function decryptToken(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!String(value).startsWith(PREFIX)) return value;
  const parts = String(value).slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Stored OAuth token has an invalid format');
  }
  const [iv, tag, ciphertext] = parts.map(p => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function encryptColumn(column) {
  const result = await query(
    `SELECT id, ${column} AS value FROM organizations
     WHERE ${column} IS NOT NULL AND ${column} NOT LIKE 'enc:v1:%'`
  );
  let count = 0;
  for (const row of result.rows) {
    // Only replace the value we read, so a token refreshed in the meantime is kept
    const updated = await query(
      `UPDATE organizations SET ${column} = $1 WHERE id = $2 AND ${column} = $3`,
      [encryptToken(row.value), row.id, row.value]
    );
    count += updated.rowCount;
  }
  return count;
}

/**
 * Encrypt every plaintext token still in the database. Safe to run repeatedly.
 * Column names come from TOKEN_COLUMNS, never from input.
 */
export async function encryptStoredTokens() {
  if (!isTokenEncryptionConfigured()) {
    console.error('[OAuth Tokens] OAUTH_TOKEN_KEY is not set: Google and Microsoft sync cannot store tokens');
    return;
  }
  try {
    let total = 0;
    for (const column of TOKEN_COLUMNS) {
      total += await encryptColumn(column);
    }
    if (total > 0) {
      console.log(`[OAuth Tokens] Encrypted ${total} stored token(s)`);
    }
  } catch (err) {
    console.error('[OAuth Tokens] Encrypting stored tokens failed:', err);
  }
}
