/**
 * Subscription & Tier Service - Gryffi
 * 
 * Handles subscription tier management, usage tracking, and limit enforcement.
 * 
 * Tier Levels:
 * 1. Free - Testing & solo users
 * 2. Professional - Small teams & SMBs  
 * 3. Enterprise - Larger organizations
 * 4. Custom - Enterprise with custom limits
 */

import { query } from '../db/index.js';
import { sendAiCreditsEmail } from './email.js';
import { getSetting } from './settings.js';
import { isCommunity } from '../edition.js';

// Tier constants
export const TIERS = {
  FREE: 'free',
  PROFESSIONAL: 'professional',
  ENTERPRISE: 'enterprise',
  CUSTOM: 'custom'
};

// Resource types for limit checking
export const RESOURCE_TYPES = {
  JOURNEYS: 'journeys',
  GUIDES: 'guides',
  MAKERS: 'makers',
  END_USERS: 'end_users',
  KNOWLEDGE_CHUNKS: 'knowledge_chunks',
  AI_CREDITS: 'ai_credits'
};

// Cache for tier data (refreshed every 5 minutes)
let tierCache = null;
let tierCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for organization tier data (refreshed every 1 minute)
// This reduces database queries on every page load
const orgTierCache = new Map();
const ORG_TIER_CACHE_TTL = 60 * 1000; // 1 minute

/**
 * Invalidate organization tier cache for a specific organization
 * Call this after tier upgrades, settings changes, etc.
 */
export function invalidateOrgTierCache(organizationId) {
  if (organizationId) {
    orgTierCache.delete(organizationId);
  } else {
    // Clear all org caches
    orgTierCache.clear();
  }
}

/**
 * Get cache statistics (for debugging/monitoring)
 */
export function getCacheStats() {
  return {
    tierCache: {
      cached: tierCache !== null,
      age: tierCache ? Date.now() - tierCacheTime : null,
      ttl: CACHE_TTL
    },
    orgTierCache: {
      size: orgTierCache.size,
      ttl: ORG_TIER_CACHE_TTL
    }
  };
}

/**
 * Get all subscription tiers
 */
export async function getAllTiers() {
  const now = Date.now();
  if (tierCache && (now - tierCacheTime) < CACHE_TTL) {
    return tierCache;
  }
  
  const result = await query(
    'SELECT * FROM subscription_tiers WHERE is_active = true ORDER BY sort_order ASC'
  );
  
  tierCache = result.rows;
  tierCacheTime = now;
  return tierCache;
}

/**
 * Community Edition: put every organization on the "community" tier (no limits,
 * all features). Runs at startup, so a database restored from elsewhere or an
 * organization created before the switch ends up on the right tier too.
 * @returns {Promise<number>} Number of organizations that were moved
 */
export async function ensureCommunityTier() {
  const result = await query(`
    UPDATE organizations
    SET subscription_tier_id = (SELECT id FROM subscription_tiers WHERE name = 'community'),
        subscription_status = 'active'
    WHERE subscription_tier_id IS DISTINCT FROM (SELECT id FROM subscription_tiers WHERE name = 'community')
  `);
  orgTierCache.clear();
  return result.rowCount;
}

/**
 * Get tier by ID or name
 */
export async function getTier(tierIdOrName) {
  const tiers = await getAllTiers();
  return tiers.find(t => 
    t.id === tierIdOrName || 
    t.name === tierIdOrName || 
    t.id === parseInt(tierIdOrName)
  );
}

/**
 * Get organization's current tier with limits
 * Uses in-memory cache to reduce database queries on every page load
 */
export async function getOrganizationTier(organizationId) {
  // Check cache first
  const cached = orgTierCache.get(organizationId);
  if (cached && (Date.now() - cached.time) < ORG_TIER_CACHE_TTL) {
    return cached.data;
  }
  
  const result = await query(`
    SELECT o.*, t.*,
           o.id as org_id,
           t.id as tier_id,
           t.name as tier_name,
           t.display_name as tier_display_name
    FROM organizations o
    LEFT JOIN subscription_tiers t ON o.subscription_tier_id = t.id
    WHERE o.id = $1
  `, [organizationId]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const row = result.rows[0];
  const data = {
    organizationId: row.org_id,
    organizationName: row.name,
    tier: {
      id: row.tier_id,
      name: row.tier_name,
      displayName: row.tier_display_name,
      sort_order: row.sort_order,
      limits: {
        maxJourneys: row.max_journeys,
        maxGuides: row.max_guides,
        maxMakers: row.max_makers,
        maxEndUsers: row.max_end_users,
        maxKnowledgeChunks: row.max_knowledge_chunks,
        maxAiCreditsMonthly: row.max_ai_credits_monthly
      },
      features: {
        syncEnabled: row.sync_enabled,
        prioritySupport: row.priority_support,
        dedicatedSupport: row.dedicated_support,
        customBranding: row.custom_branding,
        publicJourneys: row.public_journeys,
        apiAccess: row.api_access
      },
      price: {
        monthly: parseFloat(row.price_monthly) || 0,
        yearly: parseFloat(row.price_yearly) || 0
      }
    },
    subscription: {
      status: row.subscription_status,
      billingCycleStart: row.billing_cycle_start,
      billingCycleEnd: row.billing_cycle_end,
      creemCustomerId: row.creem_customer_id,
      creemSubscriptionId: row.creem_subscription_id,
      trialEndsAt: row.trial_ends_at
    }
  };
  
  // Store in cache
  orgTierCache.set(organizationId, { data, time: Date.now() });
  
  return data;
}

/**
 * Get current usage counts for an organization
 */
export async function getOrganizationUsage(organizationId) {
  // Get current counts from database
  // Note: journeys in trash (deleted_at IS NOT NULL) are not counted towards the limit
  const countsResult = await query(`
    SELECT 
      (SELECT COUNT(*) FROM journeys WHERE organization_id = $1 AND deleted_at IS NULL) as journeys_count,
      (SELECT COUNT(*) FROM guides WHERE organization_id = $1 AND deleted_at IS NULL) as guides_count,
      (SELECT COUNT(*) FROM users WHERE organization_id = $1 AND (is_visible IS NULL OR is_visible = true)) as makers_count,
      (SELECT COUNT(*) FROM end_users WHERE organization_id = $1) as end_users_count,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE organization_id = $1) as knowledge_chunks_count
  `, [organizationId]);
  
  const counts = countsResult.rows[0];
  
  // Get current billing period AI credits usage
  const usageResult = await query(`
    SELECT ai_credits_used, period_start, period_end
    FROM organization_usage
    WHERE organization_id = $1
    AND period_start <= NOW()
    AND period_end > NOW()
    ORDER BY period_start DESC
    LIMIT 1
  `, [organizationId]);
  
  let aiCreditsUsed = 0;
  let periodStart = null;
  let periodEnd = null;
  
  if (usageResult.rows.length > 0) {
    aiCreditsUsed = usageResult.rows[0].ai_credits_used;
    periodStart = usageResult.rows[0].period_start;
    periodEnd = usageResult.rows[0].period_end;
  }
  
  return {
    journeys: parseInt(counts.journeys_count) || 0,
    guides: parseInt(counts.guides_count) || 0,
    makers: parseInt(counts.makers_count) || 0,
    endUsers: parseInt(counts.end_users_count) || 0,
    knowledgeChunks: parseInt(counts.knowledge_chunks_count) || 0,
    aiCredits: aiCreditsUsed,
    billingPeriod: {
      start: periodStart,
      end: periodEnd
    }
  };
}

/**
 * Get usage with tier context (usage + limits + percentages)
 */
export async function getOrganizationUsageWithLimits(organizationId) {
  const [tierData, usage] = await Promise.all([
    getOrganizationTier(organizationId),
    getOrganizationUsage(organizationId)
  ]);
  
  if (!tierData) {
    return null;
  }
  
  let limits = tierData.tier.limits;
  
  // Community Edition: the administrator may cap the AI questions per month to
  // control costs (ai.monthlyQuestionLimit); without a cap the tier's -1 applies
  if (isCommunity()) {
    const cap = await getSetting('ai.monthlyQuestionLimit');
    if (cap !== null) limits = { ...limits, maxAiCreditsMonthly: cap };
  }
  
  // Calculate percentages and remaining (-1 means unlimited)
  const calculateUsage = (used, limit) => {
    const isUnlimited = limit === -1;
    return {
      used,
      limit: isUnlimited ? null : limit,
      remaining: isUnlimited ? null : Math.max(0, limit - used),
      percentage: isUnlimited ? 0 : Math.min(100, Math.round((used / limit) * 100)),
      isUnlimited,
      isAtLimit: !isUnlimited && used >= limit,
      isNearLimit: !isUnlimited && used >= limit * 0.8 // 80% threshold
    };
  };
  
  return {
    tier: tierData.tier,
    subscription: tierData.subscription,
    usage: {
      journeys: calculateUsage(usage.journeys, limits.maxJourneys),
      guides: calculateUsage(usage.guides, limits.maxGuides),
      makers: calculateUsage(usage.makers, limits.maxMakers),
      endUsers: calculateUsage(usage.endUsers, limits.maxEndUsers),
      knowledgeChunks: calculateUsage(usage.knowledgeChunks, limits.maxKnowledgeChunks),
      aiCredits: calculateUsage(usage.aiCredits, limits.maxAiCreditsMonthly)
    },
    billingPeriod: usage.billingPeriod
  };
}

/**
 * Check if organization can create/add a resource
 * Returns { allowed: boolean, reason?: string, limit?: number, current?: number }
 */
export async function checkLimit(organizationId, resourceType, increment = 1) {
  const usageData = await getOrganizationUsageWithLimits(organizationId);
  
  if (!usageData) {
    return { allowed: false, reason: 'Organization not found' };
  }
  
  const resourceMap = {
    [RESOURCE_TYPES.JOURNEYS]: usageData.usage.journeys,
    [RESOURCE_TYPES.GUIDES]: usageData.usage.guides,
    [RESOURCE_TYPES.MAKERS]: usageData.usage.makers,
    [RESOURCE_TYPES.END_USERS]: usageData.usage.endUsers,
    [RESOURCE_TYPES.KNOWLEDGE_CHUNKS]: usageData.usage.knowledgeChunks,
    [RESOURCE_TYPES.AI_CREDITS]: usageData.usage.aiCredits
  };
  
  const resource = resourceMap[resourceType];
  
  if (!resource) {
    return { allowed: true }; // Unknown resource type, allow by default
  }
  
  if (resource.isUnlimited) {
    return { allowed: true, isUnlimited: true };
  }
  
  const wouldExceed = (resource.used + increment) > resource.limit;
  
  if (wouldExceed) {
    return {
      allowed: false,
      reason: 'limit_exceeded',
      resourceType,
      current: resource.used,
      limit: resource.limit,
      tier: usageData.tier.name,
      tierDisplayName: usageData.tier.displayName
    };
  }
  
  return {
    allowed: true,
    current: resource.used,
    limit: resource.limit,
    remaining: resource.remaining - increment,
    isNearLimit: resource.isNearLimit
  };
}

// End users may go this far over the monthly AI question limit, so a running
// onboarding does not stop the moment the limit is reached
export const AI_PLAYER_GRACE = 1.1;

/**
 * Whether an AI guide may answer now (1 AI credit = 1 answered question).
 * Makers stop at the monthly limit, end users at 110% of it.
 * @param {string} organizationId
 * @param {'maker'|'player'} audience
 */
export async function hasAiCreditsLeft(organizationId, audience = 'maker') {
  const usageData = await getOrganizationUsageWithLimits(organizationId);
  const credits = usageData?.usage.aiCredits;
  if (!credits) return false;
  if (credits.isUnlimited) return true;
  const limit = audience === 'player' ? credits.limit * AI_PLAYER_GRACE : credits.limit;
  return Number(credits.used) < limit;
}

/**
 * Email the organization's admins once per billing period when the AI questions
 * reach 80% and again at 100% of the limit.
 */
async function notifyAiCreditThresholds(organizationId) {
  const usageData = await getOrganizationUsageWithLimits(organizationId);
  const credits = usageData?.usage.aiCredits;
  const periodStart = usageData?.billingPeriod?.start;
  if (!credits || credits.isUnlimited || !credits.limit || !periodStart) return;

  const used = Number(credits.used);
  const level = used >= credits.limit ? 100 : (used >= credits.limit * 0.8 ? 80 : 0);
  if (!level) return;

  const inserted = await query(`
    INSERT INTO limit_notifications (organization_id, limit_type, current_value, limit_value)
    SELECT $1::uuid, $2::varchar, $3::integer, $4::integer
    WHERE NOT EXISTS (
      SELECT 1 FROM limit_notifications
      WHERE organization_id = $1::uuid AND limit_type = $2::varchar AND notified_at >= $5::timestamptz
    )
    RETURNING id
  `, [organizationId, `ai_credits_${level}`, Math.floor(used), credits.limit, periodStart]);
  if (inserted.rows.length === 0) return;

  const [orgResult, adminsResult] = await Promise.all([
    query('SELECT name, language FROM organizations WHERE id = $1', [organizationId]),
    query(`SELECT email FROM users WHERE organization_id = $1 AND role = 'admin' AND is_active = true`, [organizationId])
  ]);
  const org = orgResult.rows[0];
  for (const admin of adminsResult.rows) {
    await sendAiCreditsEmail({
      to: admin.email,
      organizationName: org?.name || '',
      level,
      limit: credits.limit,
      extraQuestions: Math.floor(credits.limit * AI_PLAYER_GRACE) - credits.limit,
      resetDate: usageData.billingPeriod.end,
      language: org?.language || 'en'
    });
  }
  console.log(`[AI Credits] Org ${organizationId} reached ${level}% of its AI questions; emailed ${adminsResult.rows.length} admin(s)`);
}

/**
 * Track AI credit usage. Callers pass 1 credit per answered question; the model
 * and tokens are kept in usage_events for cost insight.
 */
export async function trackAiCredits(organizationId, credits, metadata = {}) {
  // Ensure billing period exists
  await ensureBillingPeriod(organizationId);
  
  // Round credits to 2 decimals
  const roundedCredits = Math.round(credits * 100) / 100;
  
  // Update usage counter
  await query(`
    UPDATE organization_usage
    SET ai_credits_used = ai_credits_used + $2,
        updated_at = NOW()
    WHERE organization_id = $1
    AND period_start <= NOW()
    AND period_end > NOW()
  `, [organizationId, roundedCredits]);
  
  // Log the event
  await query(`
    INSERT INTO usage_events (organization_id, event_type, ai_credits_used, ai_model, ai_tokens_input, ai_tokens_output, metadata)
    VALUES ($1, 'ai_chat', $2, $3, $4, $5, $6)
  `, [
    organizationId, 
    roundedCredits, 
    metadata.model || null,
    metadata.tokensInput || null,
    metadata.tokensOutput || null,
    JSON.stringify(metadata)
  ]);
  
  console.log(`[AI Credits] Tracked ${roundedCredits} credits for org ${organizationId} (${metadata.tokensInput || 0} input + ${metadata.tokensOutput || 0} output tokens)`);
  
  notifyAiCreditThresholds(organizationId)
    .catch(err => console.error('[AI Credits] Threshold notification failed:', err));
  
  return true;
}

/**
 * Log a usage event (journey created, guide added, etc.)
 */
export async function logUsageEvent(organizationId, eventType, resourceType, resourceId, userId = null, metadata = {}) {
  await query(`
    INSERT INTO usage_events (organization_id, user_id, event_type, resource_type, resource_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [organizationId, userId, eventType, resourceType, resourceId, JSON.stringify(metadata)]);
}

/**
 * Ensure a billing period exists for the current month
 */
export async function ensureBillingPeriod(organizationId) {
  // Check if current period exists
  const existingResult = await query(`
    SELECT id FROM organization_usage
    WHERE organization_id = $1
    AND period_start <= NOW()
    AND period_end > NOW()
  `, [organizationId]);
  
  if (existingResult.rows.length > 0) {
    return existingResult.rows[0].id;
  }
  
  // Get organization's billing cycle start
  const orgResult = await query(
    'SELECT billing_cycle_start FROM organizations WHERE id = $1',
    [organizationId]
  );
  
  let cycleStart = orgResult.rows[0]?.billing_cycle_start;
  if (!cycleStart) {
    cycleStart = new Date();
    await query(
      'UPDATE organizations SET billing_cycle_start = $2 WHERE id = $1',
      [organizationId, cycleStart]
    );
  }
  
  // Calculate current billing period (monthly)
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), new Date(cycleStart).getDate());
  if (periodStart > now) {
    periodStart.setMonth(periodStart.getMonth() - 1);
  }
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  
  // Create new period
  const result = await query(`
    INSERT INTO organization_usage (organization_id, period_start, period_end)
    VALUES ($1, $2, $3)
    ON CONFLICT (organization_id, period_start) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [organizationId, periodStart, periodEnd]);
  
  return result.rows[0].id;
}

/**
 * Record a limit notification (to prevent spam)
 */
export async function recordLimitNotification(organizationId, limitType, currentValue, limitValue) {
  // Check if we already notified in this period
  const existing = await query(`
    SELECT id FROM limit_notifications
    WHERE organization_id = $1
    AND limit_type = $2
    AND notified_at > NOW() - INTERVAL '24 hours'
  `, [organizationId, limitType]);
  
  if (existing.rows.length > 0) {
    return null; // Already notified recently
  }
  
  const result = await query(`
    INSERT INTO limit_notifications (organization_id, limit_type, current_value, limit_value)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [organizationId, limitType, currentValue, limitValue]);
  
  return result.rows[0];
}

/**
 * Get pending limit notifications for an organization
 */
export async function getPendingNotifications(organizationId) {
  const result = await query(`
    SELECT * FROM limit_notifications
    WHERE organization_id = $1
    AND acknowledged_at IS NULL
    ORDER BY notified_at DESC
  `, [organizationId]);
  
  return result.rows;
}

/**
 * Acknowledge a limit notification
 */
export async function acknowledgeNotification(notificationId, userId) {
  await query(`
    UPDATE limit_notifications
    SET acknowledged_at = NOW(), acknowledged_by = $2
    WHERE id = $1
  `, [notificationId, userId]);
}

/**
 * Upgrade organization to a new tier
 * Called after a successful payment; creemData holds the billing references.
 */
export async function upgradeTier(organizationId, newTierName, creemData = null) {
  const tier = await getTier(newTierName);
  
  if (!tier) {
    throw new Error(`Tier '${newTierName}' not found`);
  }
  
  await query(`
    UPDATE organizations
    SET subscription_tier_id = $2,
        subscription_status = 'active',
        creem_customer_id = $3,
        creem_subscription_id = $4,
        updated_at = NOW()
    WHERE id = $1
  `, [
    organizationId, 
    tier.id, 
    creemData?.customerId || null,
    creemData?.subscriptionId || null
  ]);
  
  // Invalidate the organization tier cache since tier changed
  invalidateOrgTierCache(organizationId);
  
  // Log the upgrade event
  await logUsageEvent(organizationId, 'tier_upgrade', 'subscription', null, null, {
    newTier: newTierName,
    tierId: tier.id
  });
  
  return tier;
}

/**
 * Get usage statistics for a time period (for analytics)
 */
export async function getUsageStats(organizationId, startDate, endDate) {
  const result = await query(`
    SELECT 
      event_type,
      COUNT(*) as count,
      SUM(ai_credits_used) as total_ai_credits,
      DATE_TRUNC('day', created_at) as date
    FROM usage_events
    WHERE organization_id = $1
    AND created_at >= $2
    AND created_at < $3
    GROUP BY event_type, DATE_TRUNC('day', created_at)
    ORDER BY date DESC
  `, [organizationId, startDate, endDate]);
  
  return result.rows;
}

/**
 * Check if a feature is enabled for the organization's tier
 */
export async function isFeatureEnabled(organizationId, featureName) {
  const tierData = await getOrganizationTier(organizationId);
  
  if (!tierData) {
    return false;
  }
  
  const featureMap = {
    'sync': tierData.tier.features.syncEnabled,
    'priority_support': tierData.tier.features.prioritySupport,
    'dedicated_support': tierData.tier.features.dedicatedSupport,
    'custom_branding': tierData.tier.features.customBranding,
    'public_journeys': tierData.tier.features.publicJourneys,
    'api_access': tierData.tier.features.apiAccess
  };
  
  return featureMap[featureName] ?? false;
}

/**
 * End user room for a directory sync run. Users who are already an end user
 * of the organization (any source) never count against the limit, so a sync
 * keeps updating everyone it already has and only stops adding new people.
 * @returns {Promise<{remaining: number, limit: number|null, existingEmails: Set<string>}>}
 *   remaining is Infinity on an unlimited tier
 */
export async function getSyncEndUserAllowance(organizationId) {
  const usageData = await getOrganizationUsageWithLimits(organizationId);
  const endUsers = usageData?.usage.endUsers;
  const existing = await query(
    'SELECT lower(email) AS email FROM end_users WHERE organization_id = $1',
    [organizationId]
  );

  return {
    remaining: !endUsers ? 0 : (endUsers.isUnlimited ? Infinity : endUsers.remaining),
    limit: endUsers?.limit ?? null,
    existingEmails: new Set(existing.rows.map(row => row.email))
  };
}
