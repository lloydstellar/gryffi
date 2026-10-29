/**
 * Public email preference routes (no login required).
 *
 * GET  /email/unsubscribe/:token  confirmation page with a button
 * POST /email/unsubscribe/:token  one-click unsubscribe (RFC 8058); also used
 *                                 by the button on the confirmation page
 *
 * The token is a per-user random string stored in users.email_unsubscribe_token.
 * Unsubscribing turns off both the lifecycle emails and the marketing consent,
 * so the person receives no more optional mail from Gryffi at all.
 * Transactional emails (password reset, invitations) are not affected.
 */

import { Router } from 'express';
import { query } from '../db/index.js';

const router = Router();

const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/i;

async function findUserByToken(token) {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const result = await query(
    `SELECT id, email, first_name, lifecycle_emails_enabled, marketing_consent_at
     FROM users
     WHERE email_unsubscribe_token = $1`,
    [token]
  );
  return result.rows[0] || null;
}

async function unsubscribeUser(userId) {
  await query(
    `UPDATE users
     SET lifecycle_emails_enabled = false,
         marketing_consent_at = NULL,
         marketing_consent_source = 'unsubscribe_link',
         updated_at = NOW()
     WHERE id = $1`,
    [userId]
  );
}

function renderPage(res, state, extra = {}) {
  return res.render('pages/email-unsubscribe', { state, ...extra });
}

router.get('/email/unsubscribe/:token', async (req, res) => {
  try {
    const user = await findUserByToken(req.params.token);
    if (!user) return renderPage(res.status(404), 'invalid');
    if (!user.lifecycle_emails_enabled && !user.marketing_consent_at) {
      return renderPage(res, 'done', { email: user.email });
    }
    return renderPage(res, 'confirm', { email: user.email, token: req.params.token });
  } catch (err) {
    console.error('[EmailPreferences] Unsubscribe page error:', err);
    return renderPage(res.status(500), 'invalid');
  }
});

router.post('/email/unsubscribe/:token', async (req, res) => {
  try {
    const user = await findUserByToken(req.params.token);
    if (!user) return renderPage(res.status(404), 'invalid');

    await unsubscribeUser(user.id);
    console.log(`[EmailPreferences] Unsubscribed ${user.email} via link`);

    // Mail clients doing RFC 8058 one-click POST only need a 2xx; a browser
    // gets the confirmation page.
    const isOneClick = typeof req.body?.['List-Unsubscribe'] === 'string';
    if (isOneClick) return res.status(200).send('OK');
    return renderPage(res, 'done', { email: user.email });
  } catch (err) {
    console.error('[EmailPreferences] Unsubscribe error:', err);
    return renderPage(res.status(500), 'invalid');
  }
});

export default router;
