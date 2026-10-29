/**
 * Setup wizard routes (Community Edition)
 *
 *   GET  /setup                   code entry, or the wizard once the code is accepted
 *   POST /setup/code              check the one-time setup code
 *   GET  /setup/api/checks        server checks
 *   POST /setup/api/test/:part    test one part (ai, embeddings, vision, speech, email, parser, nsfw)
 *   POST /setup/api/install       run the installation, streaming progress as NDJSON
 *
 * The test handlers are shared with the installation settings page, which
 * mounts them with an admin check instead of the setup session.
 */
import { Router } from 'express';
import { authLimiter } from '../middleware/rateLimit.js';
import { getSettings } from '../services/settings.js';
import { AI_SETTING_KEYS, resolveAiConfig, sameAddress } from '../services/aiProvider.js';
import { getDefaultFromAddress } from '../services/email.js';
import {
  checkServer, checkAiProvider, checkEmbeddings, checkVision, checkSpeech, checkSmtp, checkParser, checkNsfw
} from './checks.js';
import { isSetupCompleted, verifySetupCode, runInstallation, SetupInputError } from './setup.js';

// Paths that work before setup: the wizard itself, static files and the health check
const OPEN_BEFORE_SETUP = /^\/(setup(\/|$)|css\/|js\/|images\/|fonts\/|favicon|health$)/;

/**
 * Redirect every request to /setup until the installation is set up.
 */
export async function setupGate(req, res, next) {
  try {
    if (OPEN_BEFORE_SETUP.test(req.path) || await isSetupCompleted()) return next();
    if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
      return res.status(503).json({ success: false, code: 'SETUP_REQUIRED' });
    }
    return res.redirect('/setup');
  } catch (err) {
    next(err);
  }
}

/**
 * Only JSON bodies: a cross-site form cannot send them.
 */
function requireJson(req, res, next) {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ success: false, code: 'JSON_REQUIRED' });
  }
  return next();
}

const given = (value) => value !== undefined && value !== null && value !== '';

/**
 * Each stored secret belongs to one address. It is only sent there: a test or
 * a save with another address needs the secret again.
 */
export const SECRET_ADDRESSES = Object.freeze([
  [['ai.baseUrl'], 'ai.apiKey'],
  [['ai.embeddingBaseUrl'], 'ai.embeddingApiKey'],
  [['email.smtpHost', 'email.smtpPort'], 'email.smtpPassword']
]);

/**
 * Whether an address (one or more settings, such as host and port) in
 * `values` is the same as in `stored`.
 */
export function sameStoredAddress(keys, values, stored) {
  return keys.every((key) => sameAddress(values[key], stored[key]));
}

/**
 * The settings as they would be with the values from a test request. A blank
 * field keeps what is stored, for example a masked API key on the settings
 * page; a stored secret is dropped when its address changes.
 * @param {Object<string, *>} values - setting key to the value from the request
 */
async function withRequestValues(values) {
  const stored = await getSettings([...AI_SETTING_KEYS, 'email.smtpHost', 'email.smtpPort', 'email.smtpPassword']);
  const merged = { ...stored };
  for (const [key, value] of Object.entries(values)) {
    if (given(value)) merged[key] = value;
  }
  for (const [address, secret] of SECRET_ADDRESSES) {
    if (!given(values[secret]) && !sameStoredAddress(address, merged, stored)) merged[secret] = null;
  }
  return merged;
}

/**
 * Register the test endpoints on a router.
 * @param {import('express').Router} router
 * @param {string} prefix - e.g. '/api/test'
 * @param {import('express').RequestHandler} authorize - who may call them
 */
export function registerTestRoutes(router, prefix, authorize) {
  const run = (check) => async (req, res) => {
    try {
      res.json(await check(req.body || {}, req));
    } catch (err) {
      console.error('[Setup] Check failed unexpectedly:', err);
      res.status(500).json({ ok: false, code: 'CHECK_CRASHED', details: {} });
    }
  };

  const aiInput = async (body) => {
    const s = await withRequestValues({ 'ai.baseUrl': body.baseUrl, 'ai.apiKey': body.apiKey });
    return { baseUrl: s['ai.baseUrl'], apiKey: s['ai.apiKey'] };
  };

  router.post(`${prefix}/ai`, authorize, requireJson, run(async (body) => checkAiProvider({
    ...(await aiInput(body)),
    chatModel: body.chatModel
  })));

  // The same rules as the app itself (resolveAiConfig): default model, the
  // OpenAI key rule and which key goes to which address
  router.post(`${prefix}/embeddings`, authorize, requireJson, run(async (body) => {
    const s = await withRequestValues({
      'ai.baseUrl': body.baseUrl,
      'ai.apiKey': body.apiKey,
      'ai.embeddingBaseUrl': body.embeddingBaseUrl,
      'ai.embeddingApiKey': body.embeddingApiKey,
      'ai.embeddingModel': body.model
    });
    return checkEmbeddings(resolveAiConfig(s).embedding);
  }));

  router.post(`${prefix}/vision`, authorize, requireJson, run(async (body) => checkVision({ ...(await aiInput(body)), model: body.model })));

  router.post(`${prefix}/speech`, authorize, requireJson, run(async (body) => checkSpeech({
    ...(await aiInput(body)),
    model: body.model,
    voice: body.voice
  })));

  router.post(`${prefix}/email`, authorize, requireJson, run(async (body) => {
    const s = await withRequestValues({ 'email.smtpHost': body.host, 'email.smtpPort': body.port, 'email.smtpPassword': body.password });
    return checkSmtp({
      host: s['email.smtpHost'],
      port: Number(s['email.smtpPort']) || 587,
      security: body.security || 'starttls',
      user: body.user,
      password: s['email.smtpPassword'],
      from: body.from || await getDefaultFromAddress(),
      to: body.to
    });
  }));

  router.post(`${prefix}/parser`, authorize, requireJson, run(() => checkParser()));
  router.post(`${prefix}/nsfw`, authorize, requireJson, run(() => checkNsfw()));
}

/**
 * The /setup router. Mounted only in the Community Edition.
 */
export function createSetupRouter() {
  const router = Router();

  // Once set up, the wizard is gone
  router.use(async (req, res, next) => {
    try {
      if (await isSetupCompleted()) return next('router');
      return next();
    } catch (err) {
      return next(err);
    }
  });

  const authorized = (req, res, next) => {
    if (req.session?.setupAuthorized === true) return next();
    return res.status(401).json({ ok: false, code: 'SETUP_CODE_REQUIRED' });
  };

  router.get('/', authLimiter, async (req, res, next) => {
    try {
      if (req.query.code && await verifySetupCode(req.query.code)) {
        req.session.setupAuthorized = true;
        return req.session.save(() => res.redirect('/setup'));
      }
      if (req.session?.setupAuthorized === true) {
        return res.render('setup/wizard', { appUrl: process.env.APP_URL || '' });
      }
      return res.render('setup/code', { invalid: !!req.query.code });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/code', authLimiter, requireJson, async (req, res) => {
    try {
      if (await verifySetupCode(req.body?.code)) {
        req.session.setupAuthorized = true;
        return req.session.save(() => res.json({ ok: true }));
      }
      return res.status(400).json({ ok: false, code: 'SETUP_CODE_INVALID' });
    } catch (err) {
      console.error('[Setup] Checking the setup code failed:', err);
      return res.status(500).json({ ok: false, code: 'CHECK_CRASHED' });
    }
  });

  router.get('/api/checks', authorized, async (req, res) => {
    try {
      res.json({ checks: await checkServer({ requestHost: req.get('host') || '', requestSecure: req.secure }) });
    } catch (err) {
      console.error('[Setup] Server checks failed:', err);
      res.status(500).json({ ok: false, code: 'CHECK_CRASHED' });
    }
  });

  registerTestRoutes(router, '/api/test', authorized);

  router.post('/api/install', authorized, requireJson, async (req, res) => {
    res.status(200).set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const send = (message) => res.write(`${JSON.stringify(message)}\n`);
    try {
      const { account = {}, settings = {} } = req.body || {};
      await runInstallation({ account, settings }, (step) => send({ step }));
      req.session.setupAuthorized = false;
      send({ done: true, redirect: `/login?email=${encodeURIComponent(String(account.email || '').trim().toLowerCase())}` });
    } catch (err) {
      if (err instanceof SetupInputError || err.name === 'SettingValidationError') {
        send({ error: err.code || 'SETTING_INVALID', field: err.field || err.key || null, message: err.message });
      } else {
        console.error('[Setup] Installation failed:', err);
        send({ error: 'INSTALL_FAILED' });
      }
    }
    res.end();
  });

  return router;
}
