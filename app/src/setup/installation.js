/**
 * Installation settings page (Community Edition)
 *
 * After the setup wizard, admins change the installation here: AI provider,
 * email, options and integrations, with the same live tests as the wizard.
 * The page also shows the version and whether a newer release exists.
 * Every change lands in the audit log. Gryffi Cloud does not load this module:
 * there the installation belongs to Gryffi, not to a customer's admin.
 *
 *   GET  /dashboard/installation           the page
 *   GET  /api/installation/settings        current values (secrets masked)
 *   PUT  /api/installation/settings        save changed values
 *   GET  /api/installation/audit           last 100 changes
 *   GET  /api/installation/reembed         progress of re-embedding the knowledge base
 *   POST /api/installation/reembed         start re-embedding
 *   POST /api/installation/test/:part      live tests, shared with the wizard
 */
import { query } from '../db/index.js';
import { describeSettings, getSettings, normalizeSetting, setSettings, SettingValidationError } from '../services/settings.js';
import { getAiConfig, sameAddress } from '../services/aiProvider.js';
import { getReembedStatus, reembedAllChunks } from '../services/knowledge.js';
import { getAppBaseUrl } from '../utils/appUrl.js';
import { registerTestRoutes, SECRET_ADDRESSES, sameStoredAddress } from './routes.js';
import { SETTING_GROUPS } from './settingGroups.js';
import { checkForUpdate, getUpdateStatus } from './updates.js';

const EDITABLE = new Set(Object.values(SETTING_GROUPS).flat());

/**
 * API guard: admins only, answered as JSON.
 */
function adminOnly(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.status(403).json({ success: false, code: 'ADMIN_ONLY' });
}

/**
 * A stored secret belongs to the address it was saved for. Saving another
 * address without the secret would send it somewhere new, so the admin has to
 * enter it again. Returns the setting key of the secret that is missing.
 */
async function missingSecret(values) {
  const given = (value) => value !== undefined && value !== null && value !== '';
  for (const [address, secret] of SECRET_ADDRESSES) {
    if (!address.some((key) => given(values[key])) || given(values[secret])) continue;
    const stored = await getSettings([...address, secret]);
    const next = Object.fromEntries(address.map((key) => [key, given(values[key]) ? values[key] : stored[key]]));
    if (stored[secret] && !sameStoredAddress(address, next, stored)) return secret;
  }
  return null;
}

/**
 * Register the installation API on the API router.
 * @param {import('express').Router} router
 */
export function registerInstallationApi(router) {
  router.get('/installation/settings', adminOnly, async (req, res) => {
    try {
      const settings = (await describeSettings()).filter((s) => EDITABLE.has(s.key));
      res.json({
        success: true,
        settings,
        groups: SETTING_GROUPS,
        redirectUris: {
          google: `${getAppBaseUrl()}/api/auth/callback/google`,
          microsoft: `${getAppBaseUrl()}/api/auth/callback/microsoft`
        },
        reembed: getReembedStatus(),
        version: await getUpdateStatus()
      });
    } catch (err) {
      console.error('[Installation] Loading settings failed:', err);
      res.status(500).json({ success: false, code: 'LOAD_FAILED' });
    }
  });

  router.put('/installation/settings', adminOnly, async (req, res) => {
    const values = req.body?.values;
    if (!values || typeof values !== 'object') {
      return res.status(400).json({ success: false, code: 'SETTING_INVALID' });
    }
    const unknown = Object.keys(values).find((key) => !EDITABLE.has(key));
    if (unknown) {
      return res.status(400).json({ success: false, code: 'SETTING_INVALID', field: unknown });
    }
    try {
      // Invalid values first: their message says what is wrong
      for (const [key, value] of Object.entries(values)) normalizeSetting(key, value);
      const secret = await missingSecret(values);
      if (secret) {
        return res.status(400).json({ success: false, code: 'SECRET_REQUIRED', field: secret });
      }
      // Vectors from another embedding model or provider cannot be compared
      // with the stored ones: rebuild the index when the effective one changes
      const before = (await getAiConfig()).embedding;
      const changed = await setSettings(values, { userId: req.session.user.id });
      const after = (await getAiConfig()).embedding;
      const embeddingChanged = !sameAddress(before.baseUrl, after.baseUrl) || before.model !== after.model;
      const reembed = embeddingChanged ? await reembedAllChunks() : null;
      if (changed.includes('updates.check')) await checkForUpdate();
      res.json({ success: true, changed, reembed });
    } catch (err) {
      if (err instanceof SettingValidationError) {
        return res.status(400).json({ success: false, code: 'SETTING_INVALID', field: err.key, message: err.message });
      }
      console.error('[Installation] Saving settings failed:', err);
      res.status(500).json({ success: false, code: 'SAVE_FAILED' });
    }
  });

  router.get('/installation/audit', adminOnly, async (req, res) => {
    try {
      const result = await query(`
        SELECT a.key, a.old_value, a.new_value, a.changed_at, u.email AS changed_by
        FROM instance_settings_audit a
        LEFT JOIN users u ON u.id = a.changed_by
        WHERE a.key NOT LIKE 'setup.%'
        ORDER BY a.id DESC
        LIMIT 100
      `);
      res.json({ success: true, entries: result.rows });
    } catch (err) {
      console.error('[Installation] Loading the audit log failed:', err);
      res.status(500).json({ success: false, code: 'LOAD_FAILED' });
    }
  });

  router.get('/installation/reembed', adminOnly, (req, res) => {
    res.json({ success: true, reembed: getReembedStatus() });
  });

  router.post('/installation/reembed', adminOnly, async (req, res) => {
    try {
      res.json({ success: true, reembed: await reembedAllChunks() });
    } catch (err) {
      console.error('[Installation] Starting re-embedding failed:', err);
      res.status(500).json({ success: false, code: 'REEMBED_FAILED' });
    }
  });

  registerTestRoutes(router, '/installation/test', adminOnly);
}

/**
 * Register the installation page on the dashboard router.
 * @param {import('express').Router} router
 */
export function registerInstallationPage(router) {
  router.get('/installation', (req, res) => {
    if (req.session.user.role !== 'admin') {
      return res.status(403).render('pages/error', {
        title: req.t('team.messages.noPermission'),
        message: req.t('team.messages.adminOnly'),
        code: 403
      });
    }
    return res.render('pages/installation', { settingGroups: SETTING_GROUPS });
  });
}
