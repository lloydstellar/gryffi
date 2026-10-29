/**
 * Dashboard Routes
 * Main application views
 */
import { Router } from 'express';
import i18next from 'i18next';
import { query } from '../db/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { checkLimit, logUsageEvent, getOrganizationUsageWithLimits, RESOURCE_TYPES, AI_PLAYER_GRACE } from '../services/subscription.js';
import { TARGET_COUNTRIES, ALL_COUNTRIES, localizeCountries } from '../utils/countries.js';
import { getPlayerLocale } from '../services/playerLocales.js';
import { 
  getDemoJourney, 
  shouldShowWelcome,
  createVirtualJourneyFromDemo 
} from '../services/demoJourney.js';
import { getActiveTip } from '../services/tips.js';
import { formatKnowledgeError } from '../services/knowledge.js';
import { getAppBaseUrl } from '../utils/appUrl.js';
import { isCloud, isCommunity } from '../edition.js';
import { getSetting } from '../services/settings.js';

const router = Router();

// Apply auth middleware to all routes
router.use(requireAuth);

// Middleware to add subscription tier, usage info, and onboarding state to all dashboard views
router.use(async (req, res, next) => {
  try {
    if (req.session?.organization?.id) {
      const usageData = await getOrganizationUsageWithLimits(req.session.organization.id);
      res.locals.subscriptionTier = usageData?.tier || null;
      res.locals.subscriptionUsage = usageData?.usage || null;
      res.locals.billingPeriod = usageData?.billingPeriod || null;
      res.locals.aiPlayerGrace = AI_PLAYER_GRACE;
    }
    
    // Load onboarding state for all dashboard pages
    if (req.session?.user?.id && req.session?.organization?.id) {
      const showWelcome = await shouldShowWelcome(req.session.user.id, req.session.organization.id);
      res.locals.showOnboardingWelcome = showWelcome;
    }
  } catch (err) {
    console.error('Failed to load subscription/onboarding data:', err);
    res.locals.subscriptionTier = null;
    res.locals.subscriptionUsage = null;
    res.locals.showOnboardingWelcome = false;
  }
  next();
});

/**
 * GET /dashboard - Main dashboard (Role-Based Modular)
 */
router.get('/', async (req, res) => {
  try {
    const orgId = req.session.organization.id;
    const userRole = req.session.user?.role || 'viewer';
    
    // ========================================
    // BASIC STATS (All roles)
    // ========================================
    
    // Journey statistics (including public/private for Tier 3+)
    const journeyStats = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'published') as published,
        COUNT(*) FILTER (WHERE status = 'draft') as drafts,
        COUNT(*) FILTER (WHERE is_public = true) as public_journeys,
        COUNT(*) FILTER (WHERE is_public = false OR is_public IS NULL) as private_journeys
      FROM journeys 
      WHERE organization_id = $1 AND deleted_at IS NULL
    `, [orgId]);
    
    // End user count
    const endUserStats = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_active = true) as active
      FROM end_users 
      WHERE organization_id = $1
    `, [orgId]);
    
    // Guide count
    const guideStats = await query(`
      SELECT COUNT(*) as total
      FROM guides 
      WHERE organization_id = $1 AND deleted_at IS NULL
    `, [orgId]);
    
    // Recent journeys
    const recentJourneys = await query(`
      SELECT j.*, 
        u.first_name || ' ' || u.last_name as created_by_name,
        (SELECT COUNT(*) FROM steps WHERE journey_id = j.id) as step_count
      FROM journeys j
      LEFT JOIN users u ON j.created_by = u.id
      WHERE j.organization_id = $1 AND j.deleted_at IS NULL
      ORDER BY j.updated_at DESC
      LIMIT 6
    `, [orgId]);
    
    // AI Guides with chunks and journey usage
    const guidesData = await query(`
      SELECT g.id, g.name, g.avatar_url, g.created_at,
             (SELECT COALESCE(SUM(chunks_count), 0) FROM knowledge_sources WHERE guide_id = g.id) as chunks_count,
             (
               SELECT COALESCE(json_agg(DISTINCT jsonb_build_object('id', j.id, 'title', j.title)), '[]'::json)
               FROM journeys j 
               WHERE j.deleted_at IS NULL AND (
                 j.guide_id = g.id 
                 OR EXISTS (
                   SELECT 1 FROM steps s 
                   WHERE s.journey_id = j.id 
                   AND s.type = 'guide' 
                   AND s.basic_props->>'guide_id' = g.id::text
                 )
               )
             ) as journeys_using
      FROM guides g 
      WHERE g.organization_id = $1 AND g.deleted_at IS NULL
      ORDER BY g.created_at DESC
      LIMIT 4
    `, [orgId]);
    
    // Parse journeys_using for guides
    guidesData.rows.forEach(guide => {
      guide.journeys_using = guide.journeys_using || [];
    });
    
    // Build base dashboard data
    const dashboardData = {
      stats: {
        journeys: journeyStats.rows[0],
        endUsers: endUserStats.rows[0],
        guides: guideStats.rows[0]
      },
      recentJourneys: recentJourneys.rows,
      guides: guidesData.rows,
      userRole
    };
    
    // ========================================
    // EDITOR (member), MANAGER & ADMIN DATA
    // ========================================
    if (userRole === 'editor' || userRole === 'member' || userRole === 'manager' || userRole === 'admin') {
      // Invitation statistics
      // Note: 'completed' counts journeys that have been finished at least once (completions_count > 0)
      // This includes both fully completed invitations AND unlimited invitations with completions
      const invitationStats = await query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'active' AND completions_count = 0) as active,
          COUNT(*) FILTER (WHERE completions_count > 0) as completed,
          COUNT(*) FILTER (WHERE status = 'expired') as expired
        FROM invitations 
        WHERE organization_id = $1
      `, [orgId]);
      
      // Expiring invitations (next 3 days)
      const expiringInvitations = await query(`
        SELECT COUNT(*) as count
        FROM invitations 
        WHERE organization_id = $1 
          AND status IN ('pending', 'active')
          AND expires_at <= NOW() + INTERVAL '3 days'
          AND expires_at > NOW()
      `, [orgId]);
      
      // Recent poll responses (last 7 days) - using poll_responses as proxy for form activity
      const formResponseStats = await query(`
        SELECT COUNT(*) as count
        FROM poll_responses pr
        JOIN polls p ON pr.poll_id = p.id
        JOIN steps s ON p.step_id = s.id
        JOIN journeys j ON s.journey_id = j.id
        WHERE j.organization_id = $1 
          AND j.deleted_at IS NULL
          AND pr.created_at >= NOW() - INTERVAL '7 days'
      `, [orgId]);
      
      // Journey completion rate (from invitations)
      // Completed = has at least one completion (includes active unlimited invitations with completions)
      const completionStats = await query(`
        SELECT 
          COUNT(*) FILTER (WHERE completions_count > 0) as completed,
          COUNT(*) FILTER (WHERE status IN ('active', 'completed', 'expired') OR completions_count > 0) as total_engaged
        FROM invitations 
        WHERE organization_id = $1
      `, [orgId]);
      
      dashboardData.invitations = invitationStats.rows[0];
      dashboardData.expiringCount = parseInt(expiringInvitations.rows[0]?.count || 0);
      dashboardData.formResponseCount = parseInt(formResponseStats.rows[0]?.count || 0);
      dashboardData.completionRate = completionStats.rows[0]?.total_engaged > 0 
        ? Math.round((completionStats.rows[0].completed / completionStats.rows[0].total_engaged) * 100)
        : 0;
      
      // Draft journeys that might need attention
      const draftJourneys = await query(`
        SELECT id, title, updated_at
        FROM journeys 
        WHERE organization_id = $1 
          AND deleted_at IS NULL 
          AND status = 'draft'
          AND updated_at < NOW() - INTERVAL '7 days'
        ORDER BY updated_at ASC
        LIMIT 3
      `, [orgId]);
      dashboardData.staleDrafts = draftJourneys.rows;

      // One behaviour-driven tip at a time (never for viewers, never for tier-locked features)
      dashboardData.dashboardTip = await getActiveTip(req.session.user.id, orgId, userRole);
      
      // Reward statistics
      // For random codes: remaining = max_recipients - claimed (codes are created on claim)
      // For manual codes: remaining = unclaimed codes in reward_codes table
      // Only count active (non-archived) rewards for the main stats
      const rewardStats = await query(`
        SELECT 
          COUNT(DISTINCT CASE WHEN NOT COALESCE(r.is_archived, false) THEN r.id END) as active_rewards,
          COUNT(DISTINCT CASE WHEN COALESCE(r.is_archived, false) THEN r.id END) as archived_rewards,
          COALESCE(SUM(
            CASE WHEN NOT COALESCE(r.is_archived, false) THEN
              (SELECT COUNT(*) FROM reward_codes rc2 WHERE rc2.reward_id = r.id AND rc2.is_claimed = true)
            ELSE 0 END
          ), 0) as total_claimed,
          COALESCE(SUM(
            CASE WHEN NOT COALESCE(r.is_archived, false) THEN
              CASE WHEN r.is_random_codes THEN
                CASE WHEN r.max_recipients IS NOT NULL THEN
                  r.max_recipients - (SELECT COUNT(*) FROM reward_codes rc2 WHERE rc2.reward_id = r.id AND rc2.is_claimed = true)
                ELSE 0 END
              ELSE
                (SELECT COUNT(*) FROM reward_codes rc2 WHERE rc2.reward_id = r.id AND rc2.is_claimed = false)
              END
            ELSE 0 END
          ), 0) as total_remaining,
          COALESCE(SUM(
            CASE WHEN COALESCE(r.is_archived, false) THEN
              (SELECT COUNT(*) FROM reward_codes rc2 WHERE rc2.reward_id = r.id AND rc2.is_claimed = true)
            ELSE 0 END
          ), 0) as archived_claimed
        FROM rewards r
        WHERE r.organization_id = $1
      `, [orgId]);
      
      // Find reward that is running low (less than or equal to 3 codes remaining)
      // Only check active (non-archived) rewards
      const lowStockReward = await query(`
        SELECT 
          r.title,
          r.max_recipients,
          CASE 
            WHEN r.is_random_codes THEN
              CASE WHEN r.max_recipients IS NOT NULL THEN
                r.max_recipients - (SELECT COUNT(*) FROM reward_codes rc WHERE rc.reward_id = r.id AND rc.is_claimed = true)
              ELSE NULL END
            ELSE
              (SELECT COUNT(*) FROM reward_codes rc WHERE rc.reward_id = r.id AND rc.is_claimed = false)
          END as remaining
        FROM rewards r
        WHERE r.organization_id = $1
          AND NOT COALESCE(r.is_archived, false)
        GROUP BY r.id, r.title, r.max_recipients, r.is_random_codes
        HAVING (
          CASE 
            WHEN r.is_random_codes THEN
              CASE WHEN r.max_recipients IS NOT NULL THEN
                r.max_recipients - (SELECT COUNT(*) FROM reward_codes rc WHERE rc.reward_id = r.id AND rc.is_claimed = true)
              ELSE NULL END
            ELSE
              (SELECT COUNT(*) FROM reward_codes rc WHERE rc.reward_id = r.id AND rc.is_claimed = false)
          END
        ) <= 3
        AND (
          CASE 
            WHEN r.is_random_codes THEN
              CASE WHEN r.max_recipients IS NOT NULL THEN
                r.max_recipients - (SELECT COUNT(*) FROM reward_codes rc WHERE rc.reward_id = r.id AND rc.is_claimed = true)
              ELSE NULL END
            ELSE
              (SELECT COUNT(*) FROM reward_codes rc WHERE rc.reward_id = r.id AND rc.is_claimed = false)
          END
        ) IS NOT NULL
        ORDER BY (
          CASE 
            WHEN r.is_random_codes THEN
              CASE WHEN r.max_recipients IS NOT NULL THEN
                r.max_recipients - (SELECT COUNT(*) FROM reward_codes rc WHERE rc.reward_id = r.id AND rc.is_claimed = true)
              ELSE NULL END
            ELSE
              (SELECT COUNT(*) FROM reward_codes rc WHERE rc.reward_id = r.id AND rc.is_claimed = false)
          END
        ) ASC
        LIMIT 1
      `, [orgId]);
      
      dashboardData.rewardStats = {
        active: parseInt(rewardStats.rows[0]?.active_rewards || 0),
        archived: parseInt(rewardStats.rows[0]?.archived_rewards || 0),
        claimed: parseInt(rewardStats.rows[0]?.total_claimed || 0),
        remaining: parseInt(rewardStats.rows[0]?.total_remaining || 0),
        archivedClaimed: parseInt(rewardStats.rows[0]?.archived_claimed || 0),
        lowStockReward: lowStockReward.rows[0] || null
      };
    }
    
    // ========================================
    // ADMIN & MANAGER DATA
    // ========================================
    if (userRole === 'admin' || userRole === 'manager') {
      // Team statistics
      const teamStats = await query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE is_active = true) as active,
          COUNT(*) FILTER (WHERE role = 'admin') as admins,
          COUNT(*) FILTER (WHERE role = 'editor') as editors,
          COUNT(*) FILTER (WHERE role = 'viewer') as viewers
        FROM users 
        WHERE organization_id = $1
      `, [orgId]);
      
      // Pending team invites (not accepted, not revoked, not expired)
      const pendingTeamInvites = await query(`
        SELECT COUNT(*) as count
        FROM user_invites 
        WHERE organization_id = $1 
          AND accepted_at IS NULL 
          AND revoked_at IS NULL 
          AND expires_at > NOW()
      `, [orgId]);
      
      // Recent team activity (last active users)
      const recentTeamActivity = await query(`
        SELECT first_name, last_name, role, last_login_at
        FROM users 
        WHERE organization_id = $1 AND is_active = true AND is_visible = true
        ORDER BY last_login_at DESC NULLS LAST
        LIMIT 5
      `, [orgId]);
      
      // Google Workspace sync status
      const googleStatus = await query(`
        SELECT 
          google_refresh_token IS NOT NULL as connected,
          google_connected_email,
          google_last_sync
        FROM organizations 
        WHERE id = $1
      `, [orgId]);
      
      // API key status
      const apiKeyStatus = await query(`
        SELECT 
          api_key_hash IS NOT NULL as has_api_key,
          api_key_last_used_at
        FROM organizations 
        WHERE id = $1
      `, [orgId]);
      
      dashboardData.team = {
        stats: teamStats.rows[0],
        pendingInvites: parseInt(pendingTeamInvites.rows[0]?.count || 0),
        recentActivity: recentTeamActivity.rows
      };
      
      dashboardData.systemStatus = {
        google: {
          connected: googleStatus.rows[0]?.connected || false,
          email: googleStatus.rows[0]?.google_connected_email,
          lastSync: googleStatus.rows[0]?.google_last_sync
        },
        api: {
          hasKey: apiKeyStatus.rows[0]?.has_api_key || false,
          lastUsed: apiKeyStatus.rows[0]?.api_key_last_used_at
        }
      };
      
      // Form submissions widget (admin/manager only - submissions may contain
      // personal data, same restriction as the Analytics Forms tab).
      // Private (magic link) and public journey submissions combined.
      const formSubmissionStats = await query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as last_week
        FROM (
          SELECT created_at FROM private_form_submissions WHERE organization_id = $1
          UNION ALL
          SELECT created_at FROM public_form_submissions WHERE organization_id = $1
        ) s
      `, [orgId]);
      
      // Submissions from the last 7 days that include at least one uploaded file
      const formSubmissionsWithFiles = await query(`
        SELECT COUNT(DISTINCT COALESCE(private_submission_id, public_submission_id)) as count
        FROM form_submission_files
        WHERE organization_id = $1
          AND created_at >= NOW() - INTERVAL '7 days'
      `, [orgId]);
      
      // Most recent submissions for the compact list. COALESCE keeps archived
      // titles visible after journey/step deletion.
      const recentFormSubmissions = await query(`
        SELECT s.id,
               COALESCE(j.title, s.journey_title) AS journey_title,
               COALESCE(st.title, s.step_title) AS step_title,
               TRIM(COALESCE(eu.first_name, '') || ' ' || COALESCE(eu.last_name, '')) AS submitter_name,
               s.created_at,
               (SELECT COUNT(*) FROM form_submission_files f WHERE f.private_submission_id = s.id) AS file_count
        FROM private_form_submissions s
        LEFT JOIN journeys j ON s.journey_id = j.id
        LEFT JOIN steps st ON s.step_id = st.id
        LEFT JOIN end_users eu ON s.end_user_id = eu.id
        WHERE s.organization_id = $1
        
        UNION ALL
        
        SELECT p.id,
               COALESCE(j.title, p.journey_title) AS journey_title,
               COALESCE(st.title, p.step_title) AS step_title,
               TRIM(COALESCE(pp.first_name, '') || ' ' || COALESCE(pp.last_name, '')) AS submitter_name,
               p.created_at,
               (SELECT COUNT(*) FROM form_submission_files f WHERE f.public_submission_id = p.id) AS file_count
        FROM public_form_submissions p
        LEFT JOIN journeys j ON p.journey_id = j.id
        LEFT JOIN steps st ON p.step_id = st.id
        LEFT JOIN public_participants pp ON p.participant_id = pp.id
        WHERE p.organization_id = $1
        
        ORDER BY created_at DESC
        LIMIT 4
      `, [orgId]);
      
      dashboardData.formSubmissions = {
        total: parseInt(formSubmissionStats.rows[0]?.total || 0),
        lastWeek: parseInt(formSubmissionStats.rows[0]?.last_week || 0),
        withFilesLastWeek: parseInt(formSubmissionsWithFiles.rows[0]?.count || 0),
        recent: recentFormSubmissions.rows
      };
    }
    
    res.render('pages/dashboard', dashboardData);
    
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

/**
 * GET /journeys - List all journeys
 */
router.get('/journeys', async (req, res) => {
  console.log('[Dashboard] GET /journeys - Session:', req.session?.user?.id ? 'valid' : 'invalid', 'Org:', req.session?.organization?.id ? 'valid' : 'invalid');
  try {
    const orgId = req.session.organization.id;
    const userRole = req.session.user?.role;
    // Use organization's default language for demo journey (not user's interface language)
    const orgLanguage = req.session.organization?.settings?.default_language || req.session.organization?.language || 'en';
    
    // Get organization's journeys
    const journeys = await query(`
      SELECT j.*, 
        u.first_name || ' ' || u.last_name as created_by_name,
        (SELECT COUNT(*) FROM steps WHERE journey_id = j.id) as step_count
      FROM journeys j
      LEFT JOIN users u ON j.created_by = u.id
      WHERE j.organization_id = $1 AND j.deleted_at IS NULL
      ORDER BY j.updated_at DESC
    `, [orgId]);
    
    // Get demo journey for organization's default language (shown to all makers)
    let demoJourney = null;
    try {
      const demoData = await getDemoJourney(orgLanguage, userRole);
      if (demoData) {
        const virtualJourney = createVirtualJourneyFromDemo(demoData);
        demoJourney = {
          ...virtualJourney,
          step_count: virtualJourney.steps?.length || 0,
          created_by_name: 'Gryffi',
          is_demo: true
        };
      }
    } catch (demoErr) {
      console.warn('Failed to load demo journey:', demoErr.message);
    }

    // Existing AI Guides for this organization (used by the Journey Wizard)
    let existingGuides = [];
    try {
      const guidesResult = await query(
        `SELECT id, name FROM guides
         WHERE organization_id = $1 AND deleted_at IS NULL AND is_active = true
         ORDER BY name ASC
         LIMIT 50`,
        [orgId]
      );
      existingGuides = guidesResult.rows || [];
    } catch (guideErr) {
      console.warn('[Journeys] Failed to load guides for wizard:', guideErr.message);
    }

    res.render('pages/journeys', {
      journeys: journeys.rows,
      demoJourney,
      existingGuides,
      isTrash: false,
      APP_URL: getAppBaseUrl()
    });
    
  } catch (err) {
    console.error('Journeys list error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

/**
 * GET /journeys/new - Create new journey form
 */
router.get('/journeys/new', (req, res) => {
  if (req.session?.user?.role === 'viewer') {
    return res.status(403).render('pages/error', {
      title: req.t('team.messages.noPermission'),
      message: req.t('team.messages.viewerReadOnly'),
      code: 403
    });
  }
  res.render('pages/journey-new', {});
});

/**
 * POST /journeys - Create new journey
 */
router.post('/journeys', async (req, res) => {
  if (req.session?.user?.role === 'viewer') {
    return res.status(403).render('pages/error', {
      title: req.t('team.messages.noPermission'),
      message: req.t('team.messages.viewerReadOnly'),
      code: 403
    });
  }
  const { title, description } = req.body;
  const orgId = req.session.organization.id;
  const userId = req.session.user.id;
  
  if (!title || title.trim().length === 0) {
    req.session.error = 'Please enter a title for your journey';
    return res.redirect('/dashboard/journeys/new');
  }
  
  try {
    // Check tier limit for journeys
    const limitCheck = await checkLimit(orgId, RESOURCE_TYPES.JOURNEYS);
    if (!limitCheck.allowed) {
      req.session.error = req.t('subscription.limits.journeysExceeded');
      req.session.limitExceeded = {
        type: 'journeys',
        current: limitCheck.current,
        limit: limitCheck.limit,
        tier: limitCheck.tier
      };
      return res.redirect('/dashboard/journeys/new');
    }
    
    const result = await query(`
      INSERT INTO journeys (organization_id, created_by, title, description)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [orgId, userId, title.trim(), description?.trim() || '']);
    
    // Log usage event
    await logUsageEvent(orgId, 'journey_create', 'journey', result.rows[0].id, userId);
    
    res.redirect(`/dashboard/builder/${result.rows[0].id}`);
    
  } catch (err) {
    console.error('Create journey error:', err);
    req.session.error = 'Failed to create journey';
    res.redirect('/dashboard/journeys/new');
  }
});

/**
 * GET /builder/:id - Flow builder for journey
 */
/**
 * GET /preview/:id - Direct preview mode for journey (from journeys list)
 * Opens journey in fullscreen preview mode with return to journeys list
 */
const JOURNEY_ID_RE = /^(demo-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/preview/:id', async (req, res) => {
  const journeyId = req.params.id;
  const orgId = req.session.organization.id;
  // Journey ids are UUIDs (demo journeys: demo-<uuid>); anything else is a 404, not a database error
  if (!JOURNEY_ID_RE.test(journeyId)) {
    return res.status(404).render('pages/error', {
      title: req.t('pages.notFound'),
      message: req.t('errors.pageNotFoundMessage'),
      code: 404
    });
  }
  const isDemoJourney = journeyId.startsWith('demo-');
  
  try {
    let journey, stepsResult, pathsResult, resourcesResult, guidesResult;
    
    if (isDemoJourney) {
      // Demo journey preview - load from demo_journeys table
      const demoId = journeyId.replace('demo-', '');
      const demoResult = await query('SELECT * FROM demo_journeys WHERE id = $1 AND is_active = true', [demoId]);
      
      if (demoResult.rows.length === 0) {
        return res.status(404).render('pages/error', {
          title: req.t('pages.notFound'),
          message: req.t('errors.pageNotFoundMessage'),
          code: 404
        });
      }
      
      const demoData = demoResult.rows[0];
      const journeyData = demoData.journey_data || {};
      
      // Create virtual journey object
      journey = {
        id: journeyId,
        title: demoData.title,
        description: demoData.description,
        cover_image_url: demoData.cover_image_url,
        status: 'published',
        settings: journeyData.settings || {},
        is_demo: true,
        demo_id: demoId,
        demo_version: demoData.version,
        demo_language: demoData.language
      };
      
      // Create virtual steps, paths, resources
      stepsResult = { rows: (journeyData.steps || []).map(step => ({ ...step, journey_id: journeyId })) };
      pathsResult = { rows: (journeyData.paths || []).map(path => ({ ...path, journey_id: journeyId })) };
      resourcesResult = { rows: [] };
      guidesResult = { rows: [] };
      
    } else {
      // Regular journey preview
      const journeyResult = await query(`
        SELECT * FROM journeys 
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
      `, [journeyId, orgId]);
      
      if (journeyResult.rows.length === 0) {
        return res.status(404).render('pages/error', {
          title: req.t('pages.notFound'),
          message: req.t('errors.pageNotFoundMessage'),
          code: 404
        });
      }
      
      // Get steps
      stepsResult = await query(`
        SELECT * FROM steps 
        WHERE journey_id = $1
        ORDER BY created_at
      `, [journeyId]);
      
      // Get paths (connections between steps)
      pathsResult = await query(`
        SELECT * FROM paths
        WHERE journey_id = $1
        ORDER BY sort_order
      `, [journeyId]);
      
      // Get resources
      resourcesResult = await query(`
        SELECT * FROM resources
        WHERE journey_id = $1
        ORDER BY name
      `, [journeyId]);
      
      // Get guides for this organization (needed for guide steps in player mode)
      guidesResult = await query(`
        SELECT g.*, 
               (SELECT COUNT(*) FROM knowledge_sources WHERE guide_id = g.id) as knowledge_count,
               (SELECT COALESCE(SUM(chunks_count), 0) FROM knowledge_sources WHERE guide_id = g.id) as chunks_count
        FROM guides g
        WHERE g.organization_id = $1 AND g.deleted_at IS NULL
        ORDER BY g.name
      `, [orgId]);
      
      journey = journeyResult.rows[0];
    }
    const settings = typeof journey.settings === 'string' 
      ? JSON.parse(journey.settings) 
      : (journey.settings || {});
    
    journey.automations = settings.automations || [];
    journey.welcome_message = settings.welcome_message || '';
    journey.completion_message = settings.completion_message || '';
    journey.allow_skip = settings.allow_skip || false;
    journey.track_progress = settings.track_progress !== false;
    journey.language_override = settings.language_override || false;
    journey.language_code = settings.language_code || null;
    journey.guide_language_override = settings.guide_language_override || false;
    journey.guide_language_code = settings.guide_language_code || null;
    journey.guide_opening_override = settings.guide_opening_override || '';
    
    // Get organization default language from settings
    const orgSettings = req.session.organization?.settings || {};
    const orgDefaultLanguage = orgSettings.default_language || 'en';
    
    // Determine journey language: use journey override if set, otherwise use org language
    const journeyLanguage = settings.language_override && settings.language_code 
      ? settings.language_code 
      : orgDefaultLanguage;
    
    // Determine AI Guide language: use guide language override if set, otherwise same as journey language
    const guideLanguage = settings.guide_language_override && settings.guide_language_code 
      ? settings.guide_language_code 
      : journeyLanguage;
    
    // Get fixed translation function for journey language
    const journeyT = i18next.getFixedT(journeyLanguage);
    
    // Get translations for journey language (for frontend JavaScript)
    // In preview mode, both interface and preview use the journey language
    const previewTranslations = {
      builder: journeyT('builder', { returnObjects: true }),
      common: journeyT('common', { returnObjects: true }),
      journeys: journeyT('journeys', { returnObjects: true }),
      invitations: journeyT('invitations', { returnObjects: true }),
      guides: journeyT('guides', { returnObjects: true }),
      imagePicker: journeyT('imagePicker', { returnObjects: true }),
      expedition: journeyT('expedition', { returnObjects: true })
    };
    
    // Load player-specific translations (supports extended languages)
    const playerTranslations = getPlayerLocale(journeyLanguage);
    
    // Render in player mode with return URL
    // Demo journeys return to builder view, regular journeys return to journeys list
    const returnUrl = isDemoJourney 
      ? `/dashboard/builder/${journeyId}` 
      : '/dashboard/journeys';
    
    // If journey is public, also enable publicMode so the identification flow is shown
    res.render('pages/builder', {
      title: journeyT('builder.preview.mode') + ' - ' + journey.title,
      journey: journey,
      organization: { 
        ...req.session.organization, 
        defaultLanguage: orgDefaultLanguage 
      },
      steps: stepsResult.rows,
      paths: pathsResult.rows,
      resources: resourcesResult.rows,
      guides: guidesResult.rows, // Guides needed for guide steps in player mode
      readOnly: true,
      playerMode: true,
      previewMode: true, // Flag to indicate this is preview (not actual end-user)
      publicMode: journey.is_public || false, // Enable public mode if journey is public
      isDemoJourney: isDemoJourney,
      returnUrl: returnUrl,
      APP_URL: getAppBaseUrl(),
      // Pass journey language for preview mode - in fullscreen preview both use journey language
      language: journeyLanguage,
      locale: journeyLanguage,
      journeyLanguage: journeyLanguage,
      guideLanguage: guideLanguage, // AI Guide response language
      interfaceTranslations: previewTranslations, // In preview mode, interface also uses journey language
      previewTranslations: previewTranslations,
      playerTranslations: playerTranslations, // Player-specific translations (extended language support)
      t: journeyT
    });
    
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

router.get('/builder/:id', async (req, res) => {
  const journeyId = req.params.id;
  const orgId = req.session.organization.id;
  let readOnly = req.session?.user?.role === 'viewer';
  // Journey ids are UUIDs (demo journeys: demo-<uuid>); anything else is a 404, not a database error
  if (!JOURNEY_ID_RE.test(journeyId)) {
    return res.status(404).render('pages/error', {
      title: req.t('pages.notFound'),
      message: req.t('errors.pageNotFoundMessage'),
      code: 404
    });
  }
  
  try {
    // Check if this is a demo journey (ID starts with 'demo-')
    const isDemoJourney = journeyId.startsWith('demo-');
    let journey, steps, paths, resources;
    
    if (isDemoJourney) {
      // Demo journey - extract the actual demo ID and load from demo_journeys table
      const demoId = journeyId.replace('demo-', '');
      const demoResult = await query('SELECT * FROM demo_journeys WHERE id = $1 AND is_active = true', [demoId]);
      
      if (demoResult.rows.length === 0) {
        return res.status(404).render('pages/error', {
          title: req.t('pages.notFound'),
          message: req.t('errors.pageNotFoundMessage'),
          code: 404
        });
      }
      
      const demoData = demoResult.rows[0];
      const journeyData = demoData.journey_data || {};
      
      // Create virtual journey object
      journey = {
        id: journeyId,
        title: demoData.title,
        description: demoData.description,
        cover_image_url: demoData.cover_image_url,
        status: 'published',
        settings: journeyData.settings || {},
        is_demo: true,
        demo_id: demoId,
        demo_version: demoData.version,
        demo_language: demoData.language
      };
      
      steps = (journeyData.steps || []).map(step => ({
        ...step,
        journey_id: journeyId
      }));
      
      paths = (journeyData.paths || []).map(path => ({
        ...path,
        journey_id: journeyId
      }));
      
      resources = [];
      
      // Demo journeys are always read-only for regular users
      readOnly = true;
      
    } else {
      // Regular journey - load from database
      const journeyResult = await query(`
        SELECT * FROM journeys 
        WHERE id = $1 AND organization_id = $2
      `, [journeyId, orgId]);
      
      if (journeyResult.rows.length === 0) {
        return res.status(404).render('pages/error', {
          title: req.t('pages.notFound'),
          message: req.t('errors.pageNotFoundMessage'),
          code: 404
        });
      }
      
      // Check if journey is in trash - don't allow opening in builder
      if (journeyResult.rows[0].deleted_at) {
        return res.status(403).render('pages/error', {
          title: req.t('journeys.trash.cannotEdit'),
          message: req.t('journeys.trash.cannotEditMessage'),
          code: 403
        });
      }
      
      journey = journeyResult.rows[0];
      
      // Get steps
      const stepsResult = await query(`
        SELECT * FROM steps 
        WHERE journey_id = $1
        ORDER BY created_at
      `, [journeyId]);
      steps = stepsResult.rows;
      
      // Get paths (connections between steps)
      const pathsResult = await query(`
        SELECT * FROM paths
        WHERE journey_id = $1
        ORDER BY sort_order
      `, [journeyId]);
      paths = pathsResult.rows;
      
      // Get resources
      const resourcesResult = await query(`
        SELECT * FROM resources
        WHERE journey_id = $1
        ORDER BY name
      `, [journeyId]);
      resources = resourcesResult.rows;
    }
    
    // Process journey data - extract settings
    const settings = typeof journey.settings === 'string' 
      ? JSON.parse(journey.settings) 
      : (journey.settings || {});
    
    journey.automations = settings.automations || [];
    journey.welcome_message = settings.welcome_message || '';
    journey.completion_message = settings.completion_message || '';
    journey.allow_skip = settings.allow_skip || false;
    journey.track_progress = settings.track_progress !== false;
    journey.language_override = settings.language_override || false;
    journey.language_code = settings.language_code || null;
    journey.guide_language_override = settings.guide_language_override || false;
    journey.guide_language_code = settings.guide_language_code || null;
    journey.guide_opening_override = settings.guide_opening_override || '';
    
    // Get organization default language from settings
    const orgSettings = req.session.organization?.settings || {};
    const orgDefaultLanguage = orgSettings.default_language || 'en';
    
    // Determine journey language for preview mode: use journey override if set, otherwise use org language
    const journeyLanguage = settings.language_override && settings.language_code 
      ? settings.language_code 
      : orgDefaultLanguage;
    
    // Determine AI Guide language: use guide language override if set, otherwise same as journey language
    const guideLanguage = settings.guide_language_override && settings.guide_language_code 
      ? settings.guide_language_code 
      : journeyLanguage;
    
    // Get translations for journey language (for inline preview in builder)
    const journeyT = i18next.getFixedT(journeyLanguage);
    const previewTranslations = {
      builder: journeyT('builder', { returnObjects: true }),
      common: journeyT('common', { returnObjects: true }),
      journeys: journeyT('journeys', { returnObjects: true }),
      invitations: journeyT('invitations', { returnObjects: true }),
      guides: journeyT('guides', { returnObjects: true }),
      imagePicker: journeyT('imagePicker', { returnObjects: true }),
      expedition: journeyT('expedition', { returnObjects: true })
    };
    
    // Get translations for user's interface language (for builder UI/properties panels)
    const interfaceTranslations = {
      builder: req.t('builder', { returnObjects: true }),
      common: req.t('common', { returnObjects: true }),
      journeys: req.t('journeys', { returnObjects: true }),
      invitations: req.t('invitations', { returnObjects: true }),
      guides: req.t('guides', { returnObjects: true }),
      imagePicker: req.t('imagePicker', { returnObjects: true }),
      expedition: req.t('expedition', { returnObjects: true })
    };
    
    // Load player-specific translations (supports extended languages)
    const playerTranslations = getPlayerLocale(journeyLanguage);
    
    res.render('pages/builder', {
      title: journey.is_demo ? req.t('onboarding.demoJourney.title') : req.t('pages.editJourney', { title: journey.title }),
      journey: journey,
      organization: { 
        ...req.session.organization, 
        defaultLanguage: orgDefaultLanguage 
      },
      steps: steps,
      paths: paths,
      resources: resources,
      readOnly,
      isDemoJourney: journey.is_demo || false,
      APP_URL: getAppBaseUrl(),
      // Pass both interface translations (for builder UI) and preview translations (for journey preview)
      interfaceTranslations: interfaceTranslations,
      previewTranslations: previewTranslations,
      playerTranslations: playerTranslations, // Player-specific translations (extended language support)
      journeyLanguage: journeyLanguage,
      guideLanguage: guideLanguage // AI Guide response language
    });
    
  } catch (err) {
    console.error('Builder error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

// Note: DELETE /journeys/:id is now handled by API routes in api.js
// This allows for soft delete (trash) functionality

/**
 * GET /journeys/trash - View trash (deleted journeys)
 * Only admin and manager can view trash
 */
router.get('/journeys/trash', async (req, res) => {
  try {
    const orgId = req.session.organization.id;
    const userRole = req.session.user?.role;

    // Check permissions: only admin and manager can view trash
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).render('pages/error', {
        title: req.t('team.messages.noPermission'),
        message: req.t('journeys.delete.noPermission'),
        code: 403
      });
    }

    // Get trash retention days for this organization's tier
    const tierResult = await query(`
      SELECT t.trash_retention_days
      FROM organizations o
      JOIN subscription_tiers t ON o.subscription_tier_id = t.id
      WHERE o.id = $1
    `, [orgId]);
    
    const trashRetentionDays = tierResult.rows[0]?.trash_retention_days || 14;

    const journeys = await query(`
      SELECT j.*, 
        u.first_name || ' ' || u.last_name as created_by_name,
        (SELECT COUNT(*) FROM steps WHERE journey_id = j.id) as step_count
      FROM journeys j
      LEFT JOIN users u ON j.created_by = u.id
      WHERE j.organization_id = $1 AND j.deleted_at IS NOT NULL
      ORDER BY j.deleted_at DESC
    `, [orgId]);

    res.render('pages/journeys', {
      journeys: journeys.rows,
      isTrash: true,
      trashRetentionDays
    });

  } catch (err) {
    console.error('Trash list error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

// ============================================
// GUIDES
// ============================================

/**
 * GET /guides - Guides library page
 */
router.get('/guides', async (req, res) => {
  try {
    const orgId = req.session.organization.id;
    
    // Get guides with journey usage info (both journey-wide and step-based)
    const guides = await query(`
      SELECT g.*, 
             (SELECT COUNT(*) FROM knowledge_sources WHERE guide_id = g.id) as knowledge_count,
             (SELECT COALESCE(SUM(chunks_count), 0) FROM knowledge_sources WHERE guide_id = g.id) as chunks_count,
             (
               SELECT COALESCE(json_agg(DISTINCT jsonb_build_object('id', j.id, 'title', j.title, 'status', j.status)), '[]'::json)
               FROM journeys j 
               WHERE j.deleted_at IS NULL AND (
                 j.guide_id = g.id 
                 OR EXISTS (
                   SELECT 1 FROM steps s 
                   WHERE s.journey_id = j.id 
                   AND s.type = 'guide' 
                   AND s.basic_props->>'guide_id' = g.id::text
                 )
               )
             ) as journeys_using
      FROM guides g 
      WHERE g.organization_id = $1 AND g.deleted_at IS NULL
      ORDER BY g.created_at DESC
    `, [orgId]);
    
    // Parse journeys_using and add journey_count
    guides.rows.forEach(guide => {
      guide.journeys_using = guide.journeys_using || [];
      guide.journey_count = guide.journeys_using.length;
    });
    
    res.render('pages/guides', {
      guides: guides.rows,
      isTrash: false
    });
    
  } catch (err) {
    console.error('Guides list error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

/**
 * GET /guides/trash - View trash (deleted guides)
 * Only admin and manager can view trash
 */
router.get('/guides/trash', async (req, res) => {
  try {
    const orgId = req.session.organization.id;
    const userRole = req.session.user?.role;

    // Check permissions: only admin and manager can view trash
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).render('pages/error', {
        title: req.t('team.messages.noPermission'),
        message: req.t('guides.delete.noPermission'),
        code: 403
      });
    }

    // Get trash retention days for this organization's tier
    const tierResult = await query(`
      SELECT t.trash_retention_days
      FROM organizations o
      JOIN subscription_tiers t ON o.subscription_tier_id = t.id
      WHERE o.id = $1
    `, [orgId]);
    
    const trashRetentionDays = tierResult.rows[0]?.trash_retention_days || 14;

    const guides = await query(`
      SELECT g.*, 
             (SELECT COUNT(*) FROM knowledge_sources WHERE guide_id = g.id) as knowledge_count
      FROM guides g
      WHERE g.organization_id = $1 AND g.deleted_at IS NOT NULL
      ORDER BY g.deleted_at DESC
    `, [orgId]);

    res.render('pages/guides', {
      guides: guides.rows,
      isTrash: true,
      trashRetentionDays
    });

  } catch (err) {
    console.error('Guides trash error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

/**
 * GET /guides/:id - Guide detail/edit page
 */
router.get('/guides/:id', async (req, res) => {
  try {
    const orgId = req.session.organization.id;
    const guideId = req.params.id;
    
    const guideResult = await query(`
      SELECT * FROM guides WHERE id = $1 AND organization_id = $2
    `, [guideId, orgId]);
    
    if (guideResult.rows.length === 0) {
      return res.status(404).render('pages/error', {
        title: req.t('pages.notFound'),
        message: req.t('errors.pageNotFoundMessage'),
        code: 404
      });
    }
    
    // Check if guide is in trash - don't allow opening
    if (guideResult.rows[0].deleted_at) {
      return res.status(403).render('pages/error', {
        title: req.t('guides.trash.cannotEdit'),
        message: req.t('guides.trash.cannotEditMessage'),
        code: 403
      });
    }
    
    const knowledgeResult = await query(`
      SELECT id, source_type, source_name, status, error_message, chunks_count, created_at, raw_text
      FROM knowledge_sources 
      WHERE guide_id = $1 AND organization_id = $2
      ORDER BY created_at DESC
    `, [guideId, orgId]);
    
    res.render('pages/guide-detail', {
      title: guideResult.rows[0].name,
      guide: guideResult.rows[0],
      knowledge_sources: knowledgeResult.rows.map(source => ({
        ...source,
        error_message: formatKnowledgeError(source.error_message, req.t)
      }))
    });
    
  } catch (err) {
    console.error('Guide detail error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

// ============================================
// INVITATIONS
// ============================================

/**
 * GET /invitations - Invitations management page
 * Viewers cannot access this page
 */
router.get('/invitations', async (req, res) => {
  // Check permissions: viewers cannot access
  if (req.session?.user?.role === 'viewer') {
    return res.status(403).render('pages/error', {
      title: req.t('team.messages.noPermission'),
      message: req.t('team.messages.viewerReadOnly'),
      code: 403
    });
  }
  
  try {
    const orgId = req.session.organization.id;
    
    // Get published journeys (only published can be sent)
    // Exclude public journeys - they use public links, not invitations
    const publishedJourneys = await query(`
      SELECT id, title, description, status, updated_at
      FROM journeys 
      WHERE organization_id = $1 
        AND deleted_at IS NULL 
        AND status = 'published'
        AND (is_public = false OR is_public IS NULL)
      ORDER BY title ASC
    `, [orgId]);
    
    // Get all journeys for showing draft status
    // Exclude public journeys - they use public links, not invitations
    const allJourneys = await query(`
      SELECT id, title, description, status, updated_at
      FROM journeys 
      WHERE organization_id = $1 
        AND deleted_at IS NULL
        AND (is_public = false OR is_public IS NULL)
      ORDER BY 
        CASE WHEN status = 'published' THEN 0 ELSE 1 END,
        title ASC
    `, [orgId]);
    
    // Get end users
    const endUsers = await query(`
      SELECT id, first_name, last_name, email, source, is_active
      FROM end_users 
      WHERE organization_id = $1 AND is_active = true
      ORDER BY first_name ASC, last_name ASC
    `, [orgId]);
    
    // Get existing invitations with user and journey info
    const invitations = await query(`
      SELECT 
        i.*,
        eu.first_name as end_user_first_name,
        eu.last_name as end_user_last_name,
        eu.email as end_user_email,
        j.title as journey_title,
        u.first_name || ' ' || u.last_name as created_by_name
      FROM invitations i
      JOIN end_users eu ON i.end_user_id = eu.id
      JOIN journeys j ON i.journey_id = j.id
      LEFT JOIN users u ON i.created_by = u.id
      WHERE i.organization_id = $1
      ORDER BY i.created_at DESC
      LIMIT 100
    `, [orgId]);
    
    // Get counts by status for filters
    // Note: 'completed' counts journeys with at least one completion, not just status='completed'
    // This matches the dashboard widget and gives a more accurate view of actual completions
    const statusCounts = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'active' AND completions_count = 0) as active,
        COUNT(*) FILTER (WHERE completions_count > 0) as completed,
        COUNT(*) FILTER (WHERE status = 'expired') as expired,
        COUNT(*) FILTER (WHERE status = 'revoked') as revoked
      FROM invitations
      WHERE organization_id = $1
    `, [orgId]);
    
    const row = statusCounts.rows[0];
    const counts = { 
      all: parseInt(row.total) || 0, 
      pending: parseInt(row.pending) || 0, 
      active: parseInt(row.active) || 0, 
      completed: parseInt(row.completed) || 0, 
      expired: parseInt(row.expired) || 0, 
      revoked: parseInt(row.revoked) || 0 
    };
    
    res.render('pages/invitations', {
      publishedJourneys: publishedJourneys.rows,
      allJourneys: allJourneys.rows,
      endUsers: endUsers.rows,
      invitations: invitations.rows,
      statusCounts: counts,
      userRole: req.session.user?.role || 'viewer'
    });
    
  } catch (err) {
    console.error('Invitations page error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

/**
 * GET /settings - User settings page
 */
router.get('/settings', async (req, res) => {
  // For admin users, load organization info for organization settings section
  let organization = req.session.organization;
  let twoFactorEnabled = false;
  
  let marketingConsent = false;
  let lifecycleEmailsEnabled = true;

  // Get user's 2FA and email preference status
  try {
    const userRes = await query(
      'SELECT two_factor_enabled, marketing_consent_at, lifecycle_emails_enabled FROM users WHERE id = $1',
      [req.session.user.id]
    );
    twoFactorEnabled = userRes.rows[0]?.two_factor_enabled || false;
    marketingConsent = !!userRes.rows[0]?.marketing_consent_at;
    lifecycleEmailsEnabled = userRes.rows[0]?.lifecycle_emails_enabled !== false;
  } catch (err) {
    console.error('Failed to load user settings:', err);
  }
  
  if (req.session?.user?.role === 'admin') {
    try {
      const orgRes = await query('SELECT id, name, slug, logo_url, settings FROM organizations WHERE id = $1', [req.session.organization.id]);
      const org = orgRes.rows[0];
      if (org) {
        // Parse settings if it's a string (from JSONB)
        let settings = {};
        if (org.settings) {
          if (typeof org.settings === 'string') {
            try {
              settings = JSON.parse(org.settings);
            } catch (_e) {
              settings = {};
            }
          } else if (typeof org.settings === 'object') {
            settings = org.settings;
          }
        }
        organization = { ...org, settings };
      }
    } catch (err) {
      console.error('Failed to load organization for settings:', err);
    }
  }
  
  res.render('pages/settings', { organization, twoFactorEnabled, marketingConsent, lifecycleEmailsEnabled });
});

/**
 * GET /team - Team management (builder users)
 */
router.get('/team', (req, res) => {
  if (req.session?.user?.role === 'viewer') {
    return res.status(403).render('pages/error', {
      title: req.t('team.messages.noPermission'),
      message: req.t('team.messages.teamAccessDenied'),
      code: 403
    });
  }
  // Load fresh organization info (incl. settings) for Organization card
  query('SELECT id, name, slug, logo_url, settings FROM organizations WHERE id = $1', [req.session.organization.id])
    .then((orgRes) => {
      const org = orgRes.rows[0] || req.session.organization;
      // Parse settings if it's a string (from JSONB)
      let settings = {};
      if (org.settings) {
        if (typeof org.settings === 'string') {
          try {
            settings = JSON.parse(org.settings);
          } catch (e) {
            console.error('Failed to parse org settings:', e);
            settings = {};
          }
        } else if (typeof org.settings === 'object') {
          settings = org.settings;
        }
      }
      // Keep session snapshot in sync (best-effort)
      if (req.session?.organization) {
        req.session.organization.name = org.name || req.session.organization.name;
        req.session.organization.slug = org.slug || req.session.organization.slug;
        req.session.organization.logoUrl = org.logo_url || req.session.organization.logoUrl;
        req.session.organization.settings = settings;
      }
      res.render('pages/team', { organization: { ...org, logoUrl: org.logo_url, settings } });
    })
    .catch((err) => {
      console.error('Team org load error:', err);
      res.render('pages/team', {});
    });
});

/**
 * GET /system-settings - Advanced system settings (admin only)
 */
router.get('/system-settings', requireAdmin, async (req, res) => {
  // Load organization info for organization settings section
  let organization = req.session.organization;
  
  try {
    const orgRes = await query('SELECT id, name, slug, logo_url, settings, country FROM organizations WHERE id = $1', [req.session.organization.id]);
    const org = orgRes.rows[0];
    if (org) {
      // Parse settings if it's a string (from JSONB)
      let settings = {};
      if (org.settings) {
        if (typeof org.settings === 'string') {
          try {
            settings = JSON.parse(org.settings);
          } catch (_e) {
            settings = {};
          }
        } else if (typeof org.settings === 'object') {
          settings = org.settings;
        }
      }
      organization = { ...org, settings };
    }
  } catch (err) {
    console.error('Failed to load organization for system-settings:', err);
  }
  
  // Pass API URL for display in API examples
  const apiUrl = process.env.API_URL || getAppBaseUrl();
  
  res.render('pages/system-settings', { 
    organization, 
    apiUrl,
    googleClientId: await getSetting('google.clientId'),
    targetCountries: localizeCountries(TARGET_COUNTRIES, req.language || 'en'),
    allCountries: localizeCountries(ALL_COUNTRIES, req.language || 'en')
  });
});

/**
 * GET /analytics - Analytics dashboard with poll results
 */
router.get('/analytics', async (req, res) => {
  try {
    const orgId = req.session.organization.id;
    
    // Get all polls with their step and journey info (newest first)
    const pollsResult = await query(`
      SELECT 
        p.id as poll_id,
        p.step_id,
        p.created_at,
        s.title as step_title,
        s.basic_props,
        j.id as journey_id,
        j.title as journey_title,
        (SELECT COUNT(*) FROM poll_responses WHERE poll_id = p.id) as total_votes,
        (SELECT MAX(created_at) FROM poll_responses WHERE poll_id = p.id) as last_vote
      FROM polls p
      JOIN steps s ON p.step_id = s.id
      JOIN journeys j ON s.journey_id = j.id
      WHERE p.organization_id = $1 
        AND j.deleted_at IS NULL
        AND (p.is_archived = false OR p.is_archived IS NULL)
      ORDER BY p.created_at DESC
    `, [orgId]);
    
    // For each poll, get the vote breakdown
    const polls = await Promise.all(pollsResult.rows.map(async (poll) => {
      const votesResult = await query(`
        SELECT 
          unnest(selected_options) as option_index,
          COUNT(*) as vote_count
        FROM poll_responses
        WHERE poll_id = $1
        GROUP BY option_index
        ORDER BY option_index
      `, [poll.poll_id]);
      
      const votes = {};
      votesResult.rows.forEach(row => {
        votes[row.option_index] = parseInt(row.vote_count);
      });
      
      return {
        ...poll,
        votes,
        basic_props: typeof poll.basic_props === 'string' ? JSON.parse(poll.basic_props) : poll.basic_props
      };
    }));
    
    // Get archived polls with restorable status
    const archivedPollsResult = await query(`
      SELECT 
        p.id as poll_id,
        p.step_id,
        p.created_at,
        p.archived_at,
        p.archived_question,
        p.archived_options,
        p.archived_journey_title,
        (SELECT COUNT(*) FROM poll_responses WHERE poll_id = p.id) as total_votes,
        (SELECT MAX(created_at) FROM poll_responses WHERE poll_id = p.id) as last_vote,
        -- Check if restorable: step_id exists AND journey is in trash (not permanently deleted)
        CASE 
          WHEN p.step_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM steps st 
            JOIN journeys jn ON st.journey_id = jn.id 
            WHERE st.id = p.step_id AND jn.deleted_at IS NOT NULL
          ) THEN true
          ELSE false
        END as is_restorable,
        -- Get journey title from linked journey if still exists
        (SELECT jn.title FROM steps st JOIN journeys jn ON st.journey_id = jn.id WHERE st.id = p.step_id) as linked_journey_title
      FROM polls p
      WHERE p.organization_id = $1 AND p.is_archived = true
      ORDER BY p.archived_at DESC
    `, [orgId]);
    
    // For each archived poll, get the vote breakdown
    const archivedPolls = await Promise.all(archivedPollsResult.rows.map(async (poll) => {
      const votesResult = await query(`
        SELECT 
          unnest(selected_options) as option_index,
          COUNT(*) as vote_count
        FROM poll_responses
        WHERE poll_id = $1
        GROUP BY option_index
        ORDER BY option_index
      `, [poll.poll_id]);
      
      const votes = {};
      votesResult.rows.forEach(row => {
        votes[row.option_index] = parseInt(row.vote_count);
      });
      
      // Parse archived options if it's a string
      let archivedOptions = poll.archived_options;
      if (typeof archivedOptions === 'string') {
        try {
          archivedOptions = JSON.parse(archivedOptions);
        } catch (_e) {
          archivedOptions = [];
        }
      }
      
      return {
        ...poll,
        votes,
        basic_props: {
          question: poll.archived_question,
          options: archivedOptions || []
        },
        journey_title: poll.archived_journey_title || 'Deleted Journey'
      };
    }));
    
    // Get usage data for analytics page
    const usageData = await getOrganizationUsageWithLimits(orgId);
    
    // Get active rewards data
    const activeRewardsResult = await query(`
      SELECT 
        r.id,
        r.step_id,
        r.journey_id,
        r.title,
        r.description,
        r.redemption_location,
        r.terms_conditions,
        r.valid_until,
        r.is_random_codes,
        r.max_recipients,
        r.is_archived,
        r.archived_at,
        r.created_at,
        j.title as journey_title,
        s.title as step_title,
        (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id) as total_codes,
        (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id AND is_claimed = true) as claimed_count
      FROM rewards r
      JOIN journeys j ON r.journey_id = j.id
      LEFT JOIN steps s ON r.step_id = s.id
      WHERE r.organization_id = $1 
        AND (r.is_archived = false OR r.is_archived IS NULL)
        AND j.deleted_at IS NULL
      ORDER BY r.created_at DESC
    `, [orgId]);
    
    // Get archived rewards data (from deleted journeys or archived steps)
    const archivedRewardsResult = await query(`
      SELECT 
        r.id,
        r.step_id,
        r.journey_id,
        r.title,
        r.description,
        r.redemption_location,
        r.terms_conditions,
        r.valid_until,
        r.is_random_codes,
        r.max_recipients,
        r.is_archived,
        r.archived_at,
        r.created_at,
        COALESCE(j.title, 'Deleted Journey') as journey_title,
        COALESCE(s.title, 'Deleted Step') as step_title,
        (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id) as total_codes,
        (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id AND is_claimed = true) as claimed_count,
        -- Check if restorable: journey_id exists AND journey is in trash (not permanently deleted)
        CASE 
          WHEN r.journey_id IS NOT NULL AND j.deleted_at IS NOT NULL THEN true
          ELSE false
        END as is_restorable
      FROM rewards r
      LEFT JOIN journeys j ON r.journey_id = j.id
      LEFT JOIN steps s ON r.step_id = s.id
      WHERE r.organization_id = $1 
        AND r.is_archived = true
      ORDER BY r.archived_at DESC
    `, [orgId]);
    
    const rewards = activeRewardsResult.rows.map(r => ({
      ...r,
      total_codes: parseInt(r.total_codes) || 0,
      claimed_count: parseInt(r.claimed_count) || 0
    }));
    
    const archivedRewards = archivedRewardsResult.rows.map(r => ({
      ...r,
      total_codes: parseInt(r.total_codes) || 0,
      claimed_count: parseInt(r.claimed_count) || 0
    }));
    
    // Get journeys for the journey selector dropdown
    const journeysResult = await query(`
      SELECT id, title, status
      FROM journeys
      WHERE organization_id = $1 AND deleted_at IS NULL
      ORDER BY title ASC
    `, [orgId]);
    
    res.render('pages/analytics', {
      polls,
      archivedPolls,
      rewards,
      archivedRewards,
      usageData,
      journeys: journeysResult.rows
    });
    
  } catch (err) {
    console.error('Analytics page error:', err);
    res.status(500).render('pages/error', {
      title: req.t('pages.error'),
      message: req.t('errors.failedToLoad'),
      code: 500
    });
  }
});

// ============================================
// SUBSCRIPTION & PRICING
// ============================================

// Gryffi Cloud routes (subscription page, demo journey admin) live in src/cloud/, which the Community Edition
// does not ship
if (isCloud()) {
  const cloud = await import('../cloud/index.js');
  cloud.registerCloudPages(router);
}

// Community Edition: installation settings page for admins
if (isCommunity()) {
  const { registerInstallationPage } = await import('../setup/installation.js');
  registerInstallationPage(router);
}

export default router;
