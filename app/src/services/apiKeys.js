/**
 * API keys of the public API (/api/v1).
 *
 * A key is 'grf_' plus 64 hex characters (32 random bytes). The database keeps
 * a bcrypt hash (organizations.api_key_hash) and a SHA-256 lookup value
 * (organizations.api_key_lookup). A request finds its organization with one
 * indexed query on the lookup value; a bcrypt compare per organization would
 * get slower with every organization that has a key. SHA-256 is enough here
 * because the key itself is random, not a password someone chose.
 *
 * Keys made before the lookup value existed are still found with bcrypt, and
 * get their lookup value the first time they are used.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../db/index.js';

/**
 * @param {string} apiKey
 * @returns {string} SHA-256 of the key, hex
 */
export function apiKeyLookup(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey), 'utf8').digest('hex');
}

/**
 * A new random API key with the values to store.
 * @returns {Promise<{apiKey: string, hash: string, lookup: string}>}
 */
export async function newApiKey() {
  const apiKey = 'grf_' + crypto.randomBytes(32).toString('hex');
  return { apiKey, hash: await bcrypt.hash(apiKey, 10), lookup: apiKeyLookup(apiKey) };
}

/**
 * The organization an API key belongs to.
 * @param {string} apiKey
 * @returns {Promise<{id: string, name: string, subscription_tier_id: number}|null>}
 */
export async function findOrganizationByApiKey(apiKey) {
  const lookup = apiKeyLookup(apiKey);
  const found = await query(
    'SELECT id, name, subscription_tier_id FROM organizations WHERE api_key_lookup = $1',
    [lookup]
  );
  if (found.rows[0]) return found.rows[0];

  // Keys from before the lookup value: compare with bcrypt, then store it
  const older = await query(
    'SELECT id, name, subscription_tier_id, api_key_hash FROM organizations WHERE api_key_hash IS NOT NULL AND api_key_lookup IS NULL'
  );
  for (const org of older.rows) {
    if (await bcrypt.compare(apiKey, org.api_key_hash)) {
      await query(
        'UPDATE organizations SET api_key_lookup = $1 WHERE id = $2 AND api_key_hash = $3',
        [lookup, org.id, org.api_key_hash]
      );
      return { id: org.id, name: org.name, subscription_tier_id: org.subscription_tier_id };
    }
  }
  return null;
}
