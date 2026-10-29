/**
 * Public API Routes - Gryffi
 * RESTful API endpoints for external integrations (automation, third-party apps)
 * 
 * Authentication: API Key in X-API-Key header
 * Base URL: ${API_URL}/api/v1 (configured via environment variable)
 * 
 * Rate Limiting: 5000 requests per 15 minutes per organization
 * (applied after API key validation, so each org gets their own quota)
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { sendInvitationEmail } from '../services/email.js';
import { getOrganizationUsageWithLimits } from '../services/subscription.js';
import { publicApiLimiter, publicApiAuthFailureLimiter } from '../middleware/rateLimit.js';
import { getAppBaseUrl } from '../utils/appUrl.js';

const router = Router();

// ============================================
// API KEY AUTHENTICATION MIDDLEWARE
// ============================================

/**
 * Validate API key and attach organization to request
 */
async function requireApiKey(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'API key required',
        message: 'Please provide your API key in the X-API-Key header'
      });
    }
    
    // API keys are prefixed with 'grf_' for easy identification
    if (!apiKey.startsWith('grf_')) {
      return res.status(401).json({
        success: false,
        error: 'Invalid API key format',
        message: 'API key must start with grf_'
      });
    }
    
    // Find organization with matching API key hash
    // We need to check all organizations since we can't reverse the hash
    // Organizations whose plan includes API access first: valid keys are
    // found after fewer bcrypt compares.
    const orgsResult = await query(`
      SELECT o.id, o.name, o.api_key_hash, o.subscription_tier_id
      FROM organizations o
      LEFT JOIN subscription_tiers t ON t.id = o.subscription_tier_id
      WHERE o.api_key_hash IS NOT NULL
      ORDER BY COALESCE(t.api_access, false) DESC
    `);
    
    let matchedOrg = null;
    for (const org of orgsResult.rows) {
      const isMatch = await bcrypt.compare(apiKey, org.api_key_hash);
      if (isMatch) {
        matchedOrg = org;
        break;
      }
    }
    
    if (!matchedOrg) {
      return res.status(401).json({
        success: false,
        error: 'Invalid API key',
        message: 'The provided API key is not valid or has been revoked'
      });
    }
    
    // Check if organization has API access enabled (tier feature)
    const tierResult = await query(`
      SELECT api_access FROM subscription_tiers WHERE id = $1
    `, [matchedOrg.subscription_tier_id || 1]);
    
    const hasApiAccess = tierResult.rows[0]?.api_access;
    
    if (!hasApiAccess) {
      return res.status(403).json({
        success: false,
        error: 'API access not enabled',
        message: 'Your subscription plan does not include API access. Please upgrade to use the API.'
      });
    }
    
    // Update last used timestamp (non-blocking)
    query(`
      UPDATE organizations SET api_key_last_used_at = NOW() WHERE id = $1
    `, [matchedOrg.id]).catch(err => console.error('Failed to update API key last used:', err));
    
    // Attach organization to request
    req.organization = matchedOrg;
    req.organizationId = matchedOrg.id;
    
    next();
  } catch (err) {
    console.error('API key validation error:', err);
    res.status(500).json({
      success: false,
      error: 'Authentication failed',
      message: 'An error occurred while validating your API key'
    });
  }
}

// Limit failed authentications per IP before the (bcrypt-heavy) key check
router.use(publicApiAuthFailureLimiter);

// Apply API key authentication to all routes
router.use(requireApiKey);

// Apply rate limiting AFTER API key validation (per organization, not per IP)
// This allows each organization 5000 requests per 15 minutes
router.use(publicApiLimiter);

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Validate email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Sanitize string input
 */
function sanitizeString(str, maxLength = 255) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
}

// ============================================
// END USER ENDPOINTS
// ============================================

/**
 * POST /api/v1/end-users
 * Create a new end user
 * 
 * Request body:
 * {
 *   "email": "user@example.com",       // Required
 *   "first_name": "John",              // Required
 *   "last_name": "Doe"                 // Required
 * }
 */
router.post('/end-users', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { email, first_name, last_name } = req.body;
    
    // Validate required fields
    if (!email || !first_name || !last_name) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'email, first_name, and last_name are required'
      });
    }
    
    // Validate email format
    const cleanEmail = sanitizeString(email.toLowerCase(), 255);
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email',
        message: 'Please provide a valid email address'
      });
    }
    
    const cleanFirstName = sanitizeString(first_name, 100);
    const cleanLastName = sanitizeString(last_name, 100);
    
    if (!cleanFirstName || !cleanLastName) {
      return res.status(400).json({
        success: false,
        error: 'Invalid name',
        message: 'First name and last name cannot be empty'
      });
    }
    
    // Check end user limit
    const usageData = await getOrganizationUsageWithLimits(orgId);
    if (usageData && usageData.usage.endUsers.isAtLimit) {
      return res.status(403).json({
        success: false,
        error: 'Limit reached',
        message: `You have reached your end user limit of ${usageData.usage.endUsers.limit}. Please upgrade your plan.`
      });
    }
    
    // Check if user already exists
    const existingResult = await query(
      `SELECT id, first_name, last_name, email FROM end_users 
       WHERE organization_id = $1 AND LOWER(email) = $2`,
      [orgId, cleanEmail]
    );
    
    if (existingResult.rows.length > 0) {
      // Return existing user info
      const existingUser = existingResult.rows[0];
      return res.status(200).json({
        success: true,
        created: false,
        message: 'End user already exists',
        end_user: {
          id: existingUser.id,
          email: existingUser.email,
          first_name: existingUser.first_name,
          last_name: existingUser.last_name
        }
      });
    }
    
    // Create new end user
    const result = await query(
      `INSERT INTO end_users (organization_id, email, first_name, last_name, source)
       VALUES ($1, $2, $3, $4, 'api')
       RETURNING id, email, first_name, last_name, created_at`,
      [orgId, cleanEmail, cleanFirstName, cleanLastName]
    );
    
    const newUser = result.rows[0];
    
    res.status(201).json({
      success: true,
      created: true,
      message: 'End user created successfully',
      end_user: {
        id: newUser.id,
        email: newUser.email,
        first_name: newUser.first_name,
        last_name: newUser.last_name,
        created_at: newUser.created_at
      }
    });
    
  } catch (err) {
    console.error('Public API - Create end user error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while creating the end user'
    });
  }
});

/**
 * DELETE /api/v1/end-users
 * Delete an end user by email
 * 
 * Request body:
 * {
 *   "email": "user@example.com"   // Required
 * }
 */
router.delete('/end-users', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field',
        message: 'email is required'
      });
    }
    
    const cleanEmail = sanitizeString(email.toLowerCase(), 255);
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email',
        message: 'Please provide a valid email address'
      });
    }
    
    // Find the end user
    const existingResult = await query(
      `SELECT id, source FROM end_users 
       WHERE organization_id = $1 AND LOWER(email) = $2`,
      [orgId, cleanEmail]
    );
    
    if (existingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'End user with this email does not exist'
      });
    }
    
    const endUser = existingResult.rows[0];
    
    // Note: We allow API to delete any end user (including synced ones)
    // since API access implies full automation control
    
    // Delete the end user (cascades to invitations, progress, etc.)
    await query(
      `DELETE FROM end_users WHERE id = $1 AND organization_id = $2`,
      [endUser.id, orgId]
    );
    
    res.status(200).json({
      success: true,
      message: 'End user deleted successfully',
      deleted_email: cleanEmail
    });
    
  } catch (err) {
    console.error('Public API - Delete end user error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while deleting the end user'
    });
  }
});

// ============================================
// INVITATION ENDPOINTS
// ============================================

/**
 * POST /api/v1/invitations
 * Invite an end user to a journey
 * Creates the end user if they don't exist
 * 
 * Request body:
 * {
 *   "email": "user@example.com",       // Required
 *   "first_name": "John",              // Required
 *   "last_name": "Doe",                // Required
 *   "journey_id": "uuid",              // Required - the journey to invite to
 *   "validity_days": 14,               // Optional, default: 14 (options: 7, 14, 30, 90)
 *   "max_completions": 1,              // Optional, default: 1 (options: 1, 2, -1 for unlimited)
 *   "send_reminder": false             // Optional, default: false
 * }
 */
router.post('/invitations', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const orgName = req.organization.name;
    const { 
      email, 
      first_name, 
      last_name, 
      journey_id,
      validity_days = 14,
      max_completions = 1,
      send_reminder = false
    } = req.body;
    
    // Validate required fields
    if (!email || !first_name || !last_name || !journey_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'email, first_name, last_name, and journey_id are required'
      });
    }
    
    // Validate email
    const cleanEmail = sanitizeString(email.toLowerCase(), 255);
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email',
        message: 'Please provide a valid email address'
      });
    }
    
    const cleanFirstName = sanitizeString(first_name, 100);
    const cleanLastName = sanitizeString(last_name, 100);
    
    if (!cleanFirstName || !cleanLastName) {
      return res.status(400).json({
        success: false,
        error: 'Invalid name',
        message: 'First name and last name cannot be empty'
      });
    }
    
    // Validate validity_days
    const validDays = [7, 14, 30, 90];
    const cleanValidityDays = validDays.includes(validity_days) ? validity_days : 14;
    
    // Validate max_completions
    const validCompletions = [1, 2, -1];
    const cleanMaxCompletions = validCompletions.includes(max_completions) ? max_completions : 1;
    
    // Validate journey exists and belongs to organization
    const journeyResult = await query(
      `SELECT id, title, status FROM journeys 
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [journey_id, orgId]
    );
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Journey not found',
        message: 'The specified journey does not exist or does not belong to your organization'
      });
    }
    
    const journey = journeyResult.rows[0];
    
    // Check if journey is published
    if (journey.status !== 'published') {
      return res.status(400).json({
        success: false,
        error: 'Journey not published',
        message: 'Only published journeys can be used for invitations'
      });
    }
    
    // Check end user limit before creating (if user doesn't exist)
    const existingUserResult = await query(
      `SELECT id FROM end_users WHERE organization_id = $1 AND LOWER(email) = $2`,
      [orgId, cleanEmail]
    );
    
    let endUserId;
    let userCreated = false;
    
    if (existingUserResult.rows.length > 0) {
      endUserId = existingUserResult.rows[0].id;
    } else {
      // Check limit before creating new user
      const usageData = await getOrganizationUsageWithLimits(orgId);
      if (usageData && usageData.usage.endUsers.isAtLimit) {
        return res.status(403).json({
          success: false,
          error: 'Limit reached',
          message: `You have reached your end user limit of ${usageData.usage.endUsers.limit}. Please upgrade your plan.`
        });
      }
      
      // Create the end user
      const createResult = await query(
        `INSERT INTO end_users (organization_id, email, first_name, last_name, source)
         VALUES ($1, $2, $3, $4, 'api')
         RETURNING id`,
        [orgId, cleanEmail, cleanFirstName, cleanLastName]
      );
      endUserId = createResult.rows[0].id;
      userCreated = true;
    }
    
    // Check for existing active invitation (include org_id for defense in depth)
    const existingInvResult = await query(
      `SELECT id, status FROM invitations 
       WHERE organization_id = $1 AND end_user_id = $2 AND journey_id = $3 AND status IN ('pending', 'active')`,
      [orgId, endUserId, journey_id]
    );
    
    if (existingInvResult.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Invitation exists',
        message: 'This user already has an active invitation for this journey',
        existing_invitation_id: existingInvResult.rows[0].id
      });
    }
    
    // Generate secure token for magic link
    const token = crypto.randomBytes(32).toString('hex');
    
    // Calculate expiry
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + cleanValidityDays);
    
    // Calculate reminder time (halfway through validity period)
    const reminderAt = send_reminder ? new Date() : null;
    if (reminderAt) {
      reminderAt.setDate(reminderAt.getDate() + Math.floor(cleanValidityDays / 2));
    }
    
    // Create invitation
    const invResult = await query(
      `INSERT INTO invitations (
        organization_id, token, journey_id, end_user_id, 
        expires_at, max_completions, send_reminder, reminder_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, token, expires_at`,
      [orgId, token, journey_id, endUserId, expiresAt, 
       cleanMaxCompletions === -1 ? null : cleanMaxCompletions,
       send_reminder, reminderAt]
    );
    
    const invitation = invResult.rows[0];
    
    // Generate magic link
    const magicLink = `${getAppBaseUrl()}/e/${token}`;
    
    // Get organization language for email
    const orgResult = await query(`SELECT language FROM organizations WHERE id = $1`, [orgId]);
    const orgLanguage = orgResult.rows[0]?.language || 'en';
    
    // Format validity text
    const validityText = cleanValidityDays === 7 ? '1 week' :
                         cleanValidityDays === 14 ? '2 weeks' :
                         cleanValidityDays === 30 ? '1 month' :
                         `${cleanValidityDays} days`;
    
    // For API-driven invites there is no individual maker in the request, so
    // route the unsubscribe to the org's primary admin (the human responsible
    // for the API key). Falls back to the central inbox if no admin is found.
    let primaryAdminEmail = null;
    try {
      const adminResult = await query(
        `SELECT email FROM users
         WHERE organization_id = $1 AND role = 'admin' AND is_active = true
         ORDER BY created_at ASC
         LIMIT 1`,
        [orgId]
      );
      primaryAdminEmail = adminResult.rows[0]?.email || null;
    } catch (lookupErr) {
      console.warn('Failed to look up primary admin for unsubscribe routing:', lookupErr.message);
    }
    
    // Send invitation email
    try {
      await sendInvitationEmail({
        to: cleanEmail,
        firstName: cleanFirstName,
        journeyTitle: journey.title,
        companyName: orgName,
        magicLink: magicLink,
        validityText: validityText,
        language: orgLanguage,
        orgId: orgId, // For custom theme support
        unsubscribeEmail: primaryAdminEmail
      });
    } catch (emailErr) {
      console.error('Failed to send invitation email:', emailErr);
      // Don't fail the request, invitation is created
    }
    
    res.status(201).json({
      success: true,
      message: 'Invitation sent successfully',
      invitation: {
        id: invitation.id,
        journey_id: journey_id,
        journey_title: journey.title,
        end_user_email: cleanEmail,
        end_user_created: userCreated,
        expires_at: invitation.expires_at,
        magic_link: magicLink,
        max_completions: cleanMaxCompletions === -1 ? 'unlimited' : cleanMaxCompletions,
        send_reminder: send_reminder
      }
    });
    
  } catch (err) {
    console.error('Public API - Create invitation error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while creating the invitation'
    });
  }
});

/**
 * GET /api/v1/journeys
 * List all published journeys (for API consumers to know which journeys they can invite to)
 */
router.get('/journeys', async (req, res) => {
  try {
    const orgId = req.organizationId;
    
    const result = await query(
      `SELECT id, title, description, status, published_at, created_at
       FROM journeys 
       WHERE organization_id = $1 AND deleted_at IS NULL AND status = 'published'
       ORDER BY title ASC`,
      [orgId]
    );
    
    res.status(200).json({
      success: true,
      journeys: result.rows.map(j => ({
        id: j.id,
        title: j.title,
        description: j.description,
        published_at: j.published_at,
        created_at: j.created_at
      }))
    });
    
  } catch (err) {
    console.error('Public API - List journeys error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while listing journeys'
    });
  }
});

// ============================================
// GROUP ENDPOINTS
// ============================================

/**
 * GET /api/v1/groups
 * List all groups in the organization
 */
router.get('/groups', async (req, res) => {
  try {
    const orgId = req.organizationId;
    
    const result = await query(
      `SELECT g.id, g.name, g.description, g.source, g.created_at,
              COUNT(gm.end_user_id) as member_count
       FROM end_user_groups g
       LEFT JOIN end_user_group_members gm ON g.id = gm.group_id
       WHERE g.organization_id = $1
       GROUP BY g.id
       ORDER BY g.name ASC`,
      [orgId]
    );
    
    res.status(200).json({
      success: true,
      groups: result.rows.map(g => ({
        id: g.id,
        name: g.name,
        description: g.description,
        source: g.source,
        member_count: parseInt(g.member_count) || 0,
        created_at: g.created_at
      }))
    });
    
  } catch (err) {
    console.error('Public API - List groups error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while listing groups'
    });
  }
});

/**
 * GET /api/v1/groups/:id/members
 * List all members of a specific group
 */
router.get('/groups/:id/members', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    
    // Check if group exists and belongs to org
    const groupResult = await query(
      `SELECT id, name FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    if (groupResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Group not found',
        message: 'The specified group does not exist or does not belong to your organization'
      });
    }
    
    // Get members
    const membersResult = await query(
      `SELECT eu.id, eu.email, eu.first_name, eu.last_name, gm.added_at
       FROM end_user_group_members gm
       JOIN end_users eu ON gm.end_user_id = eu.id
       WHERE gm.group_id = $1
       ORDER BY eu.first_name, eu.last_name`,
      [groupId]
    );
    
    res.status(200).json({
      success: true,
      group: {
        id: groupResult.rows[0].id,
        name: groupResult.rows[0].name
      },
      members: membersResult.rows.map(m => ({
        id: m.id,
        email: m.email,
        first_name: m.first_name,
        last_name: m.last_name,
        added_at: m.added_at
      }))
    });
    
  } catch (err) {
    console.error('Public API - List group members error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while listing group members'
    });
  }
});

/**
 * POST /api/v1/groups
 * Create a new group
 * 
 * Request body:
 * {
 *   "name": "Marketing Team",       // Required
 *   "description": "Optional desc"  // Optional
 * }
 */
router.post('/groups', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { name, description } = req.body;
    
    // Validate required fields
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field',
        message: 'Group name is required'
      });
    }
    
    const nameTrimmed = sanitizeString(name, 100);
    const descTrimmed = description ? sanitizeString(description, 500) : null;
    
    if (!nameTrimmed) {
      return res.status(400).json({
        success: false,
        error: 'Invalid group name',
        message: 'Group name cannot be empty'
      });
    }
    
    // Check if name already exists
    const existing = await query(
      `SELECT id FROM end_user_groups WHERE organization_id = $1 AND LOWER(name) = LOWER($2)`,
      [orgId, nameTrimmed]
    );
    
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Group already exists',
        message: `A group with the name "${nameTrimmed}" already exists`
      });
    }
    
    // Create the group
    const result = await query(
      `INSERT INTO end_user_groups (organization_id, name, description, source)
       VALUES ($1, $2, $3, 'api')
       RETURNING id, name, description, source, created_at`,
      [orgId, nameTrimmed, descTrimmed]
    );
    
    const group = result.rows[0];
    
    res.status(201).json({
      success: true,
      message: 'Group created successfully',
      group: {
        id: group.id,
        name: group.name,
        description: group.description,
        source: group.source,
        member_count: 0,
        created_at: group.created_at
      }
    });
    
  } catch (err) {
    console.error('Public API - Create group error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while creating the group'
    });
  }
});

/**
 * POST /api/v1/groups/:id/members
 * Add members to a group
 * 
 * Request body:
 * {
 *   "emails": ["user1@example.com", "user2@example.com"]  // Required - array of email addresses
 * }
 */
router.post('/groups/:id/members', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    const { emails } = req.body;
    
    // Validate input
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field',
        message: 'An array of email addresses is required'
      });
    }
    
    // Check if group exists
    const groupResult = await query(
      `SELECT id, name FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    if (groupResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Group not found',
        message: 'The specified group does not exist or does not belong to your organization'
      });
    }
    
    const results = {
      added: [],
      already_member: [],
      user_not_found: []
    };
    
    for (const email of emails) {
      const emailLower = String(email).trim().toLowerCase();
      
      if (!isValidEmail(emailLower)) {
        results.user_not_found.push(email);
        continue;
      }
      
      // Find the user
      const userResult = await query(
        `SELECT id FROM end_users WHERE organization_id = $1 AND LOWER(email) = $2`,
        [orgId, emailLower]
      );
      
      if (userResult.rows.length === 0) {
        results.user_not_found.push(email);
        continue;
      }
      
      const userId = userResult.rows[0].id;
      
      // Check if already a member
      const memberCheck = await query(
        `SELECT 1 FROM end_user_group_members WHERE group_id = $1 AND end_user_id = $2`,
        [groupId, userId]
      );
      
      if (memberCheck.rows.length > 0) {
        results.already_member.push(email);
        continue;
      }
      
      // Add to group
      await query(
        `INSERT INTO end_user_group_members (group_id, end_user_id) VALUES ($1, $2)`,
        [groupId, userId]
      );
      
      results.added.push(email);
    }
    
    res.status(200).json({
      success: true,
      message: `Added ${results.added.length} member(s) to group`,
      results
    });
    
  } catch (err) {
    console.error('Public API - Add group members error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while adding members to the group'
    });
  }
});

/**
 * DELETE /api/v1/groups/:id/members
 * Remove members from a group
 * 
 * Request body:
 * {
 *   "emails": ["user1@example.com", "user2@example.com"]  // Required - array of email addresses
 * }
 */
router.delete('/groups/:id/members', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    const { emails } = req.body;
    
    // Validate input
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field',
        message: 'An array of email addresses is required'
      });
    }
    
    // Check if group exists
    const groupResult = await query(
      `SELECT id, name FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    if (groupResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Group not found',
        message: 'The specified group does not exist or does not belong to your organization'
      });
    }
    
    const results = {
      removed: [],
      not_member: [],
      user_not_found: []
    };
    
    for (const email of emails) {
      const emailLower = String(email).trim().toLowerCase();
      
      if (!isValidEmail(emailLower)) {
        results.user_not_found.push(email);
        continue;
      }
      
      // Find the user
      const userResult = await query(
        `SELECT id FROM end_users WHERE organization_id = $1 AND LOWER(email) = $2`,
        [orgId, emailLower]
      );
      
      if (userResult.rows.length === 0) {
        results.user_not_found.push(email);
        continue;
      }
      
      const userId = userResult.rows[0].id;
      
      // Check if is a member
      const memberCheck = await query(
        `SELECT 1 FROM end_user_group_members WHERE group_id = $1 AND end_user_id = $2`,
        [groupId, userId]
      );
      
      if (memberCheck.rows.length === 0) {
        results.not_member.push(email);
        continue;
      }
      
      // Remove from group
      await query(
        `DELETE FROM end_user_group_members WHERE group_id = $1 AND end_user_id = $2`,
        [groupId, userId]
      );
      
      results.removed.push(email);
    }
    
    res.status(200).json({
      success: true,
      message: `Removed ${results.removed.length} member(s) from group`,
      results
    });
    
  } catch (err) {
    console.error('Public API - Remove group members error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while removing members from the group'
    });
  }
});

/**
 * DELETE /api/v1/groups/:id
 * Delete a group (only if it has no members)
 */
router.delete('/groups/:id', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    
    // Check if group exists
    const groupResult = await query(
      `SELECT id, name FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    if (groupResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Group not found',
        message: 'The specified group does not exist or does not belong to your organization'
      });
    }
    
    const groupName = groupResult.rows[0].name;
    
    // Check if group has members
    const memberCount = await query(
      `SELECT COUNT(*) as count FROM end_user_group_members WHERE group_id = $1`,
      [groupId]
    );
    
    const count = parseInt(memberCount.rows[0].count);
    
    if (count > 0) {
      return res.status(400).json({
        success: false,
        error: 'Group not empty',
        message: `Cannot delete group "${groupName}" because it still has ${count} member(s). Remove all members first.`
      });
    }
    
    // Delete the group
    await query(
      `DELETE FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    res.status(200).json({
      success: true,
      message: `Group "${groupName}" deleted successfully`
    });
    
  } catch (err) {
    console.error('Public API - Delete group error:', err);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: 'An error occurred while deleting the group'
    });
  }
});

export default router;
