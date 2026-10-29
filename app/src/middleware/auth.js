/**
 * Authentication Middleware
 * Handles session validation and organization isolation
 */

import { query } from '../db/index.js';

// How long a session may trust its cached role before checking the database
const USER_RECHECK_MS = 30 * 1000;

/**
 * Re-validate the logged-in maker against the database.
 * The session caches role and organization for up to 7 days. Without this
 * check a deactivated, removed or demoted maker would keep the old rights
 * until the session expires. Runs at most once per USER_RECHECK_MS per session.
 */
export const refreshSessionUser = async (req, res, next) => {
  const sessionUser = req.session?.user;
  if (!sessionUser?.id) return next();
  if (Date.now() - (req.session.userCheckedAt || 0) < USER_RECHECK_MS) return next();

  try {
    const result = await query(
      'SELECT role, is_active, organization_id FROM users WHERE id = $1',
      [sessionUser.id]
    );
    const row = result.rows[0];

    if (!row || row.is_active === false || row.organization_id !== req.session.organization?.id) {
      // Account removed, deactivated or moved: continue as a guest
      return req.session.regenerate((err) => {
        if (err) console.error('[Auth] Failed to reset session for removed user:', err);
        next();
      });
    }

    if (row.role !== sessionUser.role) {
      req.session.user.role = row.role;
    }
    req.session.userCheckedAt = Date.now();
  } catch (err) {
    // Keep serving on a transient DB error; the next request checks again
    console.error('[Auth] Session user check failed:', err.message);
  }
  next();
};

/**
 * Require authentication - redirects to login if not authenticated
 */
export const requireAuth = (req, res, next) => {
  if (req.session?.user) {
    // Add user to res.locals for EJS templates
    res.locals.user = req.session.user;
    res.locals.organization = req.session.organization;
    return next();
  }
  
  // Store intended destination for redirect after login
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
};

/**
 * Require admin role
 */
export const requireAdmin = (req, res, next) => {
  if (!req.session?.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('pages/error', {
      title: req.t('team.messages.noPermission'),
      message: req.t('team.messages.adminOnly'),
      code: 403
    });
  }
  
  res.locals.user = req.session.user;
  res.locals.organization = req.session.organization;
  next();
};

// Makers who may manage platform-wide data such as the demo journeys.
// Empty means nobody: the check fails closed.
const PLATFORM_ADMIN_EMAILS = new Set(
  (process.env.PLATFORM_ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * Whether an email belongs to a platform admin (PLATFORM_ADMIN_EMAILS). Such an
 * address is reserved: it cannot be added as a maker or end user of an organization.
 * @param {string} email
 * @returns {boolean}
 */
export function isPlatformAdminEmail(email) {
  return PLATFORM_ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
}

/**
 * Require a platform admin: an admin whose email is in PLATFORM_ADMIN_EMAILS.
 * The email is read from the database, not from the session.
 */
export const requirePlatformAdmin = (req, res, next) => {
  requireAdmin(req, res, async () => {
    try {
      const result = await query(
        'SELECT email FROM users WHERE id = $1 AND is_active = true',
        [req.session.user.id]
      );
      const email = result.rows[0]?.email?.toLowerCase();
      if (!email || !PLATFORM_ADMIN_EMAILS.has(email)) {
        return res.status(403).render('pages/error', {
          title: req.t('team.messages.noPermission'),
          message: req.t('team.messages.noPermission'),
          code: 403
        });
      }
      next();
    } catch (err) {
      console.error('[Auth] Platform admin check failed:', err);
      res.status(500).render('pages/error', {
        title: req.t('team.messages.noPermission'),
        message: req.t('team.messages.noPermission'),
        code: 500
      });
    }
  });
};

/**
 * Add organization filter to database queries
 * Ensures users can only access data from their organization
 */
export const tenantFilter = (req, res, next) => {
  if (req.session?.organization) {
    req.organizationId = req.session.organization.id;
  }
  next();
};

/**
 * Guest only - redirect to dashboard if already authenticated
 */
export const guestOnly = (req, res, next) => {
  if (req.session?.user) {
    return res.redirect('/dashboard');
  }
  next();
};

/**
 * API authentication - returns JSON errors instead of redirects
 */
export const requireApiAuth = (req, res, next) => {
  if (req.session?.user) {
    req.user = req.session.user;
    req.organizationId = req.session.organization?.id;
    return next();
  }
  
  res.status(401).json({
    success: false,
    error: 'Authentication required'
  });
};

