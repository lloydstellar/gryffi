/**
 * Help usage counts
 *
 * Shows where makers need help, so that screen can be made clearer: how often
 * the help panel opens per screen, which "What is this?" explanations and help
 * articles are read, and which questions the help could not answer.
 *
 * Counts are kept per organization and day, without a user. Unanswered
 * questions are stored as typed (they show which article is missing) and are
 * removed after 90 days by the scheduler.
 */
import { query } from '../db/index.js';

export const HELP_EVENT_KINDS = new Set(['panel', 'tip', 'article', 'question', 'unanswered']);
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,59}$/;
const UNANSWERED_DAYS = 90;
const EVENT_DAYS = 365;

/**
 * A screen name or key from the browser, or '' when it is not a plain name
 * @param {unknown} value
 * @returns {string}
 */
export function helpName(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value) ? value : '';
}

/**
 * Count one help event for today
 * @param {string} orgId
 * @param {{kind: string, screen: string, key?: string}} event
 */
export async function recordHelpEvent(orgId, { kind, screen, key = '' }) {
  if (!orgId || !HELP_EVENT_KINDS.has(kind) || !helpName(screen)) return;
  await query(
    `INSERT INTO help_events (organization_id, screen, kind, key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, day, screen, kind, key)
     DO UPDATE SET count = help_events.count + 1`,
    [orgId, screen, kind, helpName(key)]
  );
}

/**
 * Keep a question the help could not answer
 * @param {string} orgId
 * @param {string} screen
 * @param {string} question
 */
export async function recordUnanswered(orgId, screen, question) {
  if (!orgId || !question) return;
  await query(
    `INSERT INTO help_unanswered (organization_id, screen, question) VALUES ($1, $2, $3)`,
    [orgId, helpName(screen) || 'unknown', String(question).slice(0, 500)]
  );
  await recordHelpEvent(orgId, { kind: 'unanswered', screen: helpName(screen) || 'unknown' });
}

/**
 * Remove old unanswered questions and counts (runs from the scheduler,
 * without organization context: the owner pool is not limited by RLS)
 * @returns {Promise<{questions: number, events: number}>}
 */
export async function cleanupHelpEvents() {
  const questions = await query(
    `DELETE FROM help_unanswered WHERE created_at < NOW() - make_interval(days => $1)`,
    [UNANSWERED_DAYS]
  );
  const events = await query(
    `DELETE FROM help_events WHERE day < CURRENT_DATE - $1::int`,
    [EVENT_DAYS]
  );
  return { questions: questions.rowCount || 0, events: events.rowCount || 0 };
}
