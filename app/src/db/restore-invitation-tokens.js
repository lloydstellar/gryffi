/**
 * Restore magic-link tokens in plain text, before a rollback
 *
 * Since magic-link tokens are stored as a hash and an encrypted copy
 * (services/invitationTokens.js), a version from before that change can no
 * longer find invitations, and every link in sent emails would stop working
 * after a rollback. Run this first, while the current version still runs:
 *
 *   docker exec gryffi-app node src/db/restore-invitation-tokens.js
 *
 * It writes the tokens back from the encrypted copy (OAUTH_TOKEN_KEY). The
 * current version keeps working and converts them again within the hour.
 */

import 'dotenv/config';
import pool from './index.js';
import { restoreInvitationTokens } from '../services/invitationTokens.js';

try {
  const restored = await restoreInvitationTokens();
  console.log(`Restored the plain-text token of ${restored} invitation(s).`);
  await pool.end();
  process.exit(0);
} catch (err) {
  console.error('Restoring the tokens failed:', err.message);
  process.exit(1);
}
