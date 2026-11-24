/**
 * Maker sessions
 *
 * Starting a logged-in maker session after a password login, a login code,
 * or a confirmed signup. The session always gets a new ID first, so whoever
 * planted the old ID (session fixation) does not get the access.
 */

const SUPPORTED_LANGUAGES = ['en', 'nl', 'de', 'fr', 'es'];

/**
 * Regenerate the session and put dataToSet in the new one.
 * @param {import('express').Request} req
 * @param {Object} dataToSet
 * @returns {Promise<void>}
 */
export function regenerateSession(req, dataToSet) {
  return new Promise((resolve, reject) => {
    const oldSession = req.session;
    oldSession.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, dataToSet);
      req.session.save((saveErr) => {
        if (saveErr) return reject(saveErr);
        resolve();
      });
    });
  });
}

/**
 * Log a maker in: new session with user and organization, the organization's
 * fixed interface language (unless the browser already chose one), and a
 * one-time justLoggedIn flag for the dashboard.
 * @param {import('express').Request} req
 * @param {Object} user - users row with org_id, org_name, org_slug, org_logo, org_settings
 * @param {Object} options
 * @param {boolean} options.firstLogin - Never logged in before ("Welcome", not "Welcome back")
 * @param {string} options.method - Auth method for the login-complete event
 * @returns {Promise<void>}
 */
export async function startMakerSession(req, user, { firstLogin, method }) {
  const sessionData = {
    // Compared with users.password_changed_at by refreshSessionUser
    authenticatedAt: Date.now(),
    user: {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      avatarUrl: user.avatar_url,
      fullName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
      firstLogin: !!firstLogin
    },
    organization: {
      id: user.org_id,
      name: user.org_name,
      slug: user.org_slug,
      logoUrl: user.org_logo,
      settings: user.org_settings || {}
    }
  };

  const orgSettings = user.org_settings || {};
  const mode = orgSettings.default_language_mode || 'fixed';
  const lang = orgSettings.default_language;
  const hasI18nCookie = String(req.headers.cookie || '').includes('i18next=');
  if (!hasI18nCookie && mode === 'fixed' && SUPPORTED_LANGUAGES.includes(lang)) {
    sessionData.language = lang;
  }

  await regenerateSession(req, sessionData);
  // Read once by server.js for a single login-complete event (no personal data)
  req.session.justLoggedIn = { method };
  await new Promise((resolve) => req.session.save(() => resolve()));
}
