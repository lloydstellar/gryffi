/**
 * Dashboard Tips
 * Behaviour-driven, tier-aware nudges for makers on the dashboard.
 *
 * Rules are evaluated in order against a snapshot of the organization.
 * The first rule that matches, is allowed for the user's role, is not
 * blocked by the tier (feature flag or limit) and has not been dismissed
 * by this user, becomes the single tip shown on the dashboard.
 *
 * Dismissals are stored per user in user_onboarding.hints_shown under
 * the key `tip:<rule key>`. After any dismissal no tip is shown for a
 * few days, so a maker who clicked "don't show again" is left alone.
 */
import { query } from '../db/index.js';
import { getUserOnboardingState } from './demoJourney.js';
import { getOrganizationUsageWithLimits } from './subscription.js';

const HINT_PREFIX = 'tip:';
const LAST_DISMISSED_KEY = 'tip:last_dismissed_at';
const MIN_DAYS_AFTER_DISMISS = 3;
const FIRST_COMPLETION_MAX_DAYS = 14;
const GROUPS_MIN_END_USERS = 10;

const BUILDER_ROLES = ['admin', 'manager', 'member', 'editor'];
const ADMIN_ROLES = ['admin'];

function daysBetween(from, to) {
  return (new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Tip rules, in priority order. Each rule returns null when it does not
 * apply, or an object with the content key, template vars and the link.
 *
 * `ctx` carries the role, tier features and usage limits so that rules
 * never promote something the organization cannot use.
 */
const RULES = [
  {
    key: 'first_journey',
    roles: BUILDER_ROLES,
    check: (s, ctx) => {
      if (s.journeys_total > 0) return null;
      if (ctx.usage.journeys?.isAtLimit) return null;
      return { link: '/dashboard/journeys?create=1' };
    }
  },
  {
    key: 'add_end_users',
    roles: ADMIN_ROLES,
    check: (s, ctx) => {
      if (s.end_users_count > 0 || s.journeys_total === 0) return null;
      if (ctx.usage.endUsers?.isAtLimit) return null;
      // Only mention directory sync when the tier has it and nothing is connected yet
      const canSync = ctx.features.sync && !s.sync_connected;
      return { contentKey: canSync ? 'add_end_users_sync' : 'add_end_users', link: '/dashboard/system-settings#users' };
    }
  },
  {
    key: 'invite',
    roles: BUILDER_ROLES,
    check: (s) => {
      if (s.journeys_published === 0 || s.invitations_total > 0 || s.end_users_count === 0) return null;
      const j = s.latest_published;
      return { vars: { journey_title: j?.title || '' }, link: '/dashboard/invitations' };
    }
  },
  {
    key: 'add_guide',
    roles: BUILDER_ROLES,
    check: (s, ctx) => {
      const j = s.latest_journey;
      if (s.guides_total > 0 || !j || j.step_count < 2) return null;
      if (ctx.usage.guides?.isAtLimit) return null;
      return { link: '/dashboard/guides' };
    }
  },
  {
    key: 'fill_knowledge',
    roles: BUILDER_ROLES,
    check: (s, ctx) => {
      const g = s.first_guide;
      if (!g || s.chunks_used > 0) return null;
      if (ctx.usage.knowledgeChunks?.isAtLimit) return null;
      return { vars: { guide_name: g.name }, link: `/dashboard/guides/${g.id}` };
    }
  },
  {
    key: 'first_completion',
    roles: BUILDER_ROLES,
    check: (s) => {
      if (!s.first_completion_at) return null;
      const age = daysBetween(s.first_completion_at, s.now);
      if (age > FIRST_COMPLETION_MAX_DAYS) return null;
      return { link: '/dashboard/analytics' };
    }
  },
  {
    key: 'create_groups',
    roles: ADMIN_ROLES,
    check: (s) => {
      if (s.end_users_count < GROUPS_MIN_END_USERS || s.groups_count > 0) return null;
      return { link: '/dashboard/system-settings#users' };
    }
  },
  {
    key: 'add_interaction',
    roles: BUILDER_ROLES,
    check: (s) => {
      const j = s.latest_published;
      if (!j || j.step_count < 3 || s.interactive_steps_published > 0) return null;
      return { vars: { journey_title: j.title }, link: `/dashboard/builder/${j.id}` };
    }
  }
];

export const TIP_KEYS = RULES.map(rule => rule.key);

/**
 * Load everything the rules need for one organization in a single query.
 */
async function loadSnapshot(orgId) {
  const result = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM journeys j
         WHERE j.organization_id = $1 AND j.deleted_at IS NULL) AS journeys_total,
      (SELECT COUNT(*)::int FROM journeys j
         WHERE j.organization_id = $1 AND j.deleted_at IS NULL AND j.status = 'published') AS journeys_published,
      (SELECT row_to_json(x) FROM (
         SELECT j.id, j.title, j.status, j.updated_at,
                (SELECT COUNT(*)::int FROM steps s WHERE s.journey_id = j.id) AS step_count
         FROM journeys j
         WHERE j.organization_id = $1 AND j.deleted_at IS NULL
         ORDER BY j.updated_at DESC LIMIT 1
       ) x) AS latest_journey,
      (SELECT row_to_json(x) FROM (
         SELECT j.id, j.title,
                (SELECT COUNT(*)::int FROM steps s WHERE s.journey_id = j.id) AS step_count
         FROM journeys j
         WHERE j.organization_id = $1 AND j.deleted_at IS NULL AND j.status = 'published'
         ORDER BY j.published_at DESC NULLS LAST LIMIT 1
       ) x) AS latest_published,
      (SELECT COUNT(*)::int FROM steps s
         JOIN journeys j ON j.id = s.journey_id
         WHERE j.organization_id = $1 AND j.deleted_at IS NULL AND j.status = 'published'
           AND s.type IN ('challenge', 'poll', 'form')) AS interactive_steps_published,
      (SELECT COUNT(*)::int FROM invitations i WHERE i.organization_id = $1) AS invitations_total,
      (SELECT COUNT(*)::int FROM end_users eu
         WHERE eu.organization_id = $1 AND eu.is_active = true) AS end_users_count,
      (SELECT COUNT(*)::int FROM end_user_groups g WHERE g.organization_id = $1) AS groups_count,
      (SELECT COUNT(*)::int FROM guides g
         WHERE g.organization_id = $1 AND g.deleted_at IS NULL) AS guides_total,
      (SELECT row_to_json(x) FROM (
         SELECT g.id, g.name FROM guides g
         WHERE g.organization_id = $1 AND g.deleted_at IS NULL
         ORDER BY g.created_at ASC LIMIT 1
       ) x) AS first_guide,
      (SELECT COUNT(*)::int FROM knowledge_chunks k WHERE k.organization_id = $1) AS chunks_used,
      (SELECT MIN(e.created_at) FROM journey_events e
         WHERE e.organization_id = $1 AND e.event_type = 'journey_completed'
           AND e.invitation_id IS NOT NULL) AS first_completion_at,
      (SELECT (o.google_refresh_token IS NOT NULL OR o.microsoft_refresh_token IS NOT NULL)
         FROM organizations o WHERE o.id = $1) AS sync_connected
  `, [orgId]);

  return { ...result.rows[0], now: new Date() };
}

/**
 * Pick the tip to show, given a snapshot, the user's context and the
 * dismissed hints. Pure function so the rules can be reasoned about
 * without a database.
 *
 * @returns {{ key: string, contentKey: string, vars: Object, link: string } | null}
 */
export function pickTip(snapshot, ctx, hintsShown = {}) {
  const lastDismissed = hintsShown[LAST_DISMISSED_KEY];
  if (lastDismissed && daysBetween(lastDismissed, snapshot.now) < MIN_DAYS_AFTER_DISMISS) {
    return null;
  }

  for (const rule of RULES) {
    if (!rule.roles.includes(ctx.role)) continue;
    if (hintsShown[HINT_PREFIX + rule.key]) continue;

    const match = rule.check(snapshot, ctx);
    if (match) {
      return {
        key: rule.key,
        contentKey: match.contentKey || rule.key,
        vars: match.vars || {},
        link: match.link
      };
    }
  }
  return null;
}

/**
 * Resolve the active dashboard tip for a user.
 * Never throws: on any failure the dashboard simply shows no tip.
 *
 * @param {string} userId
 * @param {string} orgId
 * @param {string} role - users.role
 * @returns {Promise<Object|null>}
 */
export async function getActiveTip(userId, orgId, role) {
  if (!BUILDER_ROLES.includes(role)) return null;

  try {
    const [snapshot, usageData, onboarding] = await Promise.all([
      loadSnapshot(orgId),
      getOrganizationUsageWithLimits(orgId),
      getUserOnboardingState(userId, orgId)
    ]);

    const ctx = {
      role,
      usage: usageData?.usage || {},
      features: {
        sync: !!usageData?.tier?.features?.syncEnabled
      }
    };

    return pickTip(snapshot, ctx, onboarding?.hints_shown || {});
  } catch (err) {
    console.error('[Tips] Failed to resolve dashboard tip:', err);
    return null;
  }
}

/**
 * Dismiss a tip for a user: the tip itself never returns, and no other
 * tip is shown for MIN_DAYS_AFTER_DISMISS days.
 *
 * @param {string} userId
 * @param {string} orgId
 * @param {string} key - one of TIP_KEYS
 */
export async function dismissTip(userId, orgId, key) {
  if (!TIP_KEYS.includes(key)) {
    throw new Error('Unknown tip key');
  }

  // Make sure the onboarding row exists before merging into it
  await getUserOnboardingState(userId, orgId);

  const now = new Date().toISOString();
  const patch = { [HINT_PREFIX + key]: now, [LAST_DISMISSED_KEY]: now };

  await query(`
    UPDATE user_onboarding
    SET hints_shown = COALESCE(hints_shown, '{}'::jsonb) || $1::jsonb,
        updated_at = NOW()
    WHERE user_id = $2
  `, [JSON.stringify(patch), userId]);
}
