/**
 * Automation Sends Service
 * Each automation email goes out once per invitation and run through the
 * journey (table automation_sends), with an hourly cap per invitation.
 * Used by the player trigger route and the inactivity job in the scheduler.
 */

import crypto from 'crypto';
import { query } from '../db/index.js';

// Automation emails one invitation may send per hour, over all runs: a maker
// can allow unlimited completions, and complete + restart are player routes.
export const AUTOMATION_SENDS_PER_HOUR = 20;

/**
 * Identifies an automation for the once-per-run check. Automations have no id,
 * so this hashes their definition (a changed automation counts as a new one).
 * @param {Object} automation - The automation config from the step/journey
 * @param {string|null} stepId - The step it belongs to, null for journey-level
 */
export function getAutomationKey(automation, stepId) {
  return crypto.createHash('sha256').update(JSON.stringify([
    automation.trigger, stepId || null, automation.recipient || null,
    automation.template || null, automation.subject || null, automation.body || null
  ])).digest('hex');
}

/**
 * Claim an automation before sending it, so it goes out once even when the
 * same trigger arrives twice at the same time.
 * @returns {Promise<{id: string}|{skipped: 'rate_limited'|'already_sent'}>}
 */
export async function claimAutomationSend({ organizationId, invitationId, automation, stepId = null }) {
  const recent = await query(
    `SELECT COUNT(*)::int AS count FROM automation_sends
     WHERE invitation_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [invitationId]
  );
  if (recent.rows[0].count >= AUTOMATION_SENDS_PER_HOUR) {
    console.warn(`[Automation] Hourly cap reached for invitation ${invitationId}, skipping ${automation.trigger}`);
    return { skipped: 'rate_limited' };
  }

  const claim = await query(`
    INSERT INTO automation_sends (organization_id, invitation_id, automation_key, trigger, step_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (invitation_id, automation_key) WHERE cleared_at IS NULL DO NOTHING
    RETURNING id
  `, [organizationId, invitationId, getAutomationKey(automation, stepId), automation.trigger, stepId]);

  return claim.rows.length > 0 ? { id: claim.rows[0].id } : { skipped: 'already_sent' };
}

/**
 * Release a claim after a failed send, so a later trigger can try again
 */
export async function releaseAutomationSend(claimId) {
  await query('DELETE FROM automation_sends WHERE id = $1', [claimId]);
}

/**
 * A restart starts a new run: automations may go out again, but only after a
 * completed run. A restart halfway through keeps them marked as sent.
 * Call before the restart clears end_user_progress.completed_at.
 */
export async function closeAutomationRun(invitationId) {
  await query(`
    UPDATE automation_sends SET cleared_at = NOW()
    WHERE invitation_id = $1 AND cleared_at IS NULL
      AND EXISTS (SELECT 1 FROM end_user_progress WHERE invitation_id = $1 AND completed_at IS NOT NULL)
  `, [invitationId]);
}
