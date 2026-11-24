/**
 * Magic-link tokens of invitations
 *
 * The database keeps two things per invitation, never the token itself:
 * - token_hash: SHA-256 of the token, to find the invitation by the token in
 *   the link. In SQL: token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')
 * - token_encrypted: the token encrypted with OAUTH_TOKEN_KEY (oauthTokens.js),
 *   for emails that repeat the link later: the reminder and "continue" after
 *   inactivity.
 * A copy of the database or a backup without the .env opens no journey.
 * Invitations from before this change had the token in plain text (token);
 * protectStoredInvitationTokens() converts them when Gryffi starts, and
 * removes the plain token an hour later (see there why not at once).
 */

import crypto from 'crypto';
import { query } from '../db/index.js';
import { encryptToken, decryptToken } from './oauthTokens.js';

/**
 * SHA-256 of a token as 64 hex characters (the same as the SQL above)
 */
export function hashInvitationToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * A new token with what the database stores for it
 * @param {'base64url'|'hex'} encoding - how the 32 random bytes are written
 * @returns {{ token: string, tokenHash: string, tokenEncrypted: string }}
 */
export function newInvitationToken(encoding = 'base64url') {
  const token = crypto.randomBytes(32).toString(encoding);
  return { token, tokenHash: hashInvitationToken(token), tokenEncrypted: encryptToken(token) };
}

/**
 * The token of an invitation row (token_encrypted, or token from before the
 * change), to put in an email. Null when there is none.
 */
export function invitationToken(row) {
  if (row?.token_encrypted) return decryptToken(row.token_encrypted);
  return row?.token || null;
}

/**
 * Give plain-text tokens their hash and encrypted copy, and optionally remove
 * the plain token. Safe to run more than once and from several processes: a
 * row is only changed while it still holds the token that was read.
 *
 * At start the plain token stays (removePlain false). If the new version does
 * not become healthy, the update command of the Community Edition goes back
 * to the previous version without restoring the database, and a version from
 * before this change only knows the plain token. The scheduler removes it on
 * its hourly run, when an update has long succeeded or been rolled back.
 * A row without an encrypted copy (the migration only sets the hash), or whose
 * hash does not match its plain token (a token changed by an older version
 * after a rollback), gets a new hash and encrypted copy.
 * @param {{ removePlain?: boolean }} [options]
 * @returns {Promise<{ converted: number, removed: number }>}
 */
export async function protectStoredInvitationTokens({ removePlain = false } = {}) {
  let converted = 0;
  for (;;) {
    const result = await query(
      `SELECT id, token FROM invitations
       WHERE token IS NOT NULL
         AND (token_encrypted IS NULL OR token_hash IS DISTINCT FROM encode(sha256(convert_to(token, 'UTF8')), 'hex'))
       ORDER BY created_at LIMIT 200`
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      const updated = await query(
        'UPDATE invitations SET token_hash = $1, token_encrypted = $2 WHERE id = $3 AND token = $4',
        [hashInvitationToken(row.token), encryptToken(row.token), row.id, row.token]
      );
      converted += updated.rowCount;
    }
    // Rows that changed in between are picked up by the next run
    if (result.rows.length < 200) break;
  }
  let removed = 0;
  if (removePlain) {
    const result = await query(
      `UPDATE invitations SET token = NULL
       WHERE token IS NOT NULL AND token_encrypted IS NOT NULL
         AND token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')`
    );
    removed = result.rowCount;
  }
  return { converted, removed };
}

/**
 * Before a rollback to a version from before this change: write the tokens
 * back in plain text, so the links in sent emails keep working there.
 * @returns {Promise<number>} number of invitations restored
 */
export async function restoreInvitationTokens() {
  const result = await query('SELECT id, token_encrypted FROM invitations WHERE token IS NULL AND token_encrypted IS NOT NULL');
  let restored = 0;
  for (const row of result.rows) {
    const updated = await query('UPDATE invitations SET token = $1 WHERE id = $2 AND token IS NULL', [decryptToken(row.token_encrypted), row.id]);
    restored += updated.rowCount;
  }
  return restored;
}
