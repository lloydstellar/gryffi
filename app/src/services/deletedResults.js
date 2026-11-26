/**
 * Deleted Results Service
 * Results (progress, quiz scores, poll votes, form submissions, rewards,
 * video and form statistics) stay in Analytics after their journey or step is
 * deleted. Only an admin removes them for good, in Analytics.
 *
 * - A journey that leaves the trash for good keeps its row (purged_at set,
 *   deleted_at stays set) when it has results, so it stays hidden everywhere
 *   except in Analytics with "Show deleted journeys and steps" on.
 * - A deleted step with results leaves a copy in deleted_steps under its old
 *   id. The result tables keep that step_id (they have no foreign key to
 *   steps), and the view analytics_steps shows both. A step id is only
 *   unique among live steps, so results are always matched on step_id AND
 *   journey_id.
 *
 * Results still go with the participant, the invitation and the organization
 * (GDPR), and with the data retention rules of the scheduler.
 */

import { query, getClient } from '../db/index.js';
import { removeFormFiles } from './formSubmissions.js';

// Tables with one row per result of a step (all have step_id and journey_id)
const STEP_RESULT_TABLES = [
  'quiz_attempts',
  'video_watch_sessions',
  'form_analytics',
  'public_poll_responses',
  'public_form_submissions',
  'public_reward_claims',
  'private_form_submissions',
  'journey_events'
];

/**
 * Analytics shows results of deleted journeys and steps only when the maker
 * turns on "Show deleted journeys and steps" (query include_deleted=1).
 * @param {import('express').Request} req
 */
export function wantsDeleted(req) {
  return req.query?.include_deleted === '1';
}

/**
 * SQL condition for Analytics queries: leaves out the results of deleted
 * steps and of journeys deleted for good, unless the boolean parameter is
 * true. `alias` is a code constant (a table alias with journey_id and, with
 * hasStep, step_id), `param` a placeholder such as '$3'.
 * @param {string} alias
 * @param {string} param
 * @param {{ hasStep?: boolean }} [options]
 */
export function liveResultsSql(alias, param, { hasStep = true } = {}) {
  const journeyPart = `NOT EXISTS (SELECT 1 FROM journeys pj WHERE pj.id = ${alias}.journey_id AND pj.purged_at IS NOT NULL)`;
  const stepPart = hasStep ? ` AND NOT EXISTS (SELECT 1 FROM deleted_steps ds WHERE ds.id = ${alias}.step_id AND ds.journey_id = ${alias}.journey_id)` : '';
  return `(${param}::boolean OR (${journeyPart}${stepPart}))`;
}

/**
 * True when the step has results that Analytics shows.
 * @param {string} stepId
 * @param {string} journeyId - the journey of the step
 * @param {string} orgId
 */
export async function stepHasResults(stepId, journeyId, orgId) {
  const checks = STEP_RESULT_TABLES.map((table) => `EXISTS (SELECT 1 FROM ${table} WHERE step_id = $1 AND journey_id = $2)`);
  checks.push('EXISTS (SELECT 1 FROM poll_responses pr JOIN polls p ON p.id = pr.poll_id WHERE p.step_id = $1 AND p.organization_id = $3)');
  checks.push('EXISTS (SELECT 1 FROM reward_codes rc JOIN rewards r ON r.id = rc.reward_id WHERE r.step_id = $1 AND r.organization_id = $3 AND rc.is_claimed = true)');
  const result = await query(`SELECT (${checks.join(' OR ')}) AS has_results`, [stepId, journeyId, orgId]);
  return result.rows[0]?.has_results === true;
}

/**
 * True when the journey has results: invitations, public participants or
 * anything recorded per step.
 * @param {string} journeyId
 */
export async function journeyHasResults(journeyId) {
  const checks = [
    'EXISTS (SELECT 1 FROM invitations WHERE journey_id = $1)',
    'EXISTS (SELECT 1 FROM public_participants WHERE journey_id = $1)',
    ...STEP_RESULT_TABLES.map((table) => `EXISTS (SELECT 1 FROM ${table} WHERE journey_id = $1)`),
    'EXISTS (SELECT 1 FROM rewards WHERE journey_id = $1 AND is_archived = true)'
  ];
  const result = await query(`SELECT (${checks.join(' OR ')}) AS has_results`, [journeyId]);
  return result.rows[0]?.has_results === true;
}

/**
 * Keep a copy of a step that is about to be deleted, when it has results.
 * Call before DELETE FROM steps. A poll of the step is archived like the
 * polls of a journey in the trash.
 * @param {string} stepId
 * @param {string} orgId
 * @returns {Promise<boolean>} true when a copy was kept
 */
export async function keepDeletedStep(stepId, orgId) {
  const step = await query(
    'SELECT s.journey_id FROM steps s JOIN journeys j ON j.id = s.journey_id WHERE s.id = $1 AND j.organization_id = $2',
    [stepId, orgId]
  );
  if (step.rows.length === 0) return false;
  if (!(await stepHasResults(stepId, step.rows[0].journey_id, orgId))) return false;

  await query(`
    INSERT INTO deleted_steps (id, journey_id, organization_id, type, title, basic_props, advanced_props, deleted_at)
    SELECT s.id, s.journey_id, j.organization_id, s.type, s.title, s.basic_props, s.advanced_props, NOW()
    FROM steps s
    JOIN journeys j ON j.id = s.journey_id
    WHERE s.id = $1 AND j.organization_id = $2
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title, type = EXCLUDED.type,
      basic_props = EXCLUDED.basic_props, advanced_props = EXCLUDED.advanced_props,
      deleted_at = EXCLUDED.deleted_at
  `, [stepId, orgId]);

  await query(`
    UPDATE polls p SET
      is_archived = true,
      archived_at = COALESCE(p.archived_at, NOW()),
      archived_question = s.basic_props->>'question',
      archived_options = COALESCE(s.basic_props->'options', '[]'::jsonb),
      archived_journey_title = j.title,
      updated_at = NOW()
    FROM steps s
    JOIN journeys j ON j.id = s.journey_id
    WHERE p.step_id = s.id AND s.id = $1 AND j.organization_id = $2
  `, [stepId, orgId]);

  return true;
}

/**
 * A step that comes back under the same id in its own journey (undo in the
 * builder) gets its results back: its copy in deleted_steps goes, the results
 * never left.
 * @param {string} stepId
 * @param {string} journeyId
 * @param {string} orgId
 */
export async function forgetDeletedStep(stepId, journeyId, orgId) {
  await query('DELETE FROM deleted_steps WHERE id = $1 AND journey_id = $2 AND organization_id = $3', [stepId, journeyId, orgId]);
  await query(`
    UPDATE polls SET is_archived = false, archived_at = NULL, updated_at = NOW()
    WHERE step_id = $1 AND organization_id = $2 AND is_archived = true
  `, [stepId, orgId]);
}

/**
 * Delete a journey from the trash for good. With results it stays as a
 * hidden row for Analytics; without results it is removed.
 * @param {string} journeyId
 * @param {string} orgId
 * @returns {Promise<'kept'|'deleted'>}
 */
export async function purgeJourney(journeyId, orgId) {
  if (await journeyHasResults(journeyId)) {
    await query(`
      UPDATE journeys
      SET purged_at = NOW(), is_public = false, status = 'draft', updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NOT NULL
    `, [journeyId, orgId]);
    return 'kept';
  }
  await query('DELETE FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NOT NULL', [journeyId, orgId]);
  return 'deleted';
}

/**
 * Admin action in Analytics: remove all results of a journey that was deleted
 * for good, and the journey itself.
 * @param {string} journeyId
 * @param {string} orgId
 * @returns {Promise<boolean>} false when there is no such deleted journey
 */
export async function deleteJourneyResults(journeyId, orgId) {
  const client = await getClient();
  let files = [];
  try {
    await client.query('BEGIN');
    const check = await client.query(
      'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2 AND purged_at IS NOT NULL FOR UPDATE',
      [journeyId, orgId]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const fileRows = await client.query(
      'SELECT storage_path FROM form_submission_files WHERE journey_id = $1 AND organization_id = $2',
      [journeyId, orgId]
    );
    files = fileRows.rows.map((row) => row.storage_path);
    // Polls and rewards have no cascade from the journey (they survive it on purpose)
    await client.query(`
      DELETE FROM polls
      WHERE organization_id = $2
        AND step_id IN (SELECT id FROM steps WHERE journey_id = $1 UNION SELECT id FROM deleted_steps WHERE journey_id = $1 AND organization_id = $2)
    `, [journeyId, orgId]);
    await client.query('DELETE FROM rewards WHERE journey_id = $1 AND organization_id = $2', [journeyId, orgId]);
    await client.query('DELETE FROM form_submission_files WHERE journey_id = $1 AND organization_id = $2', [journeyId, orgId]);
    // Cascades to steps, invitations, progress and every result table
    await client.query('DELETE FROM journeys WHERE id = $1 AND organization_id = $2', [journeyId, orgId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  removeFormFiles(files);
  return true;
}

/**
 * Admin action in Analytics: remove all results of a deleted step.
 * @param {string} stepId
 * @param {string} orgId
 * @returns {Promise<boolean>} false when there is no such deleted step
 */
export async function deleteStepResults(stepId, orgId) {
  const client = await getClient();
  let files = [];
  try {
    await client.query('BEGIN');
    const check = await client.query(
      'SELECT journey_id FROM deleted_steps WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [stepId, orgId]
    );
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const journeyId = check.rows[0].journey_id;
    const fileRows = await client.query(
      'SELECT storage_path FROM form_submission_files WHERE step_id = $1 AND journey_id = $2 AND organization_id = $3',
      [stepId, journeyId, orgId]
    );
    files = fileRows.rows.map((row) => row.storage_path);
    await client.query('DELETE FROM form_submission_files WHERE step_id = $1 AND journey_id = $2 AND organization_id = $3', [stepId, journeyId, orgId]);
    for (const table of STEP_RESULT_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE step_id = $1 AND journey_id = $2`, [stepId, journeyId]);
    }
    await client.query('DELETE FROM polls WHERE step_id = $1 AND organization_id = $2', [stepId, orgId]);
    await client.query('DELETE FROM rewards WHERE step_id = $1 AND journey_id = $2 AND organization_id = $3', [stepId, journeyId, orgId]);
    await client.query('DELETE FROM deleted_steps WHERE id = $1 AND organization_id = $2', [stepId, orgId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  removeFormFiles(files);
  return true;
}
