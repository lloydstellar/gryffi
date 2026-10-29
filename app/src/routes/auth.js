/**
 * Authentication Routes
 * Login, logout, password reset, and session management
 */
import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getAppBaseUrl } from '../utils/appUrl.js';
import { isCloud } from '../edition.js';
import { encryptToken } from '../services/oauthTokens.js';
import i18next from 'i18next';
import { query, getClient } from '../db/index.js';
import { guestOnly } from '../middleware/auth.js';
import { sendEmail, sendVerificationCodeEmail, sendAutomationEmail, sendJourneyEmail } from '../services/email.js';
import { chatWithGuide } from '../services/mistral.js';
import { parseCitations, getCitationSources } from '../services/knowledge.js';
import { getAnalysisDescription } from '../services/imageAnalysis.js';
import { getOrganizationTier, trackAiCredits, hasAiCreditsLeft } from '../services/subscription.js';
import { magicLinkLimiter, playerAiLimiter, playerTtsLimiter, trackInvalidToken, isInvalidTokenBlocked, getClientIp } from '../middleware/rateLimit.js';
import { getPlayerLocale } from '../services/playerLocales.js';
import { verifyOAuthState } from '../lib/oauthState.js';
import { handleTtsRequest, getTtsCacheDir } from '../services/tts.js';
import {
  processAttachments, checkAttachmentImages, storeSubmissionFiles, resolveStoragePath,
  buildFormSubmissionEmailBody, buildFormSubmissionSubject
} from '../services/formSubmissions.js';
import path from 'path';
import fs from 'fs';

const router = Router();

/**
 * Regenerate session after privilege change to prevent session fixation.
 * Copies specified keys from the old session to the new one.
 */
function regenerateSession(req, dataToSet) {
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
 * Give the session a new ID and keep what is in it. For a session that gains
 * access without a password (a magic link, a remembered public participant):
 * whoever planted the old ID (session fixation) does not get that access. A
 * maker who is logged in in the same browser stays logged in.
 */
function rotateSessionId(req) {
  const { cookie: _cookie, ...data } = req.session;
  return regenerateSession(req, data);
}

const SUPPORTED_LANGUAGES = ['en', 'nl', 'de', 'fr', 'es'];

/**
 * Extract media URLs from step context and add AI-generated descriptions
 * This helps Step Assistants understand visual content the user is seeing
 */
async function enrichContextWithMediaDescriptions(stepContext) {
  if (!stepContext) return '';
  
  // Extract URLs that might have AI descriptions
  const urlPatterns = [
    /image_url['":\s]+['"]?([^'"\s,}]+)/gi,
    /video_url['":\s]+['"]?([^'"\s,}]+)/gi,
    /panorama_url['":\s]+['"]?([^'"\s,}]+)/gi,
    /\/media\/[^\s'"]+/gi,
    /https?:\/\/[^\s'"]*(?:youtube\.com|youtu\.be)[^\s'"]*/gi,
    /https?:\/\/images\.pexels\.com[^\s'"]*/gi
  ];
  
  const foundUrls = new Set();
  for (const pattern of urlPatterns) {
    const matches = stepContext.matchAll(pattern);
    for (const match of matches) {
      const url = match[1] || match[0];
      if (url && url.length > 5) {
        foundUrls.add(url);
      }
    }
  }
  
  if (foundUrls.size === 0) return '';
  
  // Fetch descriptions for found URLs
  const descriptions = [];
  for (const url of foundUrls) {
    try {
      const description = await getAnalysisDescription(url);
      if (description) {
        descriptions.push(description);
      }
    } catch {
      console.debug('[MediaContext] Failed to get description for:', url.substring(0, 50));
    }
  }
  
  if (descriptions.length === 0) return '';
  
  return `\n\n=== VISUAL CONTENT DESCRIPTION ===
The user is viewing the following visual content:
${descriptions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

Use this information to help the user understand what they're seeing if relevant to their question.`;
}

// ============================================
// LOGIN SECURITY HELPERS
// ============================================

// Brute force protection thresholds
const LOGIN_SECURITY = {
  TIMEOUT_AFTER_3_FAILS: 30 * 1000,    // 30 seconds
  TIMEOUT_AFTER_5_FAILS: 5 * 60 * 1000, // 5 minutes
  LOCKOUT_AFTER_10_FAILS: 30 * 60 * 1000, // 30 minutes
  ATTEMPT_WINDOW: 15 * 60 * 1000,       // 15 minute window for counting attempts
  CODE_EXPIRY: 10 * 60 * 1000,          // 10 minutes for verification code
  MAX_CODE_ATTEMPTS: 5,                 // wrong codes per pending login (across resends)
  MAX_CODE_RESENDS: 3,                  // new codes per pending login
  PENDING_LOGIN_MAX_AGE: 30 * 60 * 1000 // a pending login never lives longer than this
};

/**
 * Log a login attempt
 */
async function logLoginAttempt(email, req, success, failureReason = null) {
  try {
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    
    await query(`
      INSERT INTO login_attempts (email, ip_address, user_agent, success, failure_reason)
      VALUES ($1, $2::inet, $3, $4, $5)
    `, [email.toLowerCase(), ip, userAgent, success, failureReason]);
  } catch (err) {
    console.error('[Auth] Failed to log login attempt:', err);
  }
}

/**
 * Count recent failed login attempts for an email
 */
async function getRecentFailedAttempts(email) {
  try {
    // Only count actual password failures, not timeout blocks
    const result = await query(`
      SELECT COUNT(*) as count
      FROM login_attempts
      WHERE email = $1
        AND success = false
        AND failure_reason = 'wrong_password'
        AND created_at > NOW() - INTERVAL '15 minutes'
    `, [email.toLowerCase()]);
    return parseInt(result.rows[0]?.count || 0);
  } catch (err) {
    console.error('[Auth] Failed to get failed attempts:', err);
    return 0;
  }
}

/**
 * Check if user is locked out due to too many failed attempts
 */
async function checkLockout(user) {
  if (!user.lockout_until) return { locked: false };
  
  const lockoutTime = new Date(user.lockout_until);
  if (lockoutTime > new Date()) {
    const remainingMs = lockoutTime - new Date();
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return { locked: true, remainingMinutes };
  }
  
  // Lockout expired, reset
  await query('UPDATE users SET lockout_until = NULL, failed_login_attempts = 0 WHERE id = $1', [user.id]);
  return { locked: false };
}

/**
 * Handle failed login - update attempts and potentially lock account
 */
async function handleFailedLogin(user) {
  const newAttempts = (user.failed_login_attempts || 0) + 1;
  
  let lockoutUntil = null;
  if (newAttempts >= 10) {
    lockoutUntil = new Date(Date.now() + LOGIN_SECURITY.LOCKOUT_AFTER_10_FAILS);
  }
  
  await query(`
    UPDATE users 
    SET failed_login_attempts = $1, lockout_until = $2 
    WHERE id = $3
  `, [newAttempts, lockoutUntil, user.id]);
  
  return { attempts: newAttempts, lockoutUntil };
}

/**
 * Reset failed login attempts after successful login
 */
async function resetFailedAttempts(userId) {
  await query(`
    UPDATE users 
    SET failed_login_attempts = 0, lockout_until = NULL 
    WHERE id = $1
  `, [userId]);
}

/**
 * Generate a 4-digit verification code
 */
/**
 * Whether a guide is used in a journey: as guide step, as step assistant or as
 * journey guide, nested journeys included. End users may only chat with these
 * guides, not with every guide (and knowledge base) of the organization.
 * @param {string} guideId
 * @param {string} journeyId
 * @returns {Promise<boolean>}
 */
async function isGuideUsedInJourney(guideId, journeyId) {
  if (!guideId || !journeyId) return false;
  const result = await query(`
    WITH RECURSIVE tree(id) AS (
      SELECT $2::uuid
      UNION
      SELECT (s.basic_props->>'nested_journey_id')::uuid
      FROM steps s JOIN tree t ON s.journey_id = t.id
      WHERE s.type = 'nested_journey'
        AND s.basic_props->>'nested_journey_id' ~ '^[0-9a-fA-F-]{36}$'
    )
    SELECT 1 FROM steps s JOIN tree t ON s.journey_id = t.id
    WHERE s.basic_props->>'guide_id' = $1 OR s.advanced_props->>'assistant_guide_id' = $1
    UNION ALL
    SELECT 1 FROM journeys j JOIN tree t ON j.id = t.id
    WHERE j.guide_id::text = $1
    LIMIT 1
  `, [String(guideId), journeyId]);
  return result.rows.length > 0;
}

// Guide fields the player needs. Never ai_instructions: those are the maker's
// system prompt and stay on the server.
const PLAYER_GUIDE_COLUMNS = 'id, name, role, avatar_url, personality, greeting, language, is_active';

// ============================================
// QUIZ (challenge steps) - answers stay on the server
// ============================================
// The player never receives which option is correct. It asks quiz/check per
// answer; the first answer per question in an attempt is locked in the
// session and the score is computed from those locked answers.
const MAX_QUIZ_ATTEMPTS_IN_SESSION = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function quizQuestionId(question, index) {
  return question?.id ? String(question.id) : `idx-${index}`;
}

/**
 * Remove the `correct` flags from challenge steps before they go to a player.
 * Questions without an id get a stable stand-in id (idx-N) for quiz/check.
 */
function stripQuizAnswers(steps) {
  return steps.map(step => {
    if (step.type !== 'challenge') return step;
    const props = typeof step.basic_props === 'string' ? JSON.parse(step.basic_props) : (step.basic_props || {});
    if (!Array.isArray(props.questions)) return step;
    return {
      ...step,
      basic_props: {
        ...props,
        questions: props.questions.map((question, index) => ({
          ...question,
          id: quizQuestionId(question, index),
          options: (question.options || []).map(({ correct: _correct, ...option }) => option)
        }))
      }
    };
  });
}

/**
 * Load a challenge step that belongs to a journey or one of its nested journeys.
 */
async function getChallengeStep(stepId, journeyId) {
  if (!UUID_PATTERN.test(String(stepId)) || !journeyId) return null;
  const result = await query(`
    WITH RECURSIVE tree(id) AS (
      SELECT $1::uuid
      UNION
      SELECT (s.basic_props->>'nested_journey_id')::uuid
      FROM steps s JOIN tree t ON s.journey_id = t.id
      WHERE s.type = 'nested_journey'
        AND s.basic_props->>'nested_journey_id' ~ '^[0-9a-fA-F-]{36}$'
    )
    SELECT s.id, s.basic_props, s.advanced_props
    FROM steps s JOIN tree t ON s.journey_id = t.id
    WHERE s.id = $2 AND s.type = 'challenge'
  `, [journeyId, stepId]);
  return result.rows[0] || null;
}

function quizAttemptStore(req, stepId, attemptKey) {
  const store = req.session.quizAnswers || {};
  const key = `${stepId}:${attemptKey}`;
  if (!store[key]) {
    store[key] = {};
    // Keep the session small: drop the oldest attempts
    const keys = Object.keys(store);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_QUIZ_ATTEMPTS_IN_SESSION))) {
      delete store[old];
    }
  }
  req.session.quizAnswers = store;
  return store[key];
}

/**
 * POST .../quiz/check handler: is this answer correct? Only the first answer
 * per question and attempt counts, so asking again cannot try every option.
 */
async function handleQuizCheck(req, res, journeyId) {
  const { step_id, question_id, option_index, attempt_key } = req.body || {};
  if (!UUID_PATTERN.test(String(attempt_key)) || question_id == null || !Number.isInteger(option_index) || option_index < 0) {
    return res.status(400).json({ success: false, error: 'Invalid quiz answer' });
  }
  const step = await getChallengeStep(step_id, journeyId);
  if (!step) {
    return res.status(404).json({ success: false, error: 'Quiz not found' });
  }
  const questions = Array.isArray(step.basic_props?.questions) ? step.basic_props.questions : [];
  const index = questions.findIndex((q, i) => quizQuestionId(q, i) === String(question_id));
  if (index === -1) {
    return res.status(404).json({ success: false, error: 'Question not found' });
  }
  const locked = quizAttemptStore(req, step.id, attempt_key);
  const questionId = quizQuestionId(questions[index], index);
  if (locked[questionId] === undefined) {
    locked[questionId] = option_index;
  }
  const chosen = locked[questionId];
  return res.json({
    success: true,
    correct: !!questions[index].options?.[chosen]?.correct,
    option_index: chosen
  });
}

/**
 * Score an attempt from the answers locked by quiz/check (never from the client).
 */
function scoreQuizAttempt(req, step, attemptKey) {
  const questions = Array.isArray(step.basic_props?.questions) ? step.basic_props.questions : [];
  const locked = (req.session.quizAnswers || {})[`${step.id}:${attemptKey}`] || {};
  let correctCount = 0;
  const questionResults = questions.map((question, index) => {
    const questionId = quizQuestionId(question, index);
    const selected = locked[questionId];
    const correct = selected !== undefined && !!question.options?.[selected]?.correct;
    if (correct) correctCount++;
    return { question_id: questionId, selected_answer: selected ?? null, correct };
  });
  const passingScore = parseInt(step.advanced_props?.passing_score, 10) || 0;
  return {
    totalQuestions: questions.length,
    correctCount,
    passed: passingScore === 0 || correctCount >= passingScore,
    questionResults
  };
}

// Public journeys: wrong email codes per session before the code is destroyed
const PUBLIC_VERIFY_MAX_ATTEMPTS = 5;

function hashRememberToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Magic-link tokens this browser session opened (and verified on a third or
// later device). A list, so journeys in different tabs keep working.
const MAX_REMEMBERED_EXPEDITIONS = 20;

function rememberExpeditionToken(req, token) {
  const tokens = (req.session.verifiedExpeditionTokens || []).filter(t => t !== token);
  tokens.push(token);
  req.session.verifiedExpeditionTokens = tokens.slice(-MAX_REMEMBERED_EXPEDITIONS);
}

function hasExpeditionSession(req, token) {
  return (req.session?.verifiedExpeditionTokens || []).includes(token)
    || req.session?.expedition?.token === token;
}

// Device verification for magic links (third and later devices)
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_CODE_MAX_ATTEMPTS = 5;

/**
 * Get the device verification code for a magic-link session.
 * A code is valid for 10 minutes and allows 5 guesses in total. While it is
 * valid, reloading the page or asking for a resend returns the same code, so
 * the guess counter cannot be reset by requesting new codes.
 * @param {string} sessionId - invitation_sessions.id
 * @returns {Promise<{code: string|null, isNew: boolean}>} code is null while
 *   the session is locked after too many wrong guesses
 */
async function issueDeviceVerificationCode(sessionId) {
  const current = await query(
    'SELECT verification_code, verification_expires_at, verification_attempts FROM invitation_sessions WHERE id = $1',
    [sessionId]
  );
  const row = current.rows[0];
  if (row?.verification_code && row.verification_expires_at && new Date(row.verification_expires_at) > new Date()) {
    const locked = (row.verification_attempts || 0) >= DEVICE_CODE_MAX_ATTEMPTS;
    return { code: locked ? null : row.verification_code, isNew: false };
  }
  const code = crypto.randomInt(1000, 10000).toString();
  await query(
    `UPDATE invitation_sessions
     SET verification_code = $1, verification_expires_at = $2, verification_attempts = 0
     WHERE id = $3`,
    [code, new Date(Date.now() + DEVICE_CODE_TTL_MS), sessionId]
  );
  return { code, isNew: true };
}

function generateVerificationCode() {
  return crypto.randomInt(1000, 10000).toString();
}

/**
 * Store verification code for user
 */
async function storeVerificationCode(userId, code) {
  const expires = new Date(Date.now() + LOGIN_SECURITY.CODE_EXPIRY);
  await query(`
    UPDATE users 
    SET login_verification_code = $1, login_verification_expires = $2 
    WHERE id = $3
  `, [code, expires, userId]);
}

/**
 * Check if organization is on Pro+ tier (professional, enterprise, custom)
 */
async function isProTier(orgId) {
  try {
    const tierData = await getOrganizationTier(orgId);
    // tierData has structure { tier: { name: 'professional', ... }, ... }
    const tierName = tierData?.tier?.name;
    return tierName && ['professional', 'enterprise', 'custom'].includes(tierName);
  } catch (err) {
    console.error('[Auth] Failed to check tier:', err);
    return false;
  }
}

/**
 * Check if login requires verification code (for Pro+ tiers)
 */
async function requiresVerification(user, req, failedAttempts) {
  // Check if user has 2FA enabled
  if (user.two_factor_enabled) {
    return { required: true, reason: '2fa' };
  }
  
  // For Pro+ tiers: ask for a code after 3+ failed attempts
  const isPro = await isProTier(user.org_id);
  if (isPro && failedAttempts >= 3) {
    return { required: true, reason: 'brute_force' };
  }
  
  return { required: false };
}

/**
 * Calculate timeout based on failed attempts (all tiers)
 */
function calculateTimeout(failedAttempts) {
  if (failedAttempts >= 5) {
    return LOGIN_SECURITY.TIMEOUT_AFTER_5_FAILS;
  } else if (failedAttempts >= 3) {
    return LOGIN_SECURITY.TIMEOUT_AFTER_3_FAILS;
  }
  return 0;
}

/**
 * Send login verification code email
 */
async function sendLoginVerificationEmail(user, code, reason, req) {
  // Determine language for email
  let emailLng = 'en';
  try {
    const orgRes = await query('SELECT settings FROM organizations WHERE id = $1', [user.org_id]);
    const settings = orgRes.rows[0]?.settings || {};
    const mode = settings.default_language_mode || 'fixed';
    const fixed = settings.default_language;
    if (mode === 'fixed' && SUPPORTED_LANGUAGES.includes(fixed)) emailLng = fixed;
    else if (SUPPORTED_LANGUAGES.includes(req.language)) emailLng = req.language;
  } catch (_e) {}
  
  const tEmail = i18next.getFixedT(emailLng);
  
  let reasonText = '';
  if (reason === '2fa') {
    reasonText = tEmail('auth.loginVerification.reason2fa');
  } else if (reason === 'brute_force') {
    reasonText = tEmail('auth.loginVerification.reasonBruteForce');
  }
  
  await sendEmail({
    to: user.email,
    subject: tEmail('auth.loginVerification.emailSubject'),
    templateType: 'journey_custom',
    variables: {
      company_name: 'Gryffi',
      user_first_name: user.first_name || '',
      custom_link: '',
      custom_link_text: ''
    },
    customBody: tEmail('auth.loginVerification.emailBody', {
      userName: user.first_name || 'there',
      code: code,
      reason: reasonText
    }),
    language: emailLng
  });
  
  console.log(`[Auth] Login verification code sent to ${user.email} (reason: ${reason})`);
}

/**
 * GET /login - Show login page
 */
router.get('/login', guestOnly, (req, res) => {
  // Read and clear flash messages BEFORE rendering to avoid race conditions with session save
  const error = req.session.error;
  const success = req.session.success;
  const loginTimeout = req.session.loginTimeout || 0;
  delete req.session.error;
  delete req.session.success;
  delete req.session.loginTimeout;
  
  // The setup wizard sends the new admin here with the address filled in
  const prefillEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(req.query.email || '')) ? String(req.query.email) : '';
  
  res.render('pages/login', {
    title: 'Sign In',
    error,
    success,
    loginTimeout,
    prefillEmail
  });
});

/**
 * POST /login - Process login with security checks
 */
router.post('/login', guestOnly, async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    req.session.error = req.t('auth.errors.enterEmailPassword');
    return res.redirect('/login');
  }
  
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    // Check recent failed attempts for timeout (all tiers)
    const recentFailedAttempts = await getRecentFailedAttempts(normalizedEmail);
    const timeout = calculateTimeout(recentFailedAttempts);
    
    if (timeout > 0) {
      // Check last failed attempt time (only actual password failures)
      const lastAttempt = await query(`
        SELECT created_at FROM login_attempts 
        WHERE email = $1 AND success = false AND failure_reason = 'wrong_password'
        ORDER BY created_at DESC LIMIT 1
      `, [normalizedEmail]);
      
      if (lastAttempt.rows.length > 0) {
        const timeSinceLastAttempt = Date.now() - new Date(lastAttempt.rows[0].created_at).getTime();
        if (timeSinceLastAttempt < timeout) {
          const remainingSecs = Math.ceil((timeout - timeSinceLastAttempt) / 1000);
          req.session.loginTimeout = remainingSecs; // For countdown timer
          req.session.error = req.t('auth.errors.tooManyAttempts', { seconds: remainingSecs });
          // Don't log timeout blocks - they would make the timeout progressively longer
          return res.redirect('/login');
        }
      }
    }
    
    // Find user with organization info and security fields
    const result = await query(`
      SELECT 
        u.id, u.email, u.password_hash, u.first_name, u.last_name, u.role, u.avatar_url, u.is_active,
        u.two_factor_enabled, u.failed_login_attempts, u.lockout_until,
        o.id as org_id, o.name as org_name, o.slug as org_slug, o.logo_url as org_logo, o.settings as org_settings
      FROM users u
      JOIN organizations o ON u.organization_id = o.id
      WHERE u.email = $1
      ORDER BY u.last_login_at DESC NULLS LAST, u.created_at DESC
    `, [normalizedEmail]);
    
    if (result.rows.length === 0) {
      await logLoginAttempt(normalizedEmail, req, false, 'user_not_found');
      req.session.error = req.t('auth.errors.invalidCredentials');
      return res.redirect('/login');
    }
    
    // An address belongs to one organization. Older data can have it in
    // several: use the account whose password matches (the most recently
    // used one when several match), otherwise the most recently used one.
    let user = result.rows[0];
    if (result.rows.length > 1) {
      for (const candidate of result.rows) {
        if (candidate.password_hash && await bcrypt.compare(password, candidate.password_hash)) {
          user = candidate;
          break;
        }
      }
    }
    
    // Check if account is locked
    const lockoutStatus = await checkLockout(user);
    if (lockoutStatus.locked) {
      await logLoginAttempt(normalizedEmail, req, false, 'account_locked');
      req.session.error = req.t('auth.errors.accountLocked', { minutes: lockoutStatus.remainingMinutes });
      return res.redirect('/login');
    }
    
    if (!user.is_active) {
      await logLoginAttempt(normalizedEmail, req, false, 'account_inactive');
      req.session.error = req.t('auth.errors.accountDeactivated');
      return res.redirect('/login');
    }
    
    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      await logLoginAttempt(normalizedEmail, req, false, 'wrong_password');
      await handleFailedLogin(user);
      req.session.error = req.t('auth.errors.invalidCredentials');
      return res.redirect('/login');
    }
    
    // Password is correct - check if verification code is required
    const verification = await requiresVerification(user, req, recentFailedAttempts);
    
    if (verification.required) {
      // Generate and send verification code
      const code = generateVerificationCode();
      await storeVerificationCode(user.id, code);
      await sendLoginVerificationEmail(user, code, verification.reason, req);
      
      // Store pending login in session
      req.session.pendingLogin = {
        userId: user.id,
        email: user.email,
        reason: verification.reason,
        createdAt: Date.now()
      };
      
      // Redirect to verification page
      return res.redirect('/login/verify');
    }
    
    // No verification needed - complete login
    await logLoginAttempt(normalizedEmail, req, true);
    await resetFailedAttempts(user.id);
    
    // Update last login info
    const currentIP = getClientIp(req);
    await query(`
      UPDATE users 
      SET last_login_at = NOW(), last_login_ip = $1::inet
      WHERE id = $2
    `, [currentIP, user.id]);
    
    // For admin users: if organization has 'fixed' mode but no default_language yet,
    // automatically set it to the admin's browser language (first admin sets the org language)
    if (user.role === 'admin') {
      try {
        const orgSettings = user.org_settings || {};
        const mode = orgSettings.default_language_mode || 'auto';
        const hasDefaultLang = !!orgSettings.default_language;
        
        if (mode === 'fixed' && !hasDefaultLang) {
          // Get browser language from Accept-Language header
          const supportedLanguages = ['en', 'nl', 'de', 'fr', 'es'];
          let browserLang = 'en'; // fallback
          
          const acceptLang = req.headers['accept-language'] || '';
          // Parse Accept-Language header (e.g., "nl-NL,nl;q=0.9,en;q=0.8")
          const langParts = acceptLang.split(',').map(part => {
            const [lang] = part.trim().split(';');
            return lang.split('-')[0].toLowerCase();
          });
          
          // Find first supported language
          for (const lang of langParts) {
            if (supportedLanguages.includes(lang)) {
              browserLang = lang;
              break;
            }
          }
          
          // Update organization with the admin's browser language
          const newSettings = { ...orgSettings, default_language: browserLang };
          await query(
            'UPDATE organizations SET settings = $1::jsonb, updated_at = NOW() WHERE id = $2',
            [JSON.stringify(newSettings), user.org_id]
          );
          
          // Update user object for session
          user.org_settings = newSettings;
          
          console.log(`[Auth] Set organization default language to '${browserLang}' based on first admin's browser`);
        }
      } catch (e) {
        console.error('[Auth] Failed to set organization default language:', e);
      }
    }
    
    // Regenerate session to prevent session fixation
    const sessionData = {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        avatarUrl: user.avatar_url,
        fullName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
      },
      organization: {
        id: user.org_id,
        name: user.org_name,
        slug: user.org_slug,
        logoUrl: user.org_logo,
        settings: user.org_settings || {}
      }
    };

    // Apply org default language for new sessions (user can still override later)
    try {
      const orgSettings = user.org_settings || {};
      const mode = orgSettings.default_language_mode || 'fixed';
      const lang = orgSettings.default_language;
      const hasI18nCookie = String(req.headers.cookie || '').includes('i18next=');
      if (!hasI18nCookie && mode === 'fixed' && ['en', 'nl', 'de', 'fr', 'es'].includes(lang)) {
        sessionData.language = lang;
      }
    } catch (_e) {}

    await regenerateSession(req, sessionData);
    // Mark this request's session so the dashboard can fire a single
    // "login-complete" analytics event (Gryffi Cloud). No personal data, only the auth method.
    req.session.justLoggedIn = { method: 'password' };
    await new Promise((resolve) => req.session.save(() => resolve()));
    res.redirect('/dashboard');
    
  } catch (err) {
    console.error('Login error:', err);
    req.session.error = 'An error occurred. Please try again.';
    res.redirect('/login');
  }
});

/**
 * POST /logout - Logout user
 */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/login');
  });
});

/**
 * GET /logout - Logout user (convenience)
 */
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/login');
  });
});

// ============================================
// LOGIN VERIFICATION (2FA / Security Code)
// ============================================

/**
 * GET /login/verify - Show login verification page
 */
router.get('/login/verify', guestOnly, (req, res) => {
  // Check if there's a pending login
  if (!req.session.pendingLogin) {
    return res.redirect('/login');
  }
  
  // Check if pending login is expired (10 minutes)
  if (Date.now() - req.session.pendingLogin.createdAt > LOGIN_SECURITY.CODE_EXPIRY) {
    delete req.session.pendingLogin;
    req.session.error = req.t('auth.loginVerification.codeExpired');
    return res.redirect('/login');
  }
  
  res.render('pages/login-verify', {
    title: req.t('auth.loginVerification.title'),
    email: req.session.pendingLogin.email,
    reason: req.session.pendingLogin.reason
  });
});

/**
 * POST /login/verify - Verify login code
 */
router.post('/login/verify', guestOnly, async (req, res) => {
  const { code } = req.body;
  
  // Check if there's a pending login
  if (!req.session.pendingLogin) {
    return res.status(400).json({ success: false, error: 'No pending login' });
  }
  
  const pendingLogin = req.session.pendingLogin;
  
  // Check if pending login is expired
  if (Date.now() - pendingLogin.createdAt > LOGIN_SECURITY.CODE_EXPIRY) {
    delete req.session.pendingLogin;
    return res.status(400).json({ success: false, error: req.t('auth.loginVerification.codeExpired') });
  }
  
  try {
    // Get user with verification code
    const result = await query(`
      SELECT 
        u.id, u.email, u.first_name, u.last_name, u.role, u.avatar_url,
        u.login_verification_code, u.login_verification_expires,
        o.id as org_id, o.name as org_name, o.slug as org_slug, o.logo_url as org_logo, o.settings as org_settings
      FROM users u
      JOIN organizations o ON u.organization_id = o.id
      WHERE u.id = $1
    `, [pendingLogin.userId]);
    
    if (result.rows.length === 0) {
      delete req.session.pendingLogin;
      return res.status(400).json({ success: false, error: 'User not found' });
    }
    
    const user = result.rows[0];
    
    // Check if code is expired
    if (!user.login_verification_expires || new Date(user.login_verification_expires) < new Date()) {
      return res.status(400).json({ success: false, error: req.t('auth.loginVerification.codeExpired') });
    }
    
    // Verify code. Wrong codes are counted per pending login (resends included);
    // after the limit the code is destroyed and the password is needed again.
    if (user.login_verification_code !== code) {
      pendingLogin.attempts = (pendingLogin.attempts || 0) + 1;
      if (pendingLogin.attempts >= LOGIN_SECURITY.MAX_CODE_ATTEMPTS) {
        delete req.session.pendingLogin;
        await query(
          'UPDATE users SET login_verification_code = NULL, login_verification_expires = NULL WHERE id = $1',
          [user.id]
        );
        await logLoginAttempt(user.email, req, false, 'verification_code_attempts');
        return res.status(400).json({ success: false, error: req.t('auth.loginVerification.tooManyAttempts'), restart: true });
      }
      return res.status(400).json({ success: false, error: req.t('auth.loginVerification.invalidCode') });
    }
    
    // Code is correct - complete login
    await logLoginAttempt(user.email, req, true);
    await resetFailedAttempts(user.id);
    
    // Clear verification code and update last login
    const currentIP = getClientIp(req);
    await query(`
      UPDATE users 
      SET login_verification_code = NULL, login_verification_expires = NULL,
          last_login_at = NOW(), last_login_ip = $1::inet
      WHERE id = $2
    `, [currentIP, user.id]);
    
    // Regenerate session to prevent session fixation
    const sessionData = {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        avatarUrl: user.avatar_url,
        fullName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
      },
      organization: {
        id: user.org_id,
        name: user.org_name,
        slug: user.org_slug,
        logoUrl: user.org_logo,
        settings: user.org_settings || {}
      }
    };

    // Apply org default language
    try {
      const orgSettings = user.org_settings || {};
      const mode = orgSettings.default_language_mode || 'fixed';
      const lang = orgSettings.default_language;
      const hasI18nCookie = String(req.headers.cookie || '').includes('i18next=');
      if (!hasI18nCookie && mode === 'fixed' && SUPPORTED_LANGUAGES.includes(lang)) {
        sessionData.language = lang;
      }
    } catch (_e) {}

    await regenerateSession(req, sessionData);
    // Mark session for a single login-complete event on the dashboard
    req.session.justLoggedIn = { method: 'password-2fa' };
    await new Promise((resolve) => req.session.save(() => resolve()));

    console.log(`[Auth] Login verification successful for ${user.email}`);
    
    return res.json({ success: true, redirect: '/dashboard' });
    
  } catch (err) {
    console.error('Login verification error:', err);
    return res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

/**
 * POST /login/verify/resend - Resend verification code
 */
router.post('/login/verify/resend', guestOnly, async (req, res) => {
  // Check if there's a pending login
  if (!req.session.pendingLogin) {
    return res.status(400).json({ success: false, error: 'No pending login' });
  }
  
  const pendingLogin = req.session.pendingLogin;

  // Each resend issues a fresh code, so limit them and never extend the
  // pending login beyond its maximum age: otherwise the attempt limit could be
  // bypassed by asking for new codes without entering the password again.
  const startedAt = pendingLogin.startedAt || pendingLogin.createdAt;
  if ((pendingLogin.resends || 0) >= LOGIN_SECURITY.MAX_CODE_RESENDS ||
      Date.now() - startedAt > LOGIN_SECURITY.PENDING_LOGIN_MAX_AGE) {
    delete req.session.pendingLogin;
    return res.status(400).json({ success: false, error: req.t('auth.loginVerification.tooManyAttempts'), restart: true });
  }
  
  try {
    // Get user
    const result = await query(`
      SELECT id, email, first_name, organization_id as org_id
      FROM users WHERE id = $1
    `, [pendingLogin.userId]);
    
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'User not found' });
    }
    
    const user = result.rows[0];
    
    // Generate new code
    const code = generateVerificationCode();
    await storeVerificationCode(user.id, code);
    await sendLoginVerificationEmail(user, code, pendingLogin.reason, req);
    
    // Update pending login timestamp (the code expiry), keep the original start
    req.session.pendingLogin.startedAt = startedAt;
    req.session.pendingLogin.createdAt = Date.now();
    req.session.pendingLogin.resends = (pendingLogin.resends || 0) + 1;
    
    return res.json({ success: true });
    
  } catch (err) {
    console.error('Resend verification code error:', err);
    return res.status(500).json({ success: false, error: 'Failed to resend code' });
  }
});

// ============================================
// PASSWORD RESET
// ============================================

/**
 * GET /forgot-password - Show forgot password page
 */
router.get('/forgot-password', guestOnly, (req, res) => {
  // Read and clear flash messages BEFORE rendering
  const error = req.session.error;
  const success = req.session.success;
  delete req.session.error;
  delete req.session.success;
  
  res.render('pages/forgot-password', {
    title: 'Forgot Password',
    error,
    success
  });
});

/**
 * POST /forgot-password - Request password reset
 */
router.post('/forgot-password', guestOnly, async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    req.session.error = 'Please enter your email address';
    return res.redirect('/forgot-password');
  }
  
  try {
    // Find user
    const result = await query(`
      SELECT u.id, u.email, u.first_name, u.last_name, o.name as org_name
      FROM users u
      JOIN organizations o ON u.organization_id = o.id
      WHERE u.email = $1 AND u.is_active = true
      -- Same address in several organizations (older data): the most recently used account
      ORDER BY u.last_login_at DESC NULLS LAST, u.created_at DESC
      LIMIT 1
    `, [email.toLowerCase().trim()]);
    
    // Always show success message (security - don't reveal if email exists)
    req.session.success = 'If this email address is registered with us, you will receive a reset link within a few minutes.';
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      
      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
      const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      
      // Save token to database
      await query(`
        UPDATE users 
        SET password_reset_token = $1, password_reset_expires = $2 
        WHERE id = $3
      `, [resetTokenHash, resetExpires, user.id]);
      
      // Send email
      const resetLink = `${getAppBaseUrl()}/reset-password?token=${resetToken}`;
      const userName = user.first_name ? `${user.first_name}${user.last_name ? ' ' + user.last_name : ''}` : 'there';

      // Determine language for system emails:
      // - fixed org language => use it
      // - auto => use current request language (best-effort)
      // - fallback => English
      let emailLng = 'en';
      try {
        const orgRes = await query('SELECT settings FROM organizations WHERE name = $1 LIMIT 1', [user.org_name]);
        const settings = orgRes.rows[0]?.settings || {};
        const mode = settings.default_language_mode || 'fixed';
        const fixed = settings.default_language;
        const supported = ['en', 'nl', 'de', 'fr', 'es'];
        if (mode === 'fixed' && supported.includes(fixed)) emailLng = fixed;
        else if (supported.includes(req.language)) emailLng = req.language;
      } catch (_e) {}

      const subject = req.t('emails.passwordReset.subject', { lng: emailLng, companyName: user.org_name || 'Gryffi' });
      const body = req.t('emails.passwordReset.body', { lng: emailLng, userName, companyName: user.org_name || 'Gryffi' });

      await sendEmail({
        to: user.email,
        subject,
        templateType: 'journey_custom',
        variables: {
          company_name: user.org_name || 'Gryffi',
          user_first_name: user.first_name || '',
          custom_link: resetLink,
          custom_link_text: req.t('emails.passwordReset.cta', { lng: emailLng })
        },
        customBody: body,
        language: emailLng
      });
      console.log('[Auth] Password reset email sent to:', user.email);
    }
    
    res.redirect('/forgot-password');
    
  } catch (err) {
    console.error('Forgot password error:', err);
    req.session.error = 'Something went wrong. Please try again later.';
    res.redirect('/forgot-password');
  }
});

/**
 * GET /reset-password - Show reset password page
 */
router.get('/reset-password', guestOnly, async (req, res) => {
  const { token } = req.query;
  
  if (!token) {
    req.session.error = 'Invalid or expired reset link';
    return res.redirect('/forgot-password');
  }
  
  try {
    // Verify token
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await query(`
      SELECT id FROM users 
      WHERE password_reset_token = $1 
        AND password_reset_expires > NOW()
        AND is_active = true
    `, [tokenHash]);
    
    if (result.rows.length === 0) {
      req.session.error = 'This reset link is invalid or has expired. Please request a new one.';
      return res.redirect('/forgot-password');
    }
    
    // Read and clear flash message BEFORE rendering
    const error = req.session.error;
    delete req.session.error;
    
    res.render('pages/reset-password', {
      title: 'Set New Password',
      token: token,
      error
    });
    
  } catch (err) {
    console.error('Reset password page error:', err);
    req.session.error = 'Something went wrong. Please try again later.';
    res.redirect('/forgot-password');
  }
});

/**
 * POST /reset-password - Set new password
 */
router.post('/reset-password', guestOnly, async (req, res) => {
  const { token, password, password_confirm } = req.body;
  
  if (!token || !password) {
    req.session.error = 'Please enter a new password';
    return res.redirect(`/reset-password?token=${token}`);
  }
  
  if (password.length < 8) {
    req.session.error = 'Password must be at least 8 characters';
    return res.redirect(`/reset-password?token=${token}`);
  }
  
  if (password !== password_confirm) {
    req.session.error = 'Passwords do not match';
    return res.redirect(`/reset-password?token=${token}`);
  }
  
  try {
    // Verify token
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await query(`
      SELECT id, email FROM users 
      WHERE password_reset_token = $1 
        AND password_reset_expires > NOW()
        AND is_active = true
    `, [tokenHash]);
    
    if (result.rows.length === 0) {
      req.session.error = 'This reset link is invalid or has expired. Please request a new one.';
      return res.redirect('/forgot-password');
    }
    
    const user = result.rows[0];
    
    // Hash new password
    const passwordHash = await bcrypt.hash(password, 12);
    
    // Update password and clear reset token
    await query(`
      UPDATE users 
      SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL 
      WHERE id = $2
    `, [passwordHash, user.id]);
    
    console.log('[Auth] Password reset successful for:', user.email);
    
    req.session.success = 'Your password has been successfully changed. You can now sign in.';
    res.redirect('/login');
    
  } catch (err) {
    console.error('Reset password error:', err);
    req.session.error = 'Something went wrong. Please try again later.';
    res.redirect(`/reset-password?token=${token}`);
  }
});

// ============================================
// TEAM INVITES (Builder users)
// ============================================

/**
 * GET /invite - Accept invitation page
 */
router.get('/invite', guestOnly, async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.render('pages/invite', {
      title: req.t('team.inviteAccept.title'),
      error: req.t('team.inviteAccept.invalidLink'),
      invite: null,
      token: ''
    });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const result = await query(
      `
        SELECT i.email, i.role, i.expires_at, o.id AS org_id, o.name AS org_name
        FROM user_invites i
        JOIN organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1
          AND i.accepted_at IS NULL
          AND i.revoked_at IS NULL
          AND i.expires_at > NOW()
      `,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.render('pages/invite', {
        title: req.t('team.inviteAccept.title'),
        error: req.t('team.inviteAccept.invalidOrExpired'),
        invite: null,
        token: String(token)
      });
    }

    res.render('pages/invite', {
      title: req.t('team.inviteAccept.title'),
      error: null,
      invite: result.rows[0],
      token: String(token)
    });
  } catch (err) {
    console.error('Invite page error:', err);
    res.render('pages/invite', {
      title: req.t('team.inviteAccept.title'),
      error: req.t('team.inviteAccept.somethingWrong'),
      invite: null,
      token: String(token)
    });
  }
});

/**
 * POST /invite - Accept invitation and create account
 */
router.post('/invite', guestOnly, async (req, res) => {
  const { token, first_name, last_name, password, password_confirm, terms_agree, marketing_consent } = req.body || {};

  if (!token) {
    return res.render('pages/invite', {
      title: req.t('team.inviteAccept.title'),
      error: req.t('team.inviteAccept.invalidOrExpired'),
      invite: null,
      token: ''
    });
  }

  if (!password || password.length < 8) {
    return res.render('pages/invite', {
      title: req.t('team.inviteAccept.title'),
      error: req.t('team.inviteAccept.passwordTooShort'),
      invite: null,
      token: String(token)
    });
  }

  if (password !== password_confirm) {
    return res.render('pages/invite', {
      title: req.t('team.inviteAccept.title'),
      error: req.t('team.inviteAccept.passwordsDoNotMatch'),
      invite: null,
      token: String(token)
    });
  }

  // Only Gryffi Cloud has terms to agree to and tips to send
  const agreedAt = isCloud() ? new Date() : null;
  const marketingConsentAt = isCloud() && marketing_consent ? new Date() : null;

  if (isCloud() && !terms_agree) {
    return res.render('pages/invite', {
      title: req.t('team.inviteAccept.title'),
      error: req.t('team.inviteAccept.termsRequired'),
      invite: null,
      token: String(token)
    });
  }

  const firstName = typeof first_name === 'string' ? first_name.trim().slice(0, 100) : '';
  const lastName = typeof last_name === 'string' ? last_name.trim().slice(0, 100) : '';

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const invRes = await client.query(
      `
        SELECT i.id, i.organization_id, i.email, i.role,
               o.id AS org_id, o.name AS org_name, o.slug AS org_slug, o.logo_url AS org_logo, o.settings AS org_settings
        FROM user_invites i
        JOIN organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1
          AND i.accepted_at IS NULL
          AND i.revoked_at IS NULL
          AND i.expires_at > NOW()
        FOR UPDATE
      `,
      [tokenHash]
    );

    if (invRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.render('pages/invite', {
        title: req.t('team.inviteAccept.title'),
        error: req.t('team.inviteAccept.invalidOrExpired'),
        invite: null,
        token: String(token)
      });
    }

    const invite = invRes.rows[0];

    // One email address belongs to one organization (also for invites sent
    // before this rule existed)
    const otherOrg = await client.query(
      'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND organization_id <> $2 LIMIT 1',
      [invite.email, invite.organization_id]
    );
    if (otherOrg.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.render('pages/invite', {
        title: req.t('team.inviteAccept.title'),
        error: req.t('team.inviteAccept.emailInOtherOrg'),
        invite: null,
        token: String(token)
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // If user already exists in this org, activate and update it; else create new
    const userRes = await client.query(
      `SELECT id, is_active FROM users WHERE organization_id = $1 AND email = $2 FOR UPDATE`,
      [invite.organization_id, invite.email]
    );

    let userId = null;
    if (userRes.rows.length > 0) {
      userId = userRes.rows[0].id;
      await client.query(
        `
          UPDATE users
          SET first_name = $1,
              last_name = $2,
              password_hash = $3,
              role = $4,
              is_active = true,
              terms_agreed_at = $8,
              marketing_consent_at = $7,
              updated_at = NOW()
          WHERE id = $5 AND organization_id = $6
        `,
        [firstName || null, lastName || null, passwordHash, invite.role, userId, invite.organization_id, marketingConsentAt, agreedAt]
      );
    } else {
      const created = await client.query(
        `
          INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, is_active, terms_agreed_at, marketing_consent_at)
          VALUES ($1, $2, $3, $4, $5, $6, true, $8, $7)
          RETURNING id
        `,
        [invite.organization_id, invite.email, passwordHash, firstName || null, lastName || null, invite.role, marketingConsentAt, agreedAt]
      );
      userId = created.rows[0].id;
    }

    await client.query(
      `UPDATE user_invites SET accepted_at = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2`,
      [invite.id, invite.organization_id]
    );

    await client.query('COMMIT');

    // Regenerate session to prevent session fixation
    const sessionData = {
      user: {
        id: userId,
        email: invite.email,
        firstName: firstName || '',
        lastName: lastName || '',
        role: invite.role,
        avatarUrl: null,
        fullName: [firstName, lastName].filter(Boolean).join(' ') || invite.email
      },
      organization: {
        id: invite.org_id,
        name: invite.org_name,
        slug: invite.org_slug,
        logoUrl: invite.org_logo,
        settings: invite.org_settings || {}
      }
    };

    // Apply org default language after accepting invite (best-effort)
    try {
      const orgSettings = invite.org_settings || {};
      const mode = orgSettings.default_language_mode || 'fixed';
      const lang = orgSettings.default_language;
      const hasI18nCookie = String(req.headers.cookie || '').includes('i18next=');
      if (!hasI18nCookie && mode === 'fixed' && ['en', 'nl', 'de', 'fr', 'es'].includes(lang)) {
        sessionData.language = lang;
      }
    } catch (_e) {}

    await regenerateSession(req, sessionData);
    // Mark session for a single login-complete event on the dashboard
    req.session.justLoggedIn = { method: 'invite-accept' };
    await new Promise((resolve) => req.session.save(() => resolve()));
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Invite accept error:', err);
    try { await client.query('ROLLBACK'); } catch (_e) {}
    res.render('pages/invite', {
      title: req.t('team.inviteAccept.title'),
      error: req.t('team.inviteAccept.somethingWrong'),
      invite: null,
      token: String(token)
    });
  } finally {
    client.release();
  }
});

// ============================================
// MAGIC LINKS (End User Journey Access)
// ============================================

/**
 * GET /e/:token - Access journey via magic link
 * This is the main entry point for end users
 * Rate limited to prevent abuse while allowing high legitimate usage
 */
router.get('/e/:token', magicLinkLimiter, async (req, res) => {
  const { token } = req.params;
  
  // Check if this IP is blocked due to too many invalid token attempts
  if (isInvalidTokenBlocked(req)) {
    const ip = getClientIp(req);
    console.warn(`[Magic Link] Blocked request from ${ip} - too many invalid token attempts`);
    return res.status(429).render('pages/expedition-error', {
      title: 'Too Many Requests',
      message: 'Too many failed attempts. Please try again later.',
      errorType: 'rate_limited'
    });
  }
  
  if (!token) {
    return res.status(400).render('pages/expedition-error', {
      title: req.t('invitations.magicLink.expired.title'),
      message: req.t('invitations.magicLink.expired.message'),
      errorType: 'invalid'
    });
  }
  
  try {
    // Find invitation by token
    const result = await query(`
      SELECT 
        i.*,
        eu.id as end_user_id,
        eu.email as end_user_email,
        eu.first_name as end_user_first_name,
        eu.last_name as end_user_last_name,
        j.id as journey_id,
        j.title as journey_title,
        j.description as journey_description,
        j.status as journey_status,
        j.settings as journey_settings,
        j.cover_image_url,
        j.guide_id as guide_id,
        o.id as org_id,
        o.name as org_name,
        o.logo_url as org_logo,
        COALESCE(o.settings->>'default_language', 'en') as org_language
      FROM invitations i
      JOIN end_users eu ON i.end_user_id = eu.id
      JOIN journeys j ON i.journey_id = j.id
      JOIN organizations o ON i.organization_id = o.id
      WHERE i.token = $1
    `, [token]);
    
    if (result.rows.length === 0) {
      // Track this as an invalid token attempt (potential bot)
      trackInvalidToken(req);
      
      return res.status(404).render('pages/expedition-error', {
        title: req.t('invitations.magicLink.expired.title'),
        message: req.t('invitations.magicLink.expired.message'),
        errorType: 'not_found'
      });
    }
    
    const invitation = result.rows[0];
    
    // Get organization language for error messages
    const orgLanguage = invitation.org_language || 'en';
    
    // Determine journey language: use journey override if set, otherwise use org language
    const journeySettings = typeof invitation.journey_settings === 'string' 
      ? JSON.parse(invitation.journey_settings) 
      : (invitation.journey_settings || {});
    const journeyLanguage = journeySettings.language_override && journeySettings.language_code 
      ? journeySettings.language_code 
      : orgLanguage;
    
    // Determine AI Guide language: use guide language override if set, otherwise same as journey language
    const guideLanguage = journeySettings.guide_language_override && journeySettings.guide_language_code 
      ? journeySettings.guide_language_code 
      : journeyLanguage;
    
    const t = i18next.getFixedT(journeyLanguage);
    
    // Check status
    if (invitation.status === 'revoked') {
      return res.render('pages/expedition-error', {
        title: t('invitations.magicLink.revoked.title'),
        message: t('invitations.magicLink.revoked.message'),
        errorType: 'revoked'
      });
    }
    
    if (invitation.status === 'completed') {
      return res.render('pages/expedition-error', {
        title: t('invitations.magicLink.completed.title'),
        message: t('invitations.magicLink.completed.message'),
        errorType: 'completed'
      });
    }
    
    // Check expiration
    if (new Date(invitation.expires_at) < new Date()) {
      // Update status to expired
      await query(
        "UPDATE invitations SET status = 'expired' WHERE id = $1",
        [invitation.id]
      );
      return res.render('pages/expedition-error', {
        title: t('invitations.magicLink.expired.title'),
        message: t('invitations.magicLink.expired.message'),
        errorType: 'expired'
      });
    }
    
    // Check max completions
    if (invitation.max_completions && invitation.completions_count >= invitation.max_completions) {
      return res.render('pages/expedition-error', {
        title: t('invitations.magicLink.completed.title'),
        message: t('invitations.magicLink.completed.message'),
        errorType: 'max_completions'
      });
    }
    
    // Get device fingerprint from session or create one
    const existingFingerprint = req.session.deviceFingerprint;
    const deviceFingerprint = existingFingerprint || crypto.randomBytes(16).toString('hex');
    req.session.deviceFingerprint = deviceFingerprint;
    
    console.log(`[MagicLink] Existing fingerprint: ${existingFingerprint ? 'yes' : 'NONE (new)'}, UA: ${req.headers['user-agent']?.substring(0, 50)}`);
    
    // Force session save to ensure cookie is sent
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error('[MagicLink] Session save error:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
    
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';
    
    // Check for existing device session
    const existingSession = await query(
      `SELECT * FROM invitation_sessions 
       WHERE invitation_id = $1 AND device_fingerprint = $2`,
      [invitation.id, deviceFingerprint]
    );
    
    // Count total device sessions for this invitation
    const sessionCount = await query(
      `SELECT COUNT(*) as count FROM invitation_sessions WHERE invitation_id = $1`,
      [invitation.id]
    );
    const totalDevices = parseInt(sessionCount.rows[0].count);
    
    let needsVerification = false;
    let sessionId = null;
    
    if (existingSession.rows.length > 0) {
      // Existing device - update last active
      sessionId = existingSession.rows[0].id;
      await query(
        `UPDATE invitation_sessions SET last_active_at = NOW(), ip_address = $1 WHERE id = $2`,
        [ipAddress, sessionId]
      );
      
      // Check if device is verified
      if (!existingSession.rows[0].verified && totalDevices > 2) {
        needsVerification = true;
      }
    } else {
      // New device
      if (totalDevices >= 2) {
        // Third+ device - needs verification
        needsVerification = true;
      }
      
      // Create new session
      const newSession = await query(
        `INSERT INTO invitation_sessions 
         (invitation_id, device_fingerprint, ip_address, user_agent, verified)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [invitation.id, deviceFingerprint, ipAddress, userAgent, !needsVerification]
      );
      sessionId = newSession.rows[0].id;
    }
    
    // Update invitation first access
    if (!invitation.first_accessed_at) {
      await query(
        `UPDATE invitations SET first_accessed_at = NOW(), status = 'active', last_accessed_at = NOW() WHERE id = $1`,
        [invitation.id]
      );
    } else {
      await query(
        `UPDATE invitations SET last_accessed_at = NOW() WHERE id = $1`,
        [invitation.id]
      );
    }
    
    // If needs verification, show verification page
    if (needsVerification) {
      // Issue a code; a page reload re-uses a still valid code (no new mail)
      const { code: verificationCode, isNew } = await issueDeviceVerificationCode(sessionId);
      
      // Send verification email
      if (isNew) {
        try {
          await sendVerificationCodeEmail({
            to: invitation.end_user_email,
            firstName: invitation.end_user_first_name,
            journeyTitle: invitation.journey_title,
            verificationCode: verificationCode,
            language: invitation.org_language || 'en',
            orgId: invitation.org_id // For custom theme support
          });
        } catch (emailErr) {
          console.error('Failed to send verification email:', emailErr);
        }
      }
      
      return res.render('pages/expedition-verify', {
        title: req.t('invitations.magicLink.verification.title'),
        token,
        firstName: invitation.end_user_first_name,
        journeyTitle: invitation.journey_title,
        error: null
      });
    }
    
    // A session that gets a journey it did not have yet gets a new ID
    if (!hasExpeditionSession(req, token)) {
      await rotateSessionId(req);
    }

    // Store invitation info in session for the journey
    req.session.expedition = {
      invitationId: invitation.id,
      sessionId,
      endUserId: invitation.end_user_id,
      journeyId: invitation.journey_id,
      token,
      firstName: invitation.end_user_first_name,
      lastName: invitation.end_user_last_name,
      email: invitation.end_user_email
    };
    rememberExpeditionToken(req, token);
    
    // Get journey steps for the expedition
    const stepsResult = await query(
      `SELECT * FROM steps WHERE journey_id = $1 ORDER BY created_at`,
      [invitation.journey_id]
    );
    
    const pathsResult = await query(
      `SELECT * FROM paths WHERE journey_id = $1 ORDER BY sort_order`,
      [invitation.journey_id]
    );
    
    const resourcesResult = await query(
      `SELECT * FROM resources WHERE journey_id = $1`,
      [invitation.journey_id]
    );
    
    // Get or create progress
    let progressResult = await query(
      `SELECT * FROM end_user_progress WHERE invitation_id = $1`,
      [invitation.id]
    );
    
    if (progressResult.rows.length === 0) {
      // Create new progress record
      const startStep = stepsResult.rows.find(s => s.is_start);
      await query(
        `INSERT INTO end_user_progress 
         (invitation_id, end_user_id, journey_id, current_step_id)
         VALUES ($1, $2, $3, $4)`,
        [invitation.id, invitation.end_user_id, invitation.journey_id, startStep?.id || null]
      );
      progressResult = await query(
        `SELECT * FROM end_user_progress WHERE invitation_id = $1`,
        [invitation.id]
      );
    }
    
    // Check if journey was completed and user can restart
    const progress = progressResult.rows[0];
    const canRestartMore = invitation.max_completions === null || 
      (invitation.completions_count || 0) < invitation.max_completions;
    const isReviewMode = req.query.review === '1';
    const isRestartMode = req.query.restart === '1';
    
    // Clean up nested_context when user returns via magic link
    // If user was in a nested journey and left, we need to restore them to the parent journey
    // (they can't resume mid-nested-journey via magic link reload)
    if (progress?.nested_context) {
      const nestedCtx = typeof progress.nested_context === 'string' 
        ? JSON.parse(progress.nested_context) 
        : progress.nested_context;
      
      console.log('[MagicLink] User had nested_context, restoring to parent journey. Parent step:', nestedCtx?.parent_step_id);
      
      // Restore progress to parent journey state
      await query(`
        UPDATE end_user_progress 
        SET nested_context = NULL,
            journey_id = $1,
            current_step_id = $2
        WHERE invitation_id = $3
      `, [nestedCtx?.parent_journey_id || invitation.journey_id, nestedCtx?.parent_step_id, invitation.id]);
      
      progress.nested_context = null;
      progress.journey_id = nestedCtx?.parent_journey_id || invitation.journey_id;
      progress.current_step_id = nestedCtx?.parent_step_id;
    }
    
    // If journey was completed, can do more, and not in review/restart mode, show welcome back screen
    if (progress?.completed_at && canRestartMore && !isReviewMode && !isRestartMode) {
      return res.render('pages/expedition-welcome-back', {
        title: invitation.journey_title,
        language: journeyLanguage,
        token: token,
        welcomeTitle: t('invitations.magicLink.welcomeBack.title', { firstName: invitation.end_user_first_name }),
        welcomeMessage: t('invitations.magicLink.welcomeBack.message'),
        restartButton: t('invitations.magicLink.welcomeBack.restartButton'),
        reviewButton: t('invitations.magicLink.welcomeBack.reviewButton')
      });
    }
    
    // Parse journey settings
    const settings = typeof invitation.journey_settings === 'string' 
      ? JSON.parse(invitation.journey_settings) 
      : (invitation.journey_settings || {});
    
    // Build journey object with settings extracted to top level (same as dashboard builder)
    const fullJourney = {
      id: invitation.journey_id,
      title: invitation.journey_title,
      description: invitation.journey_description,
      cover_image_url: invitation.cover_image_url,
      organization_id: invitation.org_id,
      status: invitation.journey_status,
      settings: settings,
      // Extract settings to top level for builder template compatibility
      completion_message: settings.completion_message || '',
      allow_skip: settings.allow_skip || false,
      track_progress: settings.track_progress !== false,
      language_override: settings.language_override || false,
      language_code: settings.language_code || null,
      guide_language_override: settings.guide_language_override || false,
      guide_language_code: settings.guide_language_code || null,
      guide_opening_override: settings.guide_opening_override || '',
      guide_id: invitation.guide_id || null
    };
    
    console.log('[MagicLink] Journey language settings - override:', fullJourney.language_override, 
      'code:', fullJourney.language_code, 'guideLanguage:', guideLanguage, 'guideOpeningOverride:', fullJourney.guide_opening_override ? 'set' : 'empty');
    
    // Get translations for this language using i18next directly
    // Note: journeyLanguage is already defined earlier (uses journey override or org default)
    const tFunc = i18next.getFixedT(journeyLanguage);
    
    // Get guides for this organization (needed for guide steps)
    const guidesResult = await query(
      `SELECT ${PLAYER_GUIDE_COLUMNS} FROM guides WHERE organization_id = $1 AND deleted_at IS NULL`,
      [invitation.org_id]
    );
    
    // Load journey-specific translations
    const jt = i18next.getFixedT(journeyLanguage);
    const journeyTranslations = {
      builder: jt('builder', { returnObjects: true }),
      common: jt('common', { returnObjects: true }),
      journeys: jt('journeys', { returnObjects: true }),
      guides: jt('guides', { returnObjects: true }),
      imagePicker: jt('imagePicker', { returnObjects: true }),
      expedition: jt('expedition', { returnObjects: true })
    };
    
    // Load player-specific translations (supports extended languages)
    const playerTranslations = getPlayerLocale(journeyLanguage);
    
    // Render builder template in PLAYER MODE (read-only, no edit controls)
    // This ensures the end-user experience is 100% identical to Preview Mode
    res.render('pages/builder', {
      title: invitation.journey_title,
      
      // CRITICAL: Player mode flags for security
      playerMode: true,          // Enables player mode UI
      readOnly: true,            // Prevents any modifications
      
      // Journey data (same as builder)
      journey: fullJourney,
      steps: stripQuizAnswers(stepsResult.rows),
      paths: pathsResult.rows,
      resources: resourcesResult.rows,
      guides: guidesResult.rows,
      
      // Organization (for logo, etc.)
      organization: {
        id: invitation.org_id,
        name: invitation.org_name,
        logoUrl: invitation.org_logo,
        defaultLanguage: orgLanguage
      },
      
      // Journey-specific language for interface
      locale: journeyLanguage,
      language: journeyLanguage,
      interfaceTranslations: journeyTranslations, // Pre-loaded translations for journey language (used by template as main translations)
      previewTranslations: journeyTranslations, // Same translations for preview content
      playerTranslations: playerTranslations, // Player-specific translations (extended language support)
      guideLanguage: guideLanguage, // AI Guide response language
      
      // Player mode specific data
      player: {
        token: token,
        endUser: {
          firstName: invitation.end_user_first_name,
          lastName: invitation.end_user_last_name,
          email: invitation.end_user_email
        },
        invitationId: invitation.id,
        progress: progressResult.rows[0],
        language: journeyLanguage,
        guideLanguage: guideLanguage,
        maxCompletions: invitation.max_completions,
        completionsCount: invitation.completions_count || 0
      },
      
      t: tFunc
    });
    
  } catch (err) {
    console.error('Magic link error:', err);
    res.status(500).render('pages/expedition-error', {
      title: 'Error',
      message: 'Something went wrong. Please try again later.',
      errorType: 'server_error'
    });
  }
});

/**
 * Magic-link API calls need a browser session that opened this link (and,
 * on a third or later device, passed the verification code). Without this
 * the bare token in a forwarded link would give full API access and skip the
 * device check. Only the page itself and the verification steps are open.
 */
router.use('/e/:token', (req, res, next) => {
  if (req.path === '/' || req.path === '/verify' || req.path === '/resend') return next();
  if (hasExpeditionSession(req, req.params.token)) return next();
  return res.status(401).json({
    success: false,
    code: 'EXPEDITION_SESSION_REQUIRED',
    error: 'Open the link from your email again to continue.'
  });
});

/**
 * POST /e/:token/verify - Verify device with code
 */
router.post('/e/:token/verify', async (req, res) => {
  const { token } = req.params;
  const { code } = req.body;
  
  console.log(`[Verify] Token: ${token?.substring(0, 10)}..., Has fingerprint: ${!!req.session.deviceFingerprint}`);
  
  if (!token || !code) {
    return res.status(400).json({ success: false, error: 'Missing code' });
  }
  
  try {
    const deviceFingerprint = req.session.deviceFingerprint;
    
    if (!deviceFingerprint) {
      console.log(`[Verify] No fingerprint in session! Session data:`, JSON.stringify(req.session));
      return res.status(400).json({ success: false, error: 'Session expired' });
    }
    
    // Find invitation and session
    const result = await query(`
      SELECT 
        i.id as invitation_id,
        s.id as session_id,
        s.verification_code,
        s.verification_expires_at,
        s.verification_attempts
      FROM invitations i
      JOIN invitation_sessions s ON s.invitation_id = i.id
      WHERE i.token = $1 AND s.device_fingerprint = $2
    `, [token, deviceFingerprint]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    const session = result.rows[0];
    
    // Check attempts
    if (session.verification_attempts >= DEVICE_CODE_MAX_ATTEMPTS) {
      return res.status(429).json({ 
        success: false, 
        error: req.t('invitations.magicLink.verification.lockedWait') 
      });
    }
    
    // Check expiration
    if (new Date(session.verification_expires_at) < new Date()) {
      return res.status(400).json({ 
        success: false, 
        error: req.t('invitations.magicLink.verification.expired') 
      });
    }
    
    // Check code
    if (code !== session.verification_code) {
      // Increment attempts
      await query(
        `UPDATE invitation_sessions SET verification_attempts = verification_attempts + 1 WHERE id = $1`,
        [session.session_id]
      );
      return res.status(400).json({ 
        success: false, 
        error: req.t('invitations.magicLink.verification.invalid') 
      });
    }
    
    // Verify session
    await query(
      `UPDATE invitation_sessions 
       SET verified = true, verification_code = NULL, verification_expires_at = NULL, verification_attempts = 0
       WHERE id = $1`,
      [session.session_id]
    );
    
    console.log(`[Verify] SUCCESS for session ${session.session_id}, fingerprint: ${deviceFingerprint?.substring(0, 10)}...`);
    
    res.json({ success: true, redirect: `/e/${token}` });
    
  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

/**
 * POST /e/:token/resend - Resend verification code
 */
router.post('/e/:token/resend', async (req, res) => {
  const { token } = req.params;
  
  try {
    const deviceFingerprint = req.session.deviceFingerprint;
    
    if (!deviceFingerprint) {
      return res.status(400).json({ success: false, error: 'Session expired' });
    }
    
    // Find invitation and session
    const result = await query(`
      SELECT 
        i.id as invitation_id,
        i.organization_id as org_id,
        s.id as session_id,
        eu.email,
        eu.first_name,
        j.title as journey_title,
        COALESCE(o.settings->>'default_language', 'en') as org_language
      FROM invitations i
      JOIN invitation_sessions s ON s.invitation_id = i.id
      JOIN end_users eu ON i.end_user_id = eu.id
      JOIN journeys j ON i.journey_id = j.id
      JOIN organizations o ON i.organization_id = o.id
      WHERE i.token = $1 AND s.device_fingerprint = $2
    `, [token, deviceFingerprint]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    const data = result.rows[0];
    
    // Re-send the current code (or a new one once it expired). Never reset
    // the guess counter while a code is still valid.
    const { code: verificationCode } = await issueDeviceVerificationCode(data.session_id);
    if (!verificationCode) {
      return res.status(429).json({
        success: false,
        error: req.t('invitations.magicLink.verification.lockedWait')
      });
    }
    
    // Send email
    await sendVerificationCodeEmail({
      to: data.email,
      firstName: data.first_name,
      journeyTitle: data.journey_title,
      verificationCode: verificationCode,
      language: data.org_language || 'en',
      orgId: data.org_id // For custom theme support
    });
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ success: false, error: 'Failed to resend code' });
  }
});

// ============================================
// EXPEDITION API (Progress & Completion)
// ============================================

/**
 * POST /e/:token/progress - Save journey progress
 */
router.post('/e/:token/progress', async (req, res) => {
  const { token } = req.params;
  const { current_step_id, visited_steps, answers } = req.body;
  
  try {
    // Verify token and get invitation
    const result = await query(
      `SELECT i.id, i.status, eup.id as progress_id
       FROM invitations i
       LEFT JOIN end_user_progress eup ON eup.invitation_id = i.id
       WHERE i.token = $1 AND i.status IN ('pending', 'active')`,
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invitation not found' });
    }
    
    const invitation = result.rows[0];
    
    // Update progress
    await query(
      `UPDATE end_user_progress 
       SET current_step_id = $1, 
           visited_steps = $2,
           answers = $3
       WHERE invitation_id = $4`,
      [current_step_id, visited_steps || [], JSON.stringify(answers || {}), invitation.id]
    );
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('Save progress error:', err);
    res.status(500).json({ success: false, error: 'Failed to save progress' });
  }
});

/**
 * POST /e/:token/tts - Generate speech for step text (journey player)
 * Uses Mistral Voxtral TTS with disk caching; see services/tts.js.
 * The client falls back to the Web Speech API on any error response.
 */
router.post('/e/:token/tts', playerTtsLimiter, async (req, res) => {
  const { token } = req.params;
  
  try {
    const result = await query(
      `SELECT i.id FROM invitations i
       WHERE i.token = $1 AND i.status IN ('pending', 'active')`,
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invitation not found' });
    }
    
    return handleTtsRequest(req, res);
    
  } catch (err) {
    console.error('Player TTS error:', err);
    res.status(500).json({ success: false, error: 'TTS_ERROR' });
  }
});

/**
 * GET /tts-audio/:file - Serve cached TTS audio
 * Files are content-addressed (sha256 of model+voice+language+text), so the
 * URL is unguessable and the content is immutable -> cache aggressively.
 */
router.get('/tts-audio/:file', (req, res) => {
  const { file } = req.params;
  
  if (!/^[a-f0-9]{64}\.mp3$/.test(file)) {
    return res.status(400).send('Invalid file');
  }
  
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(getTtsCacheDir(), file), (err) => {
    if (err && !res.headersSent) {
      res.status(404).send('Not found');
    }
  });
});

/**
 * POST /e/:token/enter-nested - Enter a nested journey
 * Saves current progress and loads nested journey data
 */
router.post('/e/:token/enter-nested', async (req, res) => {
  const { token } = req.params;
  const { step_id, nested_journey_id, current_step_id, visited_steps, answers } = req.body;
  
  try {
    // Verify token and get invitation with current progress
    const result = await query(`
      SELECT 
        i.id as invitation_id, 
        i.status, 
        i.journey_id as parent_journey_id,
        i.organization_id,
        eup.id as progress_id,
        eup.nested_context
      FROM invitations i
      LEFT JOIN end_user_progress eup ON eup.invitation_id = i.id
      WHERE i.token = $1 AND i.status IN ('pending', 'active')
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invitation not found' });
    }
    
    const { invitation_id, parent_journey_id, organization_id, nested_context } = result.rows[0];
    
    // Prevent double-nesting (only one level deep for now)
    if (nested_context) {
      return res.status(400).json({ 
        success: false, 
        error: 'Already in a nested journey. Complete it first.' 
      });
    }
    
    // Verify the nested journey exists and is published
    const nestedJourneyResult = await query(`
      SELECT 
        j.id, j.title, j.description, j.cover_image_url, j.settings,
        j.status
      FROM journeys j
      WHERE j.id = $1 AND j.organization_id = $2 AND j.status = 'published'
    `, [nested_journey_id, organization_id]);
    
    if (nestedJourneyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Nested journey not found or not published' });
    }
    
    const nestedJourney = nestedJourneyResult.rows[0];
    
    // Load nested journey steps and paths
    const stepsResult = await query(
      `SELECT * FROM steps WHERE journey_id = $1 ORDER BY position_y, position_x`,
      [nested_journey_id]
    );
    
    const pathsResult = await query(
      `SELECT * FROM paths WHERE journey_id = $1 ORDER BY sort_order`,
      [nested_journey_id]
    );
    
    const resourcesResult = await query(
      `SELECT * FROM resources WHERE journey_id = $1`,
      [nested_journey_id]
    );
    
    // Get guides for this organization
    const guidesResult = await query(
      `SELECT ${PLAYER_GUIDE_COLUMNS} FROM guides WHERE organization_id = $1 AND deleted_at IS NULL`,
      [organization_id]
    );
    
    // Find start step of nested journey
    const startStep = stepsResult.rows.find(s => s.is_start) || stepsResult.rows[0];
    
    // Save parent context and switch to nested journey
    const parentContext = {
      parent_journey_id: parent_journey_id,
      parent_step_id: step_id,
      parent_current_step_id: current_step_id,
      parent_visited_steps: visited_steps || [],
      parent_answers: answers || {},
      entry_time: new Date().toISOString()
    };
    
    // Update progress: save parent context, switch to nested journey
    await query(`
      UPDATE end_user_progress 
      SET nested_context = $1,
          journey_id = $2,
          current_step_id = $3,
          visited_steps = '{}',
          answers = '{}'
      WHERE invitation_id = $4
    `, [JSON.stringify(parentContext), nested_journey_id, startStep?.id, invitation_id]);
    
    // Parse nested journey settings for language
    const nestedSettings = typeof nestedJourney.settings === 'string' 
      ? JSON.parse(nestedJourney.settings) 
      : (nestedJourney.settings || {});
    
    // Get organization default language
    const orgResult = await query(`SELECT settings FROM organizations WHERE id = $1`, [organization_id]);
    const orgSettings = orgResult.rows[0]?.settings || {};
    const orgDefaultLanguage = orgSettings.default_language || 'en';
    
    // Determine the language for this nested journey
    const nestedLanguage = nestedSettings.language_override && nestedSettings.language_code 
      ? nestedSettings.language_code 
      : orgDefaultLanguage;
    
    // Get translations for the nested journey language
    const nestedT = i18next.getFixedT(nestedLanguage);
    const nestedTranslations = {
      builder: nestedT('builder', { returnObjects: true }),
      common: nestedT('common', { returnObjects: true }),
      journeys: nestedT('journeys', { returnObjects: true }),
      imagePicker: nestedT('imagePicker', { returnObjects: true }),
      resourcePicker: nestedT('resourcePicker', { returnObjects: true }),
      cropper: nestedT('cropper', { returnObjects: true })
    };
    
    res.json({
      success: true,
      nestedJourney: {
        id: nestedJourney.id,
        title: nestedJourney.title,
        description: nestedJourney.description,
        cover_image_url: nestedJourney.cover_image_url,
        settings: nestedSettings,
        language_override: nestedSettings.language_override,
        language_code: nestedSettings.language_code
      },
      steps: stripQuizAnswers(stepsResult.rows),
      paths: pathsResult.rows,
      resources: resourcesResult.rows,
      guides: guidesResult.rows,
      startStepId: startStep?.id,
      translations: nestedTranslations,
      language: nestedLanguage
    });
    
  } catch (err) {
    console.error('Enter nested journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to enter nested journey' });
  }
});

/**
 * POST /e/:token/exit-nested - Exit nested journey and return to parent
 * Restores parent journey state
 */
router.post('/e/:token/exit-nested', async (req, res) => {
  const { token } = req.params;
  
  try {
    // Get invitation with current progress
    const result = await query(`
      SELECT 
        i.id as invitation_id,
        i.organization_id,
        eup.nested_context
      FROM invitations i
      LEFT JOIN end_user_progress eup ON eup.invitation_id = i.id
      WHERE i.token = $1 AND i.status IN ('pending', 'active')
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invitation not found' });
    }
    
    const { invitation_id, organization_id, nested_context } = result.rows[0];
    
    // Verify we're in a nested journey
    if (!nested_context) {
      return res.status(400).json({ success: false, error: 'Not in a nested journey' });
    }
    
    const parentContext = typeof nested_context === 'string' 
      ? JSON.parse(nested_context) 
      : nested_context;
    
    // Load parent journey data
    const parentJourneyResult = await query(`
      SELECT j.id, j.title, j.description, j.cover_image_url, j.settings
      FROM journeys j
      WHERE j.id = $1
    `, [parentContext.parent_journey_id]);
    
    if (parentJourneyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Parent journey not found' });
    }
    
    const parentJourney = parentJourneyResult.rows[0];
    
    // Load parent journey steps, paths, resources
    const stepsResult = await query(
      `SELECT * FROM steps WHERE journey_id = $1 ORDER BY position_y, position_x`,
      [parentContext.parent_journey_id]
    );
    
    const pathsResult = await query(
      `SELECT * FROM paths WHERE journey_id = $1 ORDER BY sort_order`,
      [parentContext.parent_journey_id]
    );
    
    const resourcesResult = await query(
      `SELECT * FROM resources WHERE journey_id = $1`,
      [parentContext.parent_journey_id]
    );
    
    // Get guides
    const guidesResult = await query(
      `SELECT ${PLAYER_GUIDE_COLUMNS} FROM guides WHERE organization_id = $1 AND deleted_at IS NULL`,
      [organization_id]
    );
    
    // Find the next step after the nested journey step
    // Get outgoing paths from the nested journey step
    const exitPaths = pathsResult.rows.filter(p => p.from_step_id === parentContext.parent_step_id);
    
    // Add the nested journey step to visited steps
    const updatedVisitedSteps = [...(parentContext.parent_visited_steps || [])];
    if (!updatedVisitedSteps.includes(parentContext.parent_step_id)) {
      updatedVisitedSteps.push(parentContext.parent_step_id);
    }
    
    // Restore parent journey progress (stay at the nested step, let client navigate)
    await query(`
      UPDATE end_user_progress 
      SET nested_context = NULL,
          journey_id = $1,
          current_step_id = $2,
          visited_steps = $3,
          answers = $4
      WHERE invitation_id = $5
    `, [
      parentContext.parent_journey_id, 
      parentContext.parent_step_id,
      updatedVisitedSteps,
      JSON.stringify(parentContext.parent_answers || {}),
      invitation_id
    ]);
    
    // Parse parent journey settings for language
    const parentSettings = typeof parentJourney.settings === 'string' 
      ? JSON.parse(parentJourney.settings) 
      : (parentJourney.settings || {});
    
    // Get organization default language
    const orgResult = await query(`SELECT settings FROM organizations WHERE id = $1`, [organization_id]);
    const orgSettings = orgResult.rows[0]?.settings || {};
    const orgDefaultLanguage = orgSettings.default_language || 'en';
    
    // Determine the language for the parent journey
    const parentLanguage = parentSettings.language_override && parentSettings.language_code 
      ? parentSettings.language_code 
      : orgDefaultLanguage;
    
    // Get translations for the parent journey language
    const parentT = i18next.getFixedT(parentLanguage);
    const parentTranslations = {
      builder: parentT('builder', { returnObjects: true }),
      common: parentT('common', { returnObjects: true }),
      journeys: parentT('journeys', { returnObjects: true }),
      imagePicker: parentT('imagePicker', { returnObjects: true }),
      resourcePicker: parentT('resourcePicker', { returnObjects: true }),
      cropper: parentT('cropper', { returnObjects: true })
    };
    
    res.json({
      success: true,
      parentJourney: {
        id: parentJourney.id,
        title: parentJourney.title,
        description: parentJourney.description,
        cover_image_url: parentJourney.cover_image_url,
        settings: parentSettings,
        language_override: parentSettings.language_override,
        language_code: parentSettings.language_code
      },
      steps: stripQuizAnswers(stepsResult.rows),
      paths: pathsResult.rows,
      resources: resourcesResult.rows,
      guides: guidesResult.rows,
      currentStepId: parentContext.parent_step_id,
      visitedSteps: updatedVisitedSteps,
      answers: parentContext.parent_answers || {},
      exitPaths: exitPaths,
      translations: parentTranslations,
      language: parentLanguage
    });
    
  } catch (err) {
    console.error('Exit nested journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to exit nested journey' });
  }
});

/**
 * POST /e/:token/complete - Mark journey as complete
 */
router.post('/e/:token/complete', async (req, res) => {
  const { token } = req.params;
  
  try {
    // Verify token and get invitation
    const result = await query(
      `SELECT i.id, i.status, i.completions_count, i.max_completions
       FROM invitations i
       WHERE i.token = $1 AND i.status IN ('pending', 'active')`,
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invitation not found' });
    }
    
    const invitation = result.rows[0];
    const newCount = (invitation.completions_count || 0) + 1;
    
    // Check if this completes the invitation
    const isFullyComplete = invitation.max_completions && newCount >= invitation.max_completions;
    
    // Update invitation
    const newStatus = isFullyComplete ? 'completed' : 'active';
    if (isFullyComplete) {
      await query(
        `UPDATE invitations 
         SET completions_count = $1,
             status = $2,
             completed_at = NOW()
         WHERE id = $3`,
        [newCount, newStatus, invitation.id]
      );
    } else {
      await query(
        `UPDATE invitations 
         SET completions_count = $1,
             status = $2
         WHERE id = $3`,
        [newCount, newStatus, invitation.id]
      );
    }
    
    // Update progress
    await query(
      `UPDATE end_user_progress SET completed_at = NOW() WHERE invitation_id = $1`,
      [invitation.id]
    );
    
    res.json({ success: true, completions: newCount, isComplete: isFullyComplete });
    
  } catch (err) {
    console.error('Complete journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to complete journey' });
  }
});

/**
 * POST /e/:token/restart - Restart the journey from the beginning
 * Resets progress so user can go through the journey again
 */
router.post('/e/:token/restart', async (req, res) => {
  const { token } = req.params;
  
  try {
    // Verify token and get invitation with journey info
    const result = await query(`
      SELECT 
        i.id as invitation_id,
        i.status,
        i.journey_id,
        i.max_completions,
        i.completions_count,
        i.organization_id,
        j.title as journey_title,
        eup.id as progress_id
      FROM invitations i
      JOIN journeys j ON i.journey_id = j.id
      LEFT JOIN end_user_progress eup ON eup.invitation_id = i.id
      WHERE i.token = $1
      -- Revoked or expired invitations can never be reactivated by a restart
      AND i.status IN ('pending', 'active', 'completed')
      AND (i.expires_at IS NULL OR i.expires_at > NOW())
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invitation not found' });
    }
    
    const invitation = result.rows[0];
    
    // Check if more completions are allowed
    if (invitation.max_completions !== null && invitation.completions_count >= invitation.max_completions) {
      return res.status(400).json({ 
        success: false, 
        error: 'Maximum completions reached' 
      });
    }
    
    // Find the start step of the journey
    const startStepResult = await query(
      `SELECT id FROM steps WHERE journey_id = $1 AND is_start = true LIMIT 1`,
      [invitation.journey_id]
    );
    
    const startStepId = startStepResult.rows[0]?.id || null;
    
    // Reset progress: clear visited_steps, answers, current_step, and completed_at
    await query(`
      UPDATE end_user_progress 
      SET current_step_id = $1,
          visited_steps = '{}',
          answers = '{}',
          completed_at = NULL,
          nested_context = NULL
      WHERE invitation_id = $2
    `, [startStepId, invitation.invitation_id]);
    
    // Update invitation status back to active (in case it was completed)
    await query(`
      UPDATE invitations 
      SET status = 'active',
          completed_at = NULL
      WHERE id = $1
    `, [invitation.invitation_id]);
    
    console.log(`[Restart] Journey restarted for invitation ${invitation.invitation_id}`);
    
    res.json({ 
      success: true, 
      message: 'Journey restarted',
      startStepId: startStepId
    });
    
  } catch (err) {
    console.error('Restart journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to restart journey' });
  }
});

/**
 * POST /e/:token/restart-and-continue - Restart journey and redirect to start
 * Used from the welcome-back screen to restart and continue in one step
 */
router.post('/e/:token/restart-and-continue', async (req, res) => {
  const { token } = req.params;
  
  try {
    // Verify token and get invitation with journey info
    const result = await query(`
      SELECT 
        i.id as invitation_id,
        i.status,
        i.journey_id,
        i.max_completions,
        i.completions_count,
        i.organization_id
      FROM invitations i
      WHERE i.token = $1
      -- Revoked or expired invitations can never be reactivated by a restart
      AND i.status IN ('pending', 'active', 'completed')
      AND (i.expires_at IS NULL OR i.expires_at > NOW())
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.redirect(`/e/${token}`);
    }
    
    const invitation = result.rows[0];
    
    // Check if more completions are allowed
    if (invitation.max_completions !== null && invitation.completions_count >= invitation.max_completions) {
      return res.redirect(`/e/${token}`);
    }
    
    // Find the start step of the journey
    const startStepResult = await query(
      `SELECT id FROM steps WHERE journey_id = $1 AND is_start = true LIMIT 1`,
      [invitation.journey_id]
    );
    
    const startStepId = startStepResult.rows[0]?.id || null;
    
    // Reset progress
    await query(`
      UPDATE end_user_progress 
      SET current_step_id = $1,
          visited_steps = '{}',
          answers = '{}',
          completed_at = NULL,
          nested_context = NULL
      WHERE invitation_id = $2
    `, [startStepId, invitation.invitation_id]);
    
    // Update invitation status back to active
    await query(`
      UPDATE invitations 
      SET status = 'active',
          completed_at = NULL
      WHERE id = $1
    `, [invitation.invitation_id]);
    
    console.log(`[Restart] Journey restarted (via welcome-back) for invitation ${invitation.invitation_id}`);
    
    // Redirect to the expedition
    res.redirect(`/e/${token}`);
    
  } catch (err) {
    console.error('Restart and continue error:', err);
    res.redirect(`/e/${token}`);
  }
});

/**
 * POST /e/:token/chat/guide - Chat with guide in player mode
 * This endpoint allows end-users (via magic link) to chat with AI guides
 * Security: Token is validated before allowing chat
 */
router.post('/e/:token/chat/guide', playerAiLimiter, async (req, res) => {
  const { token } = req.params;
  const { guide_id, journey_id: _journey_id, step_context, message, conversation_history, guide_language } = req.body;
  
  try {
    // Validate the magic link token
    const invResult = await query(`
      SELECT 
        i.id, i.status, i.expires_at, i.organization_id,
        j.id as journey_id
      FROM invitations i
      JOIN journeys j ON i.journey_id = j.id
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    
    // Check if invitation is valid
    // Allow both 'active' and 'completed' status for guide chat
    const validStatuses = ['active', 'completed'];
    if (!validStatuses.includes(invitation.status) || new Date(invitation.expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: 'Token expired or revoked' });
    }
    
    const orgId = invitation.organization_id;
    
    // Out of AI questions: the player shows a calm message (or the static greeting)
    // and lets the end user continue
    if (!(await hasAiCreditsLeft(orgId, 'player'))) {
      return res.status(403).json({ success: false, code: 'AI_UNAVAILABLE' });
    }
    
    if (!guide_id || !message) {
      return res.status(400).json({ success: false, error: 'Guide ID and message are required' });
    }
    
    // Get guide info (must belong to same organization)
    const guideResult = await query(
      'SELECT * FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [guide_id, orgId]
    );
    
    if (guideResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }

    // Only guides used in this journey (or its nested journeys) can be asked
    if (!(await isGuideUsedInJourney(guide_id, invitation.journey_id))) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    const dbGuide = guideResult.rows[0];
    
    // Knowledge retrieval happens inside chatWithGuide (with similarity threshold)
    
    // Build guide object compatible with chatWithGuide function
    const guideObj = {
      name: dbGuide.name,
      role: dbGuide.role || 'Your Assistant',
      personality: dbGuide.personality || 'friendly',
      instructions: dbGuide.ai_instructions || '',
      topics: [],
      stepId: null,
      guideId: guide_id,
      organizationId: orgId,
      language: guide_language || 'en'
    };
    
    // Build conversation history array
    let historyArray = [];
    if (conversation_history) {
      if (Array.isArray(conversation_history)) {
        historyArray = conversation_history.map(msg => ({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content || ''
        }));
      } else if (typeof conversation_history === 'string') {
        const lines = conversation_history.split('\n').filter(l => l.trim());
        lines.forEach(line => {
          if (line.startsWith('User:')) {
            historyArray.push({ role: 'user', content: line.replace('User:', '').trim() });
          } else if (line.includes(':')) {
            historyArray.push({ role: 'assistant', content: line.split(':').slice(1).join(':').trim() });
          }
        });
      }
    }
    
    // Build journey context with media descriptions
    let journeyContext = step_context || '';
    
    // Enrich context with AI-generated descriptions of visual content
    const mediaDescriptions = await enrichContextWithMediaDescriptions(step_context);
    if (mediaDescriptions) {
      journeyContext += mediaDescriptions;
    }
    
    // Call the AI chat function
    const aiResult = await chatWithGuide(guideObj, message, historyArray, journeyContext);
    
    // Track AI credits if usage data is available
    if (aiResult.usage) {
      // 1 AI credit = 1 answered question
      await trackAiCredits(orgId, 1, {
        model: aiResult.usage.model,
        tokensInput: aiResult.usage.promptTokens,
        tokensOutput: aiResult.usage.completionTokens,
        guideId: guide_id,
        invitationToken: token,
        context: 'end_user_journey'
      });
    }
    
    // Parse citations from response
    const citations = parseCitations(aiResult.response);
    const citationIds = [...new Set(citations.map(c => c.id))];
    
    // Get source information for citations
    let citationSources = [];
    if (citationIds.length > 0) {
      citationSources = await getCitationSources(citationIds, orgId);
    }
    
    res.json({ 
      success: true, 
      response: aiResult.response,
      citations: citations,
      citationSources: citationSources
    });
    
  } catch (err) {
    console.error('Player chat error:', err);
    res.status(500).json({ success: false, error: 'Failed to process chat: ' + err.message });
  }
});

/**
 * POST /e/:token/guide/opening - Generate dynamic guide opening in specified language
 * This endpoint generates a localized greeting for the AI Guide
 * Security: Token is validated before generating
 */
router.post('/e/:token/guide/opening', playerAiLimiter, async (req, res) => {
  const { token } = req.params;
  const { guide_id, guide_language, journey_context } = req.body;
  
  try {
    // Validate the magic link token
    const invResult = await query(`
      SELECT 
        i.id, i.status, i.expires_at, i.organization_id,
        j.id as journey_id, j.title as journey_title
      FROM invitations i
      JOIN journeys j ON i.journey_id = j.id
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    const validStatuses = ['active', 'completed'];
    if (!validStatuses.includes(invitation.status) || new Date(invitation.expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: 'Token expired or revoked' });
    }
    
    const orgId = invitation.organization_id;
    
    // Out of AI questions: the player shows a calm message (or the static greeting)
    // and lets the end user continue
    if (!(await hasAiCreditsLeft(orgId, 'player'))) {
      return res.status(403).json({ success: false, code: 'AI_UNAVAILABLE' });
    }
    
    if (!guide_id) {
      return res.status(400).json({ success: false, error: 'Guide ID is required' });
    }
    
    // Get guide info
    const guideResult = await query(
      'SELECT * FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [guide_id, orgId]
    );
    
    if (guideResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }

    // Only guides used in this journey (or its nested journeys) can be asked
    if (!(await isGuideUsedInJourney(guide_id, invitation.journey_id))) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    const dbGuide = guideResult.rows[0];
    
    // Import generateGuideOpening dynamically (already imported at top)
    const { generateGuideOpening } = await import('../services/mistral.js');
    
    // Build guide context with language override
    const guideContext = {
      name: dbGuide.name,
      role: dbGuide.role || 'Your Assistant',
      personality: dbGuide.personality || 'friendly',
      greeting: dbGuide.greeting || '',
      instructions: dbGuide.ai_instructions || '',
      language: guide_language || 'en'
    };
    
    // Generate AI opening and translate role in parallel for better performance
    const shouldTranslateRole = guide_language && guide_language !== 'en' && guideContext.role;
    
    let roleTranslationPromise;
    if (shouldTranslateRole) {
      const { translateText } = await import('../services/translation.js');
      roleTranslationPromise = translateText(guideContext.role, guide_language).catch(err => {
        console.warn('Failed to translate guide role:', err.message);
        return guideContext.role;
      });
    }
    
    // Generate opening in specified language
    const aiResult = await generateGuideOpening(guideContext, journey_context || '');
    
    // Wait for role translation (if started)
    const translatedRole = shouldTranslateRole 
      ? await roleTranslationPromise 
      : guideContext.role;
    
    res.json({ 
      success: true, 
      opening: aiResult.response,
      language: guide_language || 'en',
      guide: {
        name: guideContext.name,
        role: translatedRole,
        originalRole: guideContext.role
      }
    });
    
  } catch (err) {
    console.error('Guide opening generation error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate opening' });
  }
});

/**
 * POST /e/:token/automations/trigger - Trigger automation emails in player mode
 * This endpoint allows end-users (via magic link) to trigger email automations
 * Security: Token is validated before processing automations
 */
router.post('/e/:token/automations/trigger', async (req, res) => {
  const { token } = req.params;
  const { trigger, step_id, path_id } = req.body;
  
  try {
    // Validate the magic link token and get invitation details
    const invResult = await query(`
      SELECT 
        i.id, i.status, i.expires_at, i.organization_id, i.journey_id,
        eu.id as end_user_id, eu.email as end_user_email, 
        eu.first_name as end_user_first_name, eu.last_name as end_user_last_name,
        j.id as journey_id, j.title as journey_title, j.settings as journey_settings,
        o.id as org_id, o.name as org_name
      FROM invitations i
      JOIN end_users eu ON i.end_user_id = eu.id
      JOIN journeys j ON i.journey_id = j.id
      JOIN organizations o ON i.organization_id = o.id
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    
    // Check if invitation is valid
    // Allow both 'active' and 'completed' status for automations
    const validStatuses = ['active', 'completed'];
    if (!validStatuses.includes(invitation.status) || new Date(invitation.expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: 'Token expired or revoked' });
    }
    
    if (!trigger) {
      return res.status(400).json({ 
        success: false, 
        error: 'Trigger type is required' 
      });
    }
    
    const journeyId = invitation.journey_id;
    const orgId = invitation.organization_id;
    
    // Parse journey settings to get automations
    const journeySettings = typeof invitation.journey_settings === 'string' 
      ? JSON.parse(invitation.journey_settings) 
      : (invitation.journey_settings || {});
    const journeyAutomations = journeySettings.automations || [];
    
    // Get step with automations if step_id provided
    let step = null;
    let stepAutomations = [];
    if (step_id) {
      const stepResult = await query('SELECT * FROM steps WHERE id = $1 AND journey_id = $2', [step_id, journeyId]);
      if (stepResult.rows.length > 0) {
        step = stepResult.rows[0];
        const stepAdvancedProps = typeof step.advanced_props === 'string'
          ? JSON.parse(step.advanced_props)
          : (step.advanced_props || {});
        stepAutomations = stepAdvancedProps.automations || [];
        console.log(`[Player Automation] Step ${step_id} (${step.title}) has ${stepAutomations.length} automations`);
      }
    }
    
    // Build user object from end_user data
    const user = {
      id: invitation.end_user_id,
      email: invitation.end_user_email,
      first_name: invitation.end_user_first_name,
      last_name: invitation.end_user_last_name
    };
    
    // Build journey object
    const journey = {
      id: journeyId,
      title: invitation.journey_title
    };
    
    // Build organization object
    const organization = {
      id: orgId,
      name: invitation.org_name
    };
    
    // Build context for automations
    const context = { user, journey, step, organization };
    
    // Determine which automations to process
    const automationsToProcess = [];
    
    // Journey-level automations
    if (trigger === 'on_journey_start' || trigger === 'on_journey_complete' || trigger === 'on_inactivity') {
      automationsToProcess.push(...journeyAutomations.filter(a => a.trigger === trigger));
    }
    
    // Step-level automations
    if (trigger === 'on_step_enter' || trigger === 'on_step_complete' || trigger.startsWith('on_path:')) {
      automationsToProcess.push(...stepAutomations.filter(a => {
        if (a.trigger === trigger) return true;
        if (path_id && a.trigger === `on_path:${path_id}`) return true;
        return false;
      }));
    }
    
    if (automationsToProcess.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No automations matched this trigger',
        triggered: 0 
      });
    }
    
    console.log(`[Player Automation] Processing ${automationsToProcess.length} automation(s) for trigger: ${trigger}`);
    
    // Process automations
    const results = [];
    for (const automation of automationsToProcess) {
      const result = await sendAutomationEmail(automation, context);
      results.push({ trigger: automation.trigger, template: automation.template, ...result });
    }
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    console.log(`[Player Automation] Triggered ${successCount} email(s), ${failCount} failed`);
    
    res.json({
      success: true,
      message: `Processed ${automationsToProcess.length} automation(s)`,
      triggered: successCount,
      failed: failCount,
      results
    });
    
  } catch (err) {
    console.error('Player automation trigger error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Could not process automations: ' + err.message 
    });
  }
});

/**
 * POST /e/:token/analytics/event - Log analytics event for journey tracking
 * Captures user interactions for detailed analytics and reporting
 * 
 * Supports both private journeys (with end_user data) and public journeys (anonymous)
 * 
 * Event types:
 * - Journey: journey_started, journey_completed, journey_abandoned, session_resumed
 * - Steps: step_entered, step_completed, step_skipped, step_idle
 * - Nested: nested_journey_entered, nested_journey_completed
 * - Quiz: quiz_attempt_started, quiz_question_answered, quiz_attempt_completed
 * - Poll: poll_voted
 * - Form: form_started, form_field_completed, form_completed
 * - Video: video_started, video_paused, video_completed, video_skipped
 * - Content: content_scroll_milestone, external_link_clicked
 * - Navigation: path_chosen
 * - Engagement: tab_focus_lost, tab_focus_regained
 * - Resources: resource_collected
 * - Guide: guide_chat_message
 */
router.post('/e/:token/analytics/event', async (req, res) => {
  const { token } = req.params;
  const { 
    event_type, 
    step_id, 
    journey_id,
    parent_journey_id,
    duration_ms,
    event_data,
    session_id,
    device_info
  } = req.body;
  
  try {
    // Validate the magic link token
    const invResult = await query(`
      SELECT i.id, i.organization_id, i.journey_id, i.end_user_id, i.status
      FROM invitations i
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    
    // Allow logging for active and completed journeys
    if (!['pending', 'active', 'completed'].includes(invitation.status)) {
      return res.status(401).json({ success: false, error: 'Invalid invitation status' });
    }
    
    if (!event_type) {
      return res.status(400).json({ success: false, error: 'Event type is required' });
    }
    
    // Valid event types (comprehensive list)
    const validEventTypes = [
      // Journey lifecycle
      'journey_started', 'journey_completed', 'journey_abandoned', 'session_resumed',
      // Step navigation
      'step_entered', 'step_completed', 'step_skipped', 'step_idle',
      // Nested journeys
      'nested_journey_entered', 'nested_journey_completed',
      // Quiz interactions
      'quiz_attempt_started', 'quiz_question_answered', 'quiz_attempt_completed',
      // Poll interactions
      'poll_voted',
      // Form interactions
      'form_started', 'form_field_completed', 'form_completed',
      // Video interactions
      'video_started', 'video_paused', 'video_completed', 'video_skipped',
      // Content engagement
      'content_scroll_milestone', 'external_link_clicked',
      // Navigation choices
      'path_chosen',
      // Tab/focus tracking
      'tab_focus_lost', 'tab_focus_regained',
      // Resources
      'resource_collected',
      // Guide chat
      'guide_chat_message'
    ];
    
    if (!validEventTypes.includes(event_type)) {
      return res.status(400).json({ success: false, error: 'Invalid event type' });
    }
    
    // Insert the event
    await query(`
      INSERT INTO journey_events (
        organization_id, invitation_id, end_user_id,
        journey_id, parent_journey_id, step_id,
        event_type, event_data, duration_ms,
        session_id, device_type, browser, os, screen_width, screen_height
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      invitation.organization_id,
      invitation.id,
      invitation.end_user_id,
      journey_id || invitation.journey_id,
      parent_journey_id || null,
      step_id || null,
      event_type,
      JSON.stringify(event_data || {}),
      duration_ms || null,
      session_id || null,
      device_info?.device_type || null,
      device_info?.browser || null,
      device_info?.os || null,
      device_info?.screen_width || null,
      device_info?.screen_height || null
    ]);
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('Analytics event error:', err);
    res.status(500).json({ success: false, error: 'Failed to log event' });
  }
});

/**
 * POST /e/:token/analytics/quiz-attempt - Record a quiz attempt with detailed results
 * Stores comprehensive quiz performance data for analytics
 */
router.post('/e/:token/analytics/quiz-attempt', async (req, res) => {
  const { token } = req.params;
  const { 
    step_id,
    journey_id,
    attempt_number,
    attempt_key,
    duration_ms,
    session_id,
    device_info
  } = req.body;
  
  try {
    const invResult = await query(`
      SELECT i.id, i.organization_id, i.journey_id, i.end_user_id
      FROM invitations i
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];

    // Score and pass/fail are computed here from the answers checked during
    // the attempt; values sent by the browser are not trusted.
    const step = await getChallengeStep(step_id, invitation.journey_id);
    if (!step || !UUID_PATTERN.test(String(attempt_key))) {
      return res.status(400).json({ success: false, error: 'Invalid quiz attempt' });
    }
    const { totalQuestions: total_questions, correctCount: correct_count, passed, questionResults: question_results } =
      scoreQuizAttempt(req, step, attempt_key);
    const scorePercentage = total_questions > 0 ? Math.round((correct_count / total_questions) * 100) : 0;
    
    await query(`
      INSERT INTO quiz_attempts (
        organization_id, journey_id, step_id,
        invitation_id, end_user_id, session_id,
        attempt_number, total_questions, correct_count, score_percentage, passed,
        duration_ms, question_results, device_type, browser, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
    `, [
      invitation.organization_id,
      journey_id || invitation.journey_id,
      step_id,
      invitation.id,
      invitation.end_user_id, // Can be null for public journeys
      session_id,
      attempt_number || 1,
      total_questions,
      correct_count,
      scorePercentage,
      passed,
      duration_ms,
      JSON.stringify(question_results),
      device_info?.device_type,
      device_info?.browser
    ]);
    
    res.json({ success: true, correct_count, total_questions, passed });
    
  } catch (err) {
    console.error('Quiz attempt error:', err);
    res.status(500).json({ success: false, error: 'Failed to save quiz attempt' });
  }
});

/**
 * POST /e/:token/quiz/check - Is this quiz answer correct? (magic link player)
 */
router.post('/e/:token/quiz/check', async (req, res) => {
  try {
    const inv = await query(
      `SELECT journey_id FROM invitations WHERE token = $1 AND status IN ('pending', 'active', 'completed')`,
      [req.params.token]
    );
    if (inv.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    return await handleQuizCheck(req, res, inv.rows[0].journey_id);
  } catch (err) {
    console.error('Quiz check error:', err);
    res.status(500).json({ success: false, error: 'Failed to check answer' });
  }
});

/**
 * POST /p/:token/quiz/check - Is this quiz answer correct? (public journey)
 */
router.post('/p/:token/quiz/check', async (req, res) => {
  try {
    const journey = await query(
      `SELECT id FROM journeys WHERE public_token = $1 AND is_public = true AND status = 'published' AND deleted_at IS NULL`,
      [req.params.token]
    );
    if (journey.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    return await handleQuizCheck(req, res, journey.rows[0].id);
  } catch (err) {
    console.error('Quiz check error:', err);
    res.status(500).json({ success: false, error: 'Failed to check answer' });
  }
});

/**
 * POST /e/:token/analytics/video-session - Record video watch session
 * Tracks video engagement metrics
 */
router.post('/e/:token/analytics/video-session', async (req, res) => {
  const { token } = req.params;
  const { 
    step_id,
    journey_id,
    video_url,
    video_duration_sec,
    watch_time_sec,
    max_position_sec,
    watch_percentage,
    completed,
    pause_count,
    seek_count,
    session_id
  } = req.body;
  
  try {
    const invResult = await query(`
      SELECT i.id, i.organization_id, i.journey_id, i.end_user_id
      FROM invitations i
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    
    await query(`
      INSERT INTO video_watch_sessions (
        organization_id, journey_id, step_id,
        invitation_id, end_user_id, session_id,
        video_url, video_duration_sec, watch_time_sec, max_position_sec,
        watch_percentage, completed, pause_count, seek_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [
      invitation.organization_id,
      journey_id || invitation.journey_id,
      step_id,
      invitation.id,
      invitation.end_user_id,
      session_id,
      video_url,
      video_duration_sec,
      watch_time_sec || 0,
      max_position_sec || 0,
      watch_percentage || 0,
      completed || false,
      pause_count || 0,
      seek_count || 0
    ]);
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('Video session error:', err);
    res.status(500).json({ success: false, error: 'Failed to save video session' });
  }
});

/**
 * POST /e/:token/analytics/form-completion - Record form completion analytics
 * Tracks form engagement without storing actual form data
 */
router.post('/e/:token/analytics/form-completion', async (req, res) => {
  const { token } = req.params;
  const { 
    step_id,
    journey_id,
    total_fields,
    filled_fields,
    duration_ms,
    field_timings,
    session_id
  } = req.body;
  
  try {
    const invResult = await query(`
      SELECT i.id, i.organization_id, i.journey_id, i.end_user_id
      FROM invitations i
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    const completionPercentage = total_fields > 0 ? Math.round((filled_fields / total_fields) * 100) : 0;
    
    await query(`
      INSERT INTO form_analytics (
        organization_id, journey_id, step_id,
        invitation_id, end_user_id, session_id,
        total_fields, filled_fields, completion_percentage,
        duration_ms, field_timings
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      invitation.organization_id,
      journey_id || invitation.journey_id,
      step_id,
      invitation.id,
      invitation.end_user_id,
      session_id,
      total_fields,
      filled_fields,
      completionPercentage,
      duration_ms,
      JSON.stringify(field_timings || [])
    ]);
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('Form analytics error:', err);
    res.status(500).json({ success: false, error: 'Failed to save form analytics' });
  }
});

/**
 * POST /e/:token/analytics/guide-chat - Record guide chat interaction
 * Tracks AI Guide usage for support analytics
 */
router.post('/e/:token/analytics/guide-chat', async (req, res) => {
  const { token } = req.params;
  const { 
    action, // 'session_start', 'message_sent', 'session_end'
    guide_id,
    step_id,
    journey_id,
    chat_session_id,
    message_role, // 'user' or 'guide'
    session_id // Client session ID
  } = req.body;
  // Note: the client also sends message_preview, message_length,
  // response_time_ms, had_citations and citation_count. These are
  // deliberately not stored - only aggregate counts are tracked per session.
  
  try {
    const invResult = await query(`
      SELECT i.id, i.organization_id, i.journey_id, i.end_user_id
      FROM invitations i
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    
    if (action === 'session_start') {
      // Create a new guide chat session
      const result = await query(`
        INSERT INTO guide_chat_sessions (
          organization_id, journey_id, guide_id,
          invitation_id, end_user_id, session_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        invitation.organization_id,
        journey_id || invitation.journey_id,
        guide_id,
        invitation.id,
        invitation.end_user_id,
        session_id
      ]);
      
      return res.json({ success: true, chat_session_id: result.rows[0].id });
      
    } else if (action === 'message_sent' && chat_session_id) {
      // Only update session counters - don't store individual messages
      const updateField = message_role === 'user' ? 'user_message_count' : 'guide_response_count';
      await query(`
        UPDATE guide_chat_sessions 
        SET 
          message_count = message_count + 1,
          ${updateField} = ${updateField} + 1,
          last_message_at = NOW()
        WHERE id = $1
      `, [chat_session_id]);
      
      // If user message, track which step it came from (without message content)
      if (message_role === 'user' && step_id) {
        const stepResult = await query(`
          SELECT title, type FROM steps WHERE id = $1
        `, [step_id]);
        
        if (stepResult.rows.length > 0) {
          const stepInfo = stepResult.rows[0];
          
          // Update steps_used array (only step metadata, no message content)
          await query(`
            UPDATE guide_chat_sessions 
            SET steps_used = (
              SELECT jsonb_agg(DISTINCT elem)
              FROM (
                SELECT jsonb_array_elements(steps_used) AS elem
                UNION ALL
                SELECT $2::jsonb
              ) sub
            )
            WHERE id = $1
          `, [
            chat_session_id,
            JSON.stringify({ step_id, step_title: stepInfo.title, step_type: stepInfo.type })
          ]);
        }
      }
      
      return res.json({ success: true });
      
    } else if (action === 'session_end' && chat_session_id) {
      // Calculate total duration and finalize session
      await query(`
        UPDATE guide_chat_sessions 
        SET total_duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
        WHERE id = $1
      `, [chat_session_id]);
      
      return res.json({ success: true });
    }
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('Guide chat analytics error:', err);
    res.status(500).json({ success: false, error: 'Failed to save guide chat analytics' });
  }
});

/**
 * GET /e/:token/forms/submission-status/:stepId - Check if form was already submitted
 * This allows users to skip forms they've already completed on repeat visits
 */
router.get('/e/:token/forms/submission-status/:stepId', async (req, res) => {
  const { token, stepId } = req.params;
  
  try {
    // Validate the magic link token
    const invResult = await query(`
      SELECT i.id, i.end_user_id, i.journey_id, i.status, i.expires_at
      FROM invitations i
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    
    // Check if invitation is valid
    const validStatuses = ['active', 'completed'];
    if (!validStatuses.includes(invitation.status) || new Date(invitation.expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: 'Token expired or revoked' });
    }
    
    // Check for previous submissions for this step by this user in this journey.
    // A stored submission counts, regardless of whether the notification email
    // could be delivered (the submission itself is the source of truth).
    const submissionResult = await query(`
      SELECT created_at 
      FROM private_form_submissions 
      WHERE end_user_id = $1 
        AND journey_id = $2 
        AND step_id = $3
      ORDER BY created_at DESC
      LIMIT 1
    `, [invitation.end_user_id, invitation.journey_id, stepId]);
    
    if (submissionResult.rows.length > 0) {
      res.json({
        success: true,
        hasSubmitted: true,
        submittedAt: submissionResult.rows[0].created_at
      });
    } else {
      res.json({
        success: true,
        hasSubmitted: false,
        submittedAt: null
      });
    }
    
  } catch (err) {
    console.error('Form submission status check error:', err);
    res.status(500).json({ success: false, error: 'Failed to check submission status' });
  }
});

/**
 * POST /e/:token/forms/submit - Submit form in player mode
 * This endpoint allows end-users (via magic link) to submit forms
 * Security: Token is validated before processing form submission
 */
router.post('/e/:token/forms/submit', async (req, res) => {
  const { token } = req.params;
  // NOTE: recipient_email / step_title are intentionally NOT taken from the
  // request body. They are resolved server-side from the step configuration
  // below, so a magic-link holder cannot use this endpoint as an open mail
  // relay to send mail to arbitrary recipients.
  const { step_id, email_subject, responses, attachments } = req.body;

  try {
    // Validate the magic link token
    const invResult = await query(`
      SELECT 
        i.id, i.status, i.expires_at, i.organization_id, i.end_user_id,
        eu.first_name as end_user_first_name, eu.last_name as end_user_last_name, eu.email as end_user_email,
        j.id as journey_id, j.title as journey_title,
        o.name as org_name, o.settings->>'default_language' as org_language
      FROM invitations i
      JOIN end_users eu ON i.end_user_id = eu.id
      JOIN journeys j ON i.journey_id = j.id
      JOIN organizations o ON i.organization_id = o.id
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    
    // Check if invitation is valid
    // Allow both 'active' and 'completed' status for form submissions
    const validStatuses = ['active', 'completed'];
    if (!validStatuses.includes(invitation.status) || new Date(invitation.expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: 'Token expired or revoked' });
    }
    
    const orgId = invitation.organization_id;
    const orgLanguage = invitation.org_language || 'en';
    
    if (!responses || Object.keys(responses).length === 0) {
      return res.status(400).json({ success: false, error: 'No form responses provided' });
    }
    
    // Resolve the step server-side, scoped to this invitation's journey. This
    // both prevents cross-journey access and lets us read the trusted
    // recipient/title from the step configuration instead of the request body.
    const stepResult = await query(
      'SELECT id, title, basic_props FROM steps WHERE id = $1 AND journey_id = $2',
      [step_id, invitation.journey_id]
    );
    if (stepResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Step not found' });
    }
    const step = stepResult.rows[0];
    const stepBasicProps = step.basic_props || {};
    
    // Recipient comes ONLY from the maker-configured step settings.
    const recipient_email = stepBasicProps.recipient_email;
    const step_title = step.title || stepBasicProps.title || 'Form';
    
    if (!recipient_email) {
      return res.status(400).json({ success: false, error: 'No recipient email configured' });
    }
    
    const journeyTitle = invitation.journey_title || 'Unknown Journey';
    const companyName = invitation.org_name || 'Gryffi';
    const endUserName = `${invitation.end_user_first_name || ''} ${invitation.end_user_last_name || ''}`.trim() || 'End User';
    const endUserEmail = invitation.end_user_email || '';
    
    // Validate and decode uploaded files (Base64 data URLs)
    let files;
    try {
      files = processAttachments(attachments);
    } catch (attachErr) {
      return res.status(400).json({ success: false, error: attachErr.message });
    }

    // Images are checked for NSFW content before anything is stored
    const imageCheck = await checkAttachmentImages(files);
    if (!imageCheck.allowed) {
      const nsfw = imageCheck.reason === 'nsfw';
      return res.status(nsfw ? 400 : 503).json({
        success: false,
        error: nsfw ? 'This image cannot be uploaded.' : 'The image could not be checked. Try again in a few minutes.',
        code: nsfw ? 'NSFW_CONTENT' : 'IMAGE_CHECK_UNAVAILABLE'
      });
    }
    
    // Save the submission FIRST — it is the source of truth and stays
    // available in Analytics even if the notification email fails.
    const submissionResult = await query(`
      INSERT INTO private_form_submissions 
        (invitation_id, end_user_id, journey_id, step_id, organization_id,
         responses, journey_title, step_title, email_sent)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
      RETURNING id
    `, [
      invitation.id,
      invitation.end_user_id,
      invitation.journey_id,
      step_id,
      orgId,
      JSON.stringify(responses),
      journeyTitle,
      step_title
    ]);
    const submissionId = submissionResult.rows[0].id;
    
    // Store uploaded files on disk with secure, expiring download tokens.
    // Files are NOT emailed as attachments: the recipient gets download links.
    const storedFiles = await storeSubmissionFiles({
      orgId,
      journeyId: invitation.journey_id,
      stepId: step_id,
      privateSubmissionId: submissionId,
      files
    });
    
    // Build and send the notification email (org language, themed)
    const emailBody = buildFormSubmissionEmailBody({
      language: orgLanguage,
      journeyTitle,
      formTitle: step_title,
      submitterName: endUserName,
      submitterEmail: endUserEmail,
      companyName,
      responses,
      fields: stepBasicProps.fields,
      files: storedFiles
    });
    const subject = email_subject || buildFormSubmissionSubject(orgLanguage, journeyTitle);
    
    let emailStatus = 'sent';
    let emailProviderId = null;
    let emailError = null;
    try {
      const result = await sendJourneyEmail({
        to: recipient_email,
        userName: '',
        subject,
        body: emailBody,
        templateType: 'journey_info',
        journeyTitle,
        stepTitle: step_title,
        companyName,
        isHtmlBody: true,
        language: orgLanguage,
        orgId: orgId // For custom theme support
      });
      emailProviderId = result.emailId || null;
      
      await query(`
        UPDATE private_form_submissions SET email_sent = true, email_sent_at = NOW() WHERE id = $1
      `, [submissionId]);
    } catch (emailErr) {
      emailStatus = 'failed';
      emailError = emailErr.message;
      console.error('[Player Form] Failed to send notification email:', emailErr);
    }
    
    // Log the email attempt (sent or failed) for debugging/audit
    await query(`
      INSERT INTO email_logs 
        (organization_id, journey_id, step_id, to_email, subject, template_type, email_provider_id, status, error_message, variables)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      orgId,
      invitation.journey_id,
      step_id,
      recipient_email,
      subject,
      'form_submission',
      emailProviderId,
      emailStatus,
      emailError,
      JSON.stringify({ responses, submitter: { name: endUserName, email: endUserEmail }, files: storedFiles.map(f => f.original_name) })
    ]);
    
    console.log(`[Player Form] Form submitted for journey ${journeyTitle} by ${endUserName} (email: ${emailStatus})`);
    res.json({ success: true, message: 'Form submitted successfully' });
    
  } catch (err) {
    console.error('Player form submission error:', err);
    res.status(500).json({ success: false, error: 'Failed to submit form: ' + err.message });
  }
});

// ============================================
// REWARDS SYSTEM
// ============================================

/**
 * POST /e/:token/rewards/claim - Claim a reward in player mode
 * This endpoint allows end-users (via magic link) to claim rewards
 * Security: Token is validated before processing reward claim
 */
router.post('/e/:token/rewards/claim', async (req, res) => {
  const { token } = req.params;
  const { step_id } = req.body;
  
  // NOTE: We also allow 'completed' status for reward claims because:
  // 1. There's a race condition where journey completes before reward claim finishes
  // 2. Users who completed a journey should still be able to claim their reward
  // 3. This is especially important for page refreshes after journey completion
  
  // Reward email translations
  const rewardEmailTranslations = {
    en: {
      subject: 'Your reward from {{journeyTitle}}',
      congratulations: 'Congratulations!',
      youReceivedReward: 'You received a reward for completing the journey',
      yourCode: 'Your reward code',
      redeemAt: 'Redeem at',
      validUntil: 'Valid until',
      terms: 'Terms & Conditions',
      thankYou: 'Thank you for participating!'
    },
    nl: {
      subject: 'Jouw beloning van {{journeyTitle}}',
      congratulations: 'Gefeliciteerd!',
      youReceivedReward: 'Je hebt een beloning ontvangen voor het voltooien van de expeditie',
      yourCode: 'Jouw beloningscode',
      redeemAt: 'In te wisselen bij',
      validUntil: 'Geldig tot',
      terms: 'Voorwaarden',
      thankYou: 'Bedankt voor je deelname!'
    },
    de: {
      subject: 'Ihre Belohnung von {{journeyTitle}}',
      congratulations: 'Herzlichen Glückwunsch!',
      youReceivedReward: 'Sie haben eine Belohnung für das Abschließen der Expedition erhalten',
      yourCode: 'Ihr Belohnungscode',
      redeemAt: 'Einzulösen bei',
      validUntil: 'Gültig bis',
      terms: 'Bedingungen',
      thankYou: 'Vielen Dank für Ihre Teilnahme!'
    },
    fr: {
      subject: 'Votre récompense de {{journeyTitle}}',
      congratulations: 'Félicitations !',
      youReceivedReward: 'Vous avez reçu une récompense pour avoir terminé le parcours',
      yourCode: 'Votre code de récompense',
      redeemAt: 'À échanger chez',
      validUntil: 'Valable jusqu\'au',
      terms: 'Conditions',
      thankYou: 'Merci pour votre participation !'
    },
    es: {
      subject: 'Tu recompensa de {{journeyTitle}}',
      congratulations: '¡Felicitaciones!',
      youReceivedReward: 'Has recibido una recompensa por completar la expedición',
      yourCode: 'Tu código de recompensa',
      redeemAt: 'Canjear en',
      validUntil: 'Válido hasta',
      terms: 'Condiciones',
      thankYou: '¡Gracias por participar!'
    },
    it: {
      subject: 'La tua ricompensa da {{journeyTitle}}',
      congratulations: 'Congratulazioni!',
      youReceivedReward: 'Hai ricevuto una ricompensa per aver completato il percorso',
      yourCode: 'Il tuo codice ricompensa',
      redeemAt: 'Da riscattare presso',
      validUntil: 'Valido fino al',
      terms: 'Termini e condizioni',
      thankYou: 'Grazie per aver partecipato!'
    },
    pt: {
      subject: 'Sua recompensa de {{journeyTitle}}',
      congratulations: 'Parabéns!',
      youReceivedReward: 'Você recebeu uma recompensa por concluir a jornada',
      yourCode: 'Seu código de recompensa',
      redeemAt: 'Resgatar em',
      validUntil: 'Válido até',
      terms: 'Termos e condições',
      thankYou: 'Obrigado por participar!'
    },
    da: {
      subject: 'Din belønning fra {{journeyTitle}}',
      congratulations: 'Tillykke!',
      youReceivedReward: 'Du har modtaget en belønning for at fuldføre rejsen',
      yourCode: 'Din belønningskode',
      redeemAt: 'Indløs hos',
      validUntil: 'Gyldig til',
      terms: 'Vilkår og betingelser',
      thankYou: 'Tak for din deltagelse!'
    },
    no: {
      subject: 'Din belønning fra {{journeyTitle}}',
      congratulations: 'Gratulerer!',
      youReceivedReward: 'Du har mottatt en belønning for å fullføre reisen',
      yourCode: 'Din belønningskode',
      redeemAt: 'Innløs hos',
      validUntil: 'Gyldig til',
      terms: 'Vilkår og betingelser',
      thankYou: 'Takk for at du deltok!'
    },
    fi: {
      subject: 'Palkkiosi kohteesta {{journeyTitle}}',
      congratulations: 'Onnittelut!',
      youReceivedReward: 'Sait palkkion matkan suorittamisesta',
      yourCode: 'Palkkiokoodisi',
      redeemAt: 'Lunasta kohteessa',
      validUntil: 'Voimassa asti',
      terms: 'Ehdot',
      thankYou: 'Kiitos osallistumisesta!'
    },
    sv: {
      subject: 'Din belöning från {{journeyTitle}}',
      congratulations: 'Grattis!',
      youReceivedReward: 'Du har fått en belöning för att ha slutfört resan',
      yourCode: 'Din belöningskod',
      redeemAt: 'Lös in hos',
      validUntil: 'Giltig till',
      terms: 'Villkor',
      thankYou: 'Tack för ditt deltagande!'
    },
    pl: {
      subject: 'Twoja nagroda z {{journeyTitle}}',
      congratulations: 'Gratulacje!',
      youReceivedReward: 'Otrzymałeś nagrodę za ukończenie podróży',
      yourCode: 'Twój kod nagrody',
      redeemAt: 'Zrealizuj w',
      validUntil: 'Ważne do',
      terms: 'Warunki',
      thankYou: 'Dziękujemy za udział!'
    },
    ro: {
      subject: 'Recompensa ta de la {{journeyTitle}}',
      congratulations: 'Felicitări!',
      youReceivedReward: 'Ai primit o recompensă pentru finalizarea călătoriei',
      yourCode: 'Codul tău de recompensă',
      redeemAt: 'De revendicat la',
      validUntil: 'Valabil până la',
      terms: 'Termeni și condiții',
      thankYou: 'Mulțumim pentru participare!'
    },
    tr: {
      subject: '{{journeyTitle}} ödülünüz',
      congratulations: 'Tebrikler!',
      youReceivedReward: 'Yolculuğu tamamladığınız için bir ödül kazandınız',
      yourCode: 'Ödül kodunuz',
      redeemAt: 'Kullanılacak yer',
      validUntil: 'Geçerlilik tarihi',
      terms: 'Koşullar',
      thankYou: 'Katılımınız için teşekkürler!'
    }
  };
  
  try {
    // Validate the magic link token (include journey settings for language override)
    const invResult = await query(`
      SELECT 
        i.id, i.status, i.expires_at, i.organization_id, i.journey_id, i.end_user_id,
        eu.first_name as end_user_first_name, eu.last_name as end_user_last_name, eu.email as end_user_email,
        j.title as journey_title, j.settings as journey_settings,
        o.name as org_name, o.settings->>'default_language' as org_language
      FROM invitations i
      JOIN end_users eu ON i.end_user_id = eu.id
      JOIN journeys j ON i.journey_id = j.id
      JOIN organizations o ON i.organization_id = o.id
      WHERE i.token = $1
    `, [token]);
    
    if (invResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    const invitation = invResult.rows[0];
    
    // Check if invitation is valid
    // Allow both 'active' and 'completed' status for reward claims because:
    // 1. There's a race condition where journey completes before reward claim finishes
    // 2. Users who completed a journey should still be able to claim their reward
    const validStatuses = ['active', 'completed'];
    if (!validStatuses.includes(invitation.status) || new Date(invitation.expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: 'Token expired or revoked' });
    }

    const orgId = invitation.organization_id;
    const endUserId = invitation.end_user_id;
    const journeyId = invitation.journey_id;
    const orgLanguage = invitation.org_language || 'en';

    // Use journey language override if set, otherwise fall back to org language
    const jSettings = typeof invitation.journey_settings === 'string'
      ? JSON.parse(invitation.journey_settings)
      : (invitation.journey_settings || {});
    const emailLanguage = (jSettings.language_override && jSettings.language_code)
      ? jSettings.language_code
      : orgLanguage;
    const t = rewardEmailTranslations[emailLanguage] || rewardEmailTranslations.en;
    
    // Check if step exists and is a reward step
    const stepResult = await query(`
      SELECT s.id, s.basic_props, s.journey_id
      FROM steps s
      JOIN journeys j ON s.journey_id = j.id
      WHERE s.id = $1 AND s.type = 'reward' AND j.id = $2 AND j.organization_id = $3
    `, [step_id, journeyId, orgId]);
    
    if (stepResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Reward step not found' });
    }
    
    const step = stepResult.rows[0];
    const basicProps = typeof step.basic_props === 'string' 
      ? JSON.parse(step.basic_props) 
      : step.basic_props;
    
    // Check if reward exists for this step, create if not
    const rewardResult = await query(`
      SELECT id, max_recipients, is_random_codes
      FROM rewards
      WHERE step_id = $1
    `, [step_id]);
    
    let rewardId;
    if (rewardResult.rows.length === 0) {
      // Create reward record from step basic_props
      const createRewardResult = await query(`
        INSERT INTO rewards (
          step_id, journey_id, organization_id, title, description,
          redemption_location, terms_conditions, valid_until,
          is_random_codes, max_recipients, code_prefix
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, max_recipients, is_random_codes
      `, [
        step_id,
        journeyId,
        orgId,
        basicProps.title || 'Reward',
        basicProps.description || '',
        basicProps.redemption_location || '',
        basicProps.terms_conditions || '',
        basicProps.valid_until || null,
        basicProps.is_random_codes !== false,
        basicProps.max_recipients || null,
        basicProps.code_prefix || ''
      ]);
      rewardId = createRewardResult.rows[0].id;
      rewardResult.rows[0] = createRewardResult.rows[0];
    } else {
      rewardId = rewardResult.rows[0].id;
      
      // Update reward record with latest step basic_props
      await query(`
        UPDATE rewards SET
          title = $2,
          description = $3,
          redemption_location = $4,
          terms_conditions = $5,
          valid_until = $6,
          is_random_codes = $7,
          max_recipients = $8,
          code_prefix = $9,
          updated_at = NOW()
        WHERE id = $1
      `, [
        rewardId,
        basicProps.title || 'Reward',
        basicProps.description || '',
        basicProps.redemption_location || '',
        basicProps.terms_conditions || '',
        basicProps.valid_until || null,
        basicProps.is_random_codes !== false,
        basicProps.max_recipients || null,
        basicProps.code_prefix || ''
      ]);
      
      // Update the local object with the potentially changed values
      rewardResult.rows[0].is_random_codes = basicProps.is_random_codes !== false;
      rewardResult.rows[0].max_recipients = basicProps.max_recipients || null;
    }
    
    // For manual codes: always sync the codes from basic_props to reward_codes table
    // This ensures any new codes are added (existing claimed codes won't be affected)
    if (basicProps.is_random_codes === false && basicProps.manual_codes) {
      const codes = basicProps.manual_codes.split(/[,\n]/).filter(c => c.trim());
      for (const code of codes) {
        await query(`
          INSERT INTO reward_codes (reward_id, organization_id, code)
          VALUES ($1, $2, $3)
          ON CONFLICT (reward_id, code) DO NOTHING
        `, [rewardId, orgId, code.trim()]);
      }
    }
    
    const reward = rewardResult.rows[0];
    
    // Claim in one transaction, serialized per journey: concurrent requests
    // must not give one user two codes, one code to two users, or exceed
    // max_recipients.
    let code;
    let claimPosition;
    let existingClaim = null;
    let noMoreRewards = false;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`reward-claim:${journeyId}`]);

      const existingClaimResult = await client.query(`
        SELECT rc.code, rc.claim_position
        FROM reward_codes rc
        JOIN rewards r ON rc.reward_id = r.id
        WHERE r.journey_id = $1 AND rc.claimed_by_end_user_id = $2 AND rc.is_claimed = true
      `, [journeyId, endUserId]);

      if (existingClaimResult.rows.length > 0) {
        existingClaim = existingClaimResult.rows[0];
      } else {
        const claimedCountResult = await client.query(
          'SELECT COUNT(*) as count FROM reward_codes WHERE reward_id = $1 AND is_claimed = true',
          [rewardId]
        );
        const claimedCount = parseInt(claimedCountResult.rows[0].count);
        claimPosition = claimedCount + 1;

        if (reward.max_recipients && claimedCount >= reward.max_recipients) {
          noMoreRewards = true;
        } else if (reward.is_random_codes) {
          // Generate random code
          const prefix = basicProps.code_prefix || '';
          code = prefix + crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 8);
          await client.query(`
            INSERT INTO reward_codes (
              reward_id, organization_id, code, is_claimed, 
              claimed_by_end_user_id, claimed_by_invitation_id, claimed_at, claim_position
            ) VALUES ($1, $2, $3, true, $4, $5, NOW(), $6)
          `, [rewardId, orgId, code, endUserId, invitation.id, claimPosition]);
        } else {
          // Next unclaimed manual code
          const nextCodeResult = await client.query(`
            SELECT id, code FROM reward_codes 
            WHERE reward_id = $1 AND is_claimed = false
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE
          `, [rewardId]);

          if (nextCodeResult.rows.length === 0) {
            noMoreRewards = true;
          } else {
            code = nextCodeResult.rows[0].code;
            await client.query(`
              UPDATE reward_codes SET 
                is_claimed = true,
                claimed_by_end_user_id = $1,
                claimed_by_invitation_id = $2,
                claimed_at = NOW(),
                claim_position = $3
              WHERE id = $4
            `, [endUserId, invitation.id, claimPosition, nextCodeResult.rows[0].id]);
          }
        }
      }
      await client.query('COMMIT');
    } catch (claimErr) {
      await client.query('ROLLBACK');
      throw claimErr;
    } finally {
      client.release();
    }

    if (existingClaim) {
      // User already claimed - return existing code
      return res.json({ 
        success: true, 
        alreadyClaimed: true,
        code: existingClaim.code,
        position: existingClaim.claim_position,
        reward: {
          title: basicProps.title,
          description: basicProps.description,
          redemption_location: basicProps.redemption_location,
          terms_conditions: basicProps.terms_conditions,
          valid_until: basicProps.valid_until
        }
      });
    }

    if (noMoreRewards) {
      return res.json({ success: false, error: 'no_more_rewards', message: 'All rewards have been claimed' });
    }
    
    // Send email with reward code
    const journeyTitle = invitation.journey_title || 'Journey';
    const endUserEmail = invitation.end_user_email;
    const endUserName = `${invitation.end_user_first_name || ''} ${invitation.end_user_last_name || ''}`.trim() || 'Participant';
    
    if (endUserEmail) {
      const langToLocale = { en: 'en-US', nl: 'nl-NL', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', pt: 'pt-PT', da: 'da-DK', no: 'nb-NO', fi: 'fi-FI', sv: 'sv-SE', pl: 'pl-PL', ro: 'ro-RO', tr: 'tr-TR' };
      const validUntilFormatted = basicProps.valid_until 
        ? new Date(basicProps.valid_until).toLocaleDateString(langToLocale[emailLanguage] || 'en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : null;
        
      // Use {{primaryColor}} and {{bgColor}} placeholders for theme color support
      const emailBody = `
        <div style="text-align: center; padding: 20px;">
          <h1 style="color: {{primaryColor}};">${t.congratulations}</h1>
          <p style="font-size: 16px; color: #666;">${t.youReceivedReward} "<strong>${journeyTitle}</strong>"</p>
          
          <div style="background: white; border: 2px solid {{primaryColor}}; border-radius: 16px; padding: 24px; margin: 24px 0; display: inline-block; min-width: 280px;">
            <h2 style="color: {{primaryColor}}; margin-bottom: 8px;">${basicProps.title || 'Reward'}</h2>
            ${basicProps.description ? `<p style="color: #64748b; margin-bottom: 16px;">${basicProps.description}</p>` : ''}
            
            <div style="background: {{bgColor}}; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="font-size: 12px; color: {{primaryColor}}; margin-bottom: 4px;">${t.yourCode}</p>
              <p style="font-size: 28px; font-family: monospace; font-weight: bold; color: {{primaryColor}}; letter-spacing: 2px; margin: 0;">${code}</p>
            </div>
            
            ${basicProps.redemption_location ? `
              <p style="color: #64748b; margin: 8px 0;">
                <strong style="color: {{primaryColor}};">${t.redeemAt}:</strong> ${basicProps.redemption_location}
              </p>
            ` : ''}
            
            ${validUntilFormatted ? `
              <p style="color: #64748b; margin: 8px 0;">
                <strong style="color: {{primaryColor}};">${t.validUntil}:</strong> ${validUntilFormatted}
              </p>
            ` : ''}
            
            ${basicProps.terms_conditions ? `
              <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
                <p style="font-size: 12px; color: {{primaryColor}}; font-weight: bold; margin-bottom: 4px;">${t.terms}</p>
                <p style="font-size: 12px; color: #64748b;">${basicProps.terms_conditions}</p>
              </div>
            ` : ''}
          </div>
          
          <p style="color: #666; font-size: 14px;">${t.thankYou}</p>
        </div>
      `;
      
      try {
        await sendJourneyEmail({
          to: endUserEmail,
          userName: endUserName,
          subject: t.subject.replace('{{journeyTitle}}', journeyTitle),
          body: emailBody,
          templateType: 'journey_info',
          journeyTitle,
          isHtmlBody: true,
          language: emailLanguage,
          orgId: orgId
        });
        
        // Update email_sent_at
        await query(`
          UPDATE reward_codes SET email_sent_at = NOW()
          WHERE reward_id = $1 AND code = $2
        `, [rewardId, code]);
        
        console.log(`[Player Reward] Email sent to ${endUserEmail} with code ${code}`);
      } catch (emailErr) {
        console.error('[Player Reward] Failed to send email:', emailErr);
        // Continue - reward is still claimed even if email fails
      }
    }
    
    console.log(`[Player Reward] Code ${code} claimed by end user ${endUserId} (position #${claimPosition})`);
    
    res.json({ 
      success: true, 
      code,
      position: claimPosition,
      reward: {
        title: basicProps.title,
        description: basicProps.description,
        redemption_location: basicProps.redemption_location,
        terms_conditions: basicProps.terms_conditions,
        valid_until: basicProps.valid_until
      }
    });
    
  } catch (err) {
    console.error('Player reward claim error:', err);
    res.status(500).json({ success: false, error: 'Failed to claim reward: ' + err.message });
  }
});

// ============================================
// GOOGLE OAUTH CALLBACK
// ============================================

import {
  exchangeCodeForTokens,
  getConnectedAdminInfo
} from '../services/google.js';

/**
 * GET /api/auth/callback/google - Handle Google OAuth callback
 * Note: This is mounted on '/' so full path is /api/auth/callback/google
 * 
 * Security: The state parameter contains orgId and timestamp, signed with a hash.
 * This prevents CSRF attacks while not relying on session cookies (which may be
 * lost during cross-site OAuth redirects due to SameSite cookie restrictions).
 */
router.get('/api/auth/callback/google', async (req, res) => {
  console.log('[Google OAuth] Callback received!');
  
  const { code, state, error } = req.query;
  
  // Handle OAuth errors from Google
  if (error) {
    console.error('[Google OAuth] Error from Google:', error);
    return res.redirect('/dashboard/system-settings?google_error=' + encodeURIComponent(error));
  }
  
  if (!code || !state) {
    console.error('[Google OAuth] Missing code or state');
    return res.redirect('/dashboard/system-settings?google_error=missing_params');
  }
  
  try {
    // Verify the HMAC-signed state. Only an orgId that we signed ourselves is
    // trusted, which prevents an attacker from forging a state pointing at a
    // victim org (OAuth CSRF / org-takeover). Expiry is enforced inside verify.
    const stateData = verifyOAuthState(state);
    if (!stateData || !stateData.orgId) {
      console.error('[Google OAuth] Invalid or expired state');
      return res.redirect('/dashboard/system-settings?google_error=invalid_state');
    }

    const { orgId } = stateData;

    // Defense in depth: when the initiating session is present, bind to it.
    if (req.session?.googleOAuthState && req.session.googleOAuthState !== state) {
      console.error('[Google OAuth] State does not match session');
      return res.redirect('/dashboard/system-settings?google_error=invalid_state');
    }
    if (req.session?.organization?.id && req.session.organization.id !== orgId) {
      console.error('[Google OAuth] State orgId does not match session organization');
      return res.redirect('/dashboard/system-settings?google_error=invalid_state');
    }
    
    // Verify organization exists in database
    const orgResult = await query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
    if (orgResult.rows.length === 0) {
      console.error('[Google OAuth] Organization not found:', orgId);
      return res.redirect('/dashboard/system-settings?google_error=org_not_found');
    }
    console.log('[Google OAuth] Organization verified:', orgResult.rows[0].name);
    
    // Exchange code for tokens
    console.log('[Google OAuth] Exchanging code for tokens...');
    const tokenResponse = await exchangeCodeForTokens(code);
    console.log('[Google OAuth] Got tokens, refresh_token present:', !!tokenResponse.refresh_token);
    
    if (!tokenResponse.access_token) {
      throw new Error('No access token received from Google');
    }
    
    // Get admin info from Google
    console.log('[Google OAuth] Getting admin info...');
    const adminInfo = await getConnectedAdminInfo(tokenResponse.access_token);
    console.log('[Google OAuth] Admin info:', adminInfo.email, '- domain:', adminInfo.domain);
    
    // Store tokens in organization
    await query(
      `UPDATE organizations SET 
        google_access_token = $1,
        google_refresh_token = $2,
        google_connected_email = $3,
        google_connected_at = NOW(),
        google_domain = $4
       WHERE id = $5`,
      [
        encryptToken(tokenResponse.access_token),
        encryptToken(tokenResponse.refresh_token),
        adminInfo.email,
        adminInfo.domain,
        orgId
      ]
    );
    
    console.log(`[Google OAuth] ✅ Successfully connected org "${orgResult.rows[0].name}" via ${adminInfo.email}`);
    
    // One-time use: clear the stored state
    if (req.session) delete req.session.googleOAuthState;
    
    // Redirect back to system settings with success
    res.redirect('/dashboard/system-settings?google_connected=true');
    
  } catch (err) {
    console.error('[Google OAuth] Callback error:', err.message);
    console.error('[Google OAuth] Full error:', err);
    res.redirect('/dashboard/system-settings?google_error=' + encodeURIComponent(err.message));
  }
});

// ============================================
// MICROSOFT OAUTH CALLBACK (Admin Consent Flow)
// ============================================

import {
  getClientCredentialsToken,
  getTenantInfo
} from '../services/microsoft.js';

/**
 * GET /api/auth/callback/microsoft - Handle Microsoft Admin Consent callback
 * Note: This is mounted on '/' so full path is /api/auth/callback/microsoft
 * 
 * The Admin Consent flow returns:
 * - tenant: The tenant ID of the organization that granted consent
 * - admin_consent: True if consent was granted
 * - state: Our state parameter with orgId
 * 
 * OR on error:
 * - error: Error code
 * - error_description: Error description
 */
router.get('/api/auth/callback/microsoft', async (req, res) => {
  console.log('[Microsoft OAuth] Callback received!');
  
  const { tenant, admin_consent, state, error, error_description } = req.query;
  
  // Handle OAuth errors from Microsoft
  if (error) {
    console.error('[Microsoft OAuth] Error from Microsoft:', error, '-', error_description);
    return res.redirect('/dashboard/system-settings?microsoft_error=' + encodeURIComponent(error_description || error));
  }
  
  // Check if admin consent was granted
  if (admin_consent !== 'True' && admin_consent !== 'true') {
    console.error('[Microsoft OAuth] Admin consent not granted');
    return res.redirect('/dashboard/system-settings?microsoft_error=consent_denied');
  }
  
  if (!tenant || !state) {
    console.error('[Microsoft OAuth] Missing tenant or state');
    return res.redirect('/dashboard/system-settings?microsoft_error=missing_params');
  }
  
  try {
    // Verify the HMAC-signed state. Only an orgId that we signed ourselves is
    // trusted, which prevents an attacker from forging a state pointing at a
    // victim org (OAuth CSRF / org-takeover). Expiry is enforced inside verify.
    const stateData = verifyOAuthState(state);
    if (!stateData || !stateData.orgId) {
      console.error('[Microsoft OAuth] Invalid or expired state');
      return res.redirect('/dashboard/system-settings?microsoft_error=invalid_state');
    }

    const { orgId } = stateData;

    // Defense in depth: when the initiating session is present, bind to it.
    if (req.session?.microsoftOAuthState && req.session.microsoftOAuthState !== state) {
      console.error('[Microsoft OAuth] State does not match session');
      return res.redirect('/dashboard/system-settings?microsoft_error=invalid_state');
    }
    if (req.session?.organization?.id && req.session.organization.id !== orgId) {
      console.error('[Microsoft OAuth] State orgId does not match session organization');
      return res.redirect('/dashboard/system-settings?microsoft_error=invalid_state');
    }

    // The admin-consent redirect is not signed by Microsoft, so `tenant` comes
    // from the URL and can be any tenant that ever consented to the Gryffi app.
    // Accept only a tenant GUID, and never one that is already linked to a
    // different organization: otherwise anyone could import an existing
    // customer's directory into their own organization.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
      console.error('[Microsoft OAuth] Invalid tenant id format');
      return res.redirect('/dashboard/system-settings?microsoft_error=missing_params');
    }
    const tenantInUse = await query(
      'SELECT 1 FROM organizations WHERE microsoft_tenant_id = $1 AND id <> $2 LIMIT 1',
      [tenant, orgId]
    );
    if (tenantInUse.rows.length > 0) {
      console.warn(`[Microsoft OAuth] Refused: tenant ${tenant} is already linked to another organization (requested by org ${orgId})`);
      return res.redirect('/dashboard/system-settings?microsoft_error=tenant_in_use');
    }
    
    // Verify organization exists in database
    const orgResult = await query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
    if (orgResult.rows.length === 0) {
      console.error('[Microsoft OAuth] Organization not found:', orgId);
      return res.redirect('/dashboard/system-settings?microsoft_error=org_not_found');
    }
    console.log('[Microsoft OAuth] Organization verified:', orgResult.rows[0].name);
    
    // Get access token using client credentials
    console.log('[Microsoft OAuth] Getting client credentials token for tenant:', tenant);
    const tokenResponse = await getClientCredentialsToken(tenant);
    console.log('[Microsoft OAuth] Got access token');
    
    if (!tokenResponse.access_token) {
      throw new Error('No access token received from Microsoft');
    }
    
    // Get tenant info from Microsoft Graph
    console.log('[Microsoft OAuth] Getting tenant info...');
    let tenantInfo = null;
    let tenantName = tenant; // Fallback to tenant ID
    let adminEmail = null;
    
    try {
      tenantInfo = await getTenantInfo(tokenResponse.access_token);
      tenantName = tenantInfo?.displayName || tenant;
      // Try to get the first verified domain as a display reference
      if (tenantInfo?.verifiedDomains?.length > 0) {
        const primaryDomain = tenantInfo.verifiedDomains.find(d => d.isDefault) || tenantInfo.verifiedDomains[0];
        adminEmail = `admin@${primaryDomain.name}`;
      }
      console.log('[Microsoft OAuth] Tenant info:', tenantName);
    } catch (tenantErr) {
      console.warn('[Microsoft OAuth] Could not get tenant info:', tenantErr.message);
    }
    
    // Store tokens in organization
    await query(
      `UPDATE organizations SET 
        microsoft_access_token = $1,
        microsoft_tenant_id = $2,
        microsoft_tenant_name = $3,
        microsoft_connected_email = $4,
        microsoft_connected_at = NOW(),
        microsoft_sync_config = COALESCE(microsoft_sync_config, '{"syncMode": "all", "syncGroups": true, "selectedGroupIds": [], "autoSyncEnabled": true}'::jsonb)
       WHERE id = $5`,
      [
        encryptToken(tokenResponse.access_token),
        tenant,
        tenantName,
        adminEmail,
        orgId
      ]
    );
    
    console.log(`[Microsoft OAuth] ✅ Successfully connected org "${orgResult.rows[0].name}" to tenant "${tenantName}"`);
    
    // One-time use: clear the stored state
    if (req.session) delete req.session.microsoftOAuthState;
    
    // Redirect back to system settings with success
    res.redirect('/dashboard/system-settings?microsoft_connected=true');
    
  } catch (err) {
    console.error('[Microsoft OAuth] Callback error:', err.message);
    console.error('[Microsoft OAuth] Full error:', err);
    res.redirect('/dashboard/system-settings?microsoft_error=' + encodeURIComponent(err.message));
  }
});

// ============================================
// PUBLIC JOURNEYS (Tier 3+ Feature)
// ============================================

/**
 * GET /p/:token - Access public journey via shared link
 * This is the entry point for anonymous public users
 */
router.get('/p/:token', async (req, res) => {
  const { token } = req.params;
  
  if (!token) {
    return res.status(400).render('pages/expedition-error', {
      title: req.t('invitations.magicLink.expired.title'),
      message: req.t('invitations.magicLink.expired.message'),
      errorType: 'invalid'
    });
  }
  
  try {
    // Find public journey by token (must be published)
    const result = await query(`
      SELECT 
        j.*,
        o.id as org_id,
        o.name as org_name,
        o.logo_url as org_logo,
        o.subscription_tier_id,
        COALESCE(o.settings->>'default_language', 'en') as org_language,
        t.logo_url as theme_logo_url,
        t.tokens as theme_tokens
      FROM journeys j
      JOIN organizations o ON j.organization_id = o.id
      LEFT JOIN themes t ON o.active_theme_id = t.id
      WHERE j.public_token = $1 
        AND j.is_public = true 
        AND j.status = 'published'
        AND j.deleted_at IS NULL
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).render('pages/expedition-error', {
        title: req.t('invitations.magicLink.expired.title'),
        message: req.t('invitations.magicLink.expired.message'),
        errorType: 'not_found'
      });
    }
    
    const journey = result.rows[0];
    const orgLanguage = journey.org_language || 'en';
    
    // Determine journey language: use journey override if set, otherwise use org language
    const journeySettings = typeof journey.settings === 'string' 
      ? JSON.parse(journey.settings) 
      : (journey.settings || {});
    const journeyLanguage = journeySettings.language_override && journeySettings.language_code 
      ? journeySettings.language_code 
      : orgLanguage;
    
    // Determine AI Guide language: use guide language override if set, otherwise same as journey language
    const guideLanguage = journeySettings.guide_language_override && journeySettings.guide_language_code 
      ? journeySettings.guide_language_code 
      : journeyLanguage;
    
    const t = i18next.getFixedT(journeyLanguage);
    
    // Check if journey is published
    if (journey.status !== 'published') {
      return res.render('pages/expedition-error', {
        title: t('invitations.magicLink.notReady.title'),
        message: t('invitations.magicLink.notReady.message'),
        errorType: 'not_ready'
      });
    }
    
    // Get or create session ID for this public participant
    let sessionId = req.session.publicSessionId;
    if (!sessionId) {
      sessionId = crypto.randomBytes(32).toString('hex');
      req.session.publicSessionId = sessionId;
    }
    
    // Get browser fingerprint
    const browserFingerprint = req.session.browserFingerprint || crypto.randomBytes(16).toString('hex');
    req.session.browserFingerprint = browserFingerprint;
    
    // Check for existing participant by session
    const participant = await query(`
      SELECT * FROM public_participants
      WHERE journey_id = $1 AND session_id = $2
    `, [journey.id, sessionId]);
    
    let participantId;
    
    if (participant.rows.length > 0) {
      participantId = participant.rows[0].id;
      // Update last visit
      await query(`
        UPDATE public_participants 
        SET updated_at = NOW(), browser_fingerprint = COALESCE(browser_fingerprint, $1)
        WHERE id = $2
      `, [browserFingerprint, participantId]);
    } else {
      // Create new participant
      const newParticipant = await query(`
        INSERT INTO public_participants 
          (journey_id, organization_id, session_id, browser_fingerprint)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [journey.id, journey.org_id, sessionId, browserFingerprint]);
      participantId = newParticipant.rows[0].id;
    }
    
    // Store participant info in session
    req.session.publicParticipantId = participantId;
    req.session.publicJourneyId = journey.id;
    req.session.publicOrgId = journey.org_id;
    
    // Get journey steps
    const stepsResult = await query(`
      SELECT * FROM steps WHERE journey_id = $1 ORDER BY created_at
    `, [journey.id]);
    
    // Get paths
    const pathsResult = await query(`
      SELECT * FROM paths WHERE journey_id = $1
    `, [journey.id]);
    
    // Get resources
    const resourcesResult = await query(`
      SELECT * FROM resources WHERE journey_id = $1
    `, [journey.id]);
    
    // Get ALL guides for this organization (needed for guide steps)
    const guidesResult = await query(`
      SELECT g.id, g.name, g.role, g.avatar_url, g.personality, g.greeting, g.language, g.is_active,
             (SELECT COUNT(*) FROM knowledge_sources WHERE guide_id = g.id) as knowledge_count,
             (SELECT COALESCE(SUM(chunks_count), 0) FROM knowledge_sources WHERE guide_id = g.id) as chunks_count
      FROM guides g
      WHERE g.organization_id = $1 AND g.deleted_at IS NULL
      ORDER BY g.name
    `, [journey.org_id]);
    
    // Process journey settings - extract to top level for builder template compatibility
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
    
    console.log('[PublicJourney] Language settings - override:', journey.language_override, 
      'code:', journey.language_code, 'guideLanguage:', guideLanguage, 'guideOpeningOverride:', journey.guide_opening_override ? 'set' : 'empty');
    
    // Get participant progress
    const participantData = await query(`
      SELECT * FROM public_participants WHERE id = $1
    `, [participantId]);
    
    const participantProgress = participantData.rows[0];
    
    // Prepare organization data with theme
    const organization = {
      id: journey.org_id,
      name: journey.org_name,
      logoUrl: journey.theme_logo_url || journey.org_logo,
      settings: {}
    };
    
    // Prepare theme if custom theme is active
    let customTheme = null;
    if (journey.theme_tokens) {
      customTheme = {
        logoUrl: journey.theme_logo_url,
        tokens: typeof journey.theme_tokens === 'string' 
          ? JSON.parse(journey.theme_tokens) 
          : journey.theme_tokens
      };
    }
    
    // Load journey-specific translations
    const jt = i18next.getFixedT(journeyLanguage);
    const journeyTranslations = {
      builder: jt('builder', { returnObjects: true }),
      common: jt('common', { returnObjects: true }),
      journeys: jt('journeys', { returnObjects: true }),
      guides: jt('guides', { returnObjects: true }),
      imagePicker: jt('imagePicker', { returnObjects: true }),
      expedition: jt('expedition', { returnObjects: true })
    };
    
    // Load player-specific translations (supports extended languages)
    const playerTranslations = getPlayerLocale(journeyLanguage);
    
    // Render the public player view with journey-specific language
    res.render('pages/builder', {
      title: journey.title,
      journey: journey,
      organization: { ...organization, defaultLanguage: orgLanguage },
      steps: stripQuizAnswers(stepsResult.rows),
      paths: pathsResult.rows,
      resources: resourcesResult.rows,
      guides: guidesResult.rows,
      readOnly: true,
      playerMode: true,
      publicMode: true, // Flag to indicate this is public journey
      customTheme: customTheme,
      locale: journeyLanguage, // Journey-specific language for interface
      language: journeyLanguage,
      interfaceTranslations: journeyTranslations, // Pre-loaded translations for journey language (used by template as main translations)
      previewTranslations: journeyTranslations, // Same translations for preview content
      playerTranslations: playerTranslations, // Player-specific translations (extended language support)
      guideLanguage: guideLanguage, // AI Guide response language
      player: {
        participantId: participantId,
        sessionId: sessionId,
        email: participantProgress?.email,
        firstName: participantProgress?.first_name,
        lastName: participantProgress?.last_name,
        isIdentified: !!participantProgress?.email,
        currentStepId: participantProgress?.current_step_id,
        visitedSteps: participantProgress?.visited_steps || [],
        language: journeyLanguage,
        guideLanguage: guideLanguage
      },
      publicToken: token,
      APP_URL: getAppBaseUrl()
    });
    
  } catch (err) {
    console.error('Public journey error:', err);
    res.status(500).render('pages/expedition-error', {
      title: req.t('errors.serverError'),
      message: req.t('errors.tryAgain'),
      errorType: 'error'
    });
  }
});

/**
 * POST /p/:token/auto-login - Automatically authenticate a returning user
 * Uses stored credentials from localStorage to skip verification if email was already verified
 */
router.post('/p/:token/auto-login', async (req, res) => {
  const { token } = req.params;
  const { email, rememberToken } = req.body;
  
  if (!token || !email) {
    return res.status(400).json({ success: false, error: 'Token and email required' });
  }
  // Knowing someone's email address is not enough: the browser must also hold
  // the secret token it got when that email was verified.
  if (!rememberToken || typeof rememberToken !== 'string') {
    return res.json({ success: false, needsVerification: true, message: 'Email not yet verified for this journey' });
  }
  
  try {
    // Verify the public journey exists
    const journeyResult = await query(`
      SELECT j.id, j.organization_id, j.title
      FROM journeys j
      WHERE j.public_token = $1 
        AND j.is_public = true 
        AND j.status = 'published'
        AND j.deleted_at IS NULL
    `, [token]);
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const journey = journeyResult.rows[0];
    const emailLower = email.toLowerCase().trim();
    
    // Check if this email is already verified for this journey
    const existingParticipant = await query(`
      SELECT id, first_name, last_name, email, email_verified
      FROM public_participants 
      WHERE journey_id = $1 AND email = $2 AND email_verified = true AND remember_token_hash = $3
    `, [journey.id, emailLower, hashRememberToken(rememberToken)]);
    
    if (existingParticipant.rows.length === 0) {
      // Email not verified yet - need normal identification flow
      return res.json({ 
        success: false, 
        needsVerification: true,
        message: 'Email not yet verified for this journey'
      });
    }
    
    const participant = existingParticipant.rows[0];
    
    // Update session with participant info, under a new session ID
    await rotateSessionId(req);
    req.session.publicParticipantId = participant.id;
    req.session.publicJourneyId = journey.id;
    req.session.publicOrgId = journey.organization_id;
    req.session.publicSessionId = req.session.id;
    
    // Update last activity and rotate the remember token (single use)
    const newRememberToken = crypto.randomBytes(32).toString('base64url');
    await query(`
      UPDATE public_participants 
      SET updated_at = NOW(), remember_token_hash = $2
      WHERE id = $1
    `, [participant.id, hashRememberToken(newRememberToken)]);
    
    console.log(`[Public Journey] Auto-login successful for ${emailLower} in journey ${journey.id}`);
    
    res.json({ 
      success: true, 
      message: 'Auto-login successful',
      rememberToken: newRememberToken,
      participant: {
        id: participant.id,
        firstName: participant.first_name,
        lastName: participant.last_name,
        email: participant.email
      }
    });
    
  } catch (err) {
    console.error('Auto-login error:', err);
    res.status(500).json({ success: false, error: 'Auto-login failed' });
  }
});

/**
 * POST /p/:token/identify - Identify public participant
 * Required before form submission, poll voting, or reward claiming
 */
router.post('/p/:token/identify', async (req, res) => {
  const { token } = req.params;
  const { email, firstName, lastName, stepType, stepId } = req.body;
  
  if (!email || !firstName || !lastName) {
    return res.status(400).json({ 
      success: false, 
      error: 'Email, first name, and last name are required' 
    });
  }
  
  try {
    // Validate token and get journey
    const journeyResult = await query(`
      SELECT id, organization_id FROM journeys 
      WHERE public_token = $1 AND is_public = true AND deleted_at IS NULL
    `, [token]);
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const journey = journeyResult.rows[0];
    const participantId = req.session.publicParticipantId;
    const sessionId = req.session.publicSessionId;
    
    if (!participantId || !sessionId) {
      return res.status(400).json({ success: false, error: 'Invalid session' });
    }
    
    const emailLower = email.toLowerCase().trim();
    
    // Check if this email already exists for this journey
    const existingParticipant = await query(`
      SELECT id, email_verified FROM public_participants 
      WHERE journey_id = $1 AND email = $2 AND id != $3
    `, [journey.id, emailLower, participantId]);
    
    if (existingParticipant.rows.length > 0) {
      // Check if they already participated (for polls/rewards)
      if (stepType === 'poll') {
        const existingVote = await query(`
          SELECT id, selected_option FROM public_poll_responses 
          WHERE participant_id = $1 AND step_id = $2
        `, [existingParticipant.rows[0].id, stepId]);
        
        if (existingVote.rows.length > 0) {
          // Get poll results to return
          const resultsQuery = await query(`
            SELECT selected_option, COUNT(*) as count
            FROM public_poll_responses
            WHERE step_id = $1 AND journey_id = $2
            GROUP BY selected_option
          `, [stepId, journey.id]);
          
          const results = {};
          let totalVotes = 0;
          resultsQuery.rows.forEach(row => {
            results[row.selected_option] = parseInt(row.count);
            totalVotes += parseInt(row.count);
          });
          
          return res.json({ 
            success: true, 
            alreadyVoted: true,
            userVote: existingVote.rows[0].selected_option,
            results,
            totalVotes,
            message: req.t('builder.poll.alreadyVoted')
          });
        }
      }
      
      if (stepType === 'reward') {
        const existingClaim = await query(`
          SELECT id FROM public_reward_claims 
          WHERE participant_id = $1 AND step_id = $2
        `, [existingParticipant.rows[0].id, stepId]);
        
        if (existingClaim.rows.length > 0) {
          return res.status(400).json({ 
            success: false, 
            error: req.t('journeys.public.identify.alreadyClaimed'),
            code: 'ALREADY_CLAIMED'
          });
        }
      }
    }
    
    // Generate verification code
    const verificationCode = crypto.randomInt(100000, 1000000).toString(); // 6-digit code
    const codeExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    // Update participant with email and verification code
    await query(`
      UPDATE public_participants 
      SET email = $1, 
          first_name = $2, 
          last_name = $3, 
          email_verification_code = $4,
          email_verification_expires = $5,
          email_verified = false,
          updated_at = NOW()
      WHERE id = $6
    `, [emailLower, firstName.trim(), lastName.trim(), verificationCode, codeExpires, participantId]);
    
    // Send verification email
    try {
      const orgResult = await query(`
        SELECT name, COALESCE(settings->>'default_language', 'en') as language
        FROM organizations WHERE id = $1
      `, [journey.organization_id]);
      
      const orgLanguage = orgResult.rows[0]?.language || 'en';
      
      await sendVerificationCodeEmail({
        to: emailLower,
        firstName: firstName.trim(),
        journeyTitle: journey.title,
        verificationCode: verificationCode,
        language: orgLanguage,
        orgId: journey.organization_id
      });
    } catch (emailErr) {
      console.error('[Public Journey] Failed to send verification email:', emailErr);
      return res.status(500).json({ success: false, error: 'Failed to send verification email' });
    }
    
    res.json({ 
      success: true, 
      message: 'Verification code sent',
      needsVerification: true
    });
    
  } catch (err) {
    console.error('Public identify error:', err);
    res.status(500).json({ success: false, error: 'Failed to identify' });
  }
});

/**
 * POST /p/:token/verify - Verify email for public participant
 */
router.post('/p/:token/verify', async (req, res) => {
  const { token: _token } = req.params;
  const { code } = req.body;
  
  if (!code) {
    return res.status(400).json({ success: false, error: 'Verification code is required' });
  }
  
  try {
    const participantId = req.session.publicParticipantId;
    
    if (!participantId) {
      return res.status(400).json({ success: false, error: 'Invalid session' });
    }
    
    // Get participant
    const participant = await query(`
      SELECT * FROM public_participants WHERE id = $1
    `, [participantId]);
    
    if (participant.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Participant not found' });
    }
    
    const p = participant.rows[0];
    
    // Check if code matches and not expired. Wrong codes are counted; after
    // the limit the code is destroyed and the participant must identify again.
    if (!p.email_verification_code || p.email_verification_code !== code) {
      req.session.publicVerifyAttempts = (req.session.publicVerifyAttempts || 0) + 1;
      if (req.session.publicVerifyAttempts >= PUBLIC_VERIFY_MAX_ATTEMPTS) {
        req.session.publicVerifyAttempts = 0;
        await query('UPDATE public_participants SET email_verification_code = NULL WHERE id = $1', [participantId]);
        return res.status(400).json({
          success: false,
          error: req.t('journeys.public.verify.tooManyAttempts'),
          code: 'TOO_MANY_ATTEMPTS'
        });
      }
      return res.status(400).json({ 
        success: false, 
        error: req.t('journeys.public.verify.invalidCode'),
        code: 'INVALID_CODE'
      });
    }
    
    if (new Date(p.email_verification_expires) < new Date()) {
      return res.status(400).json({ 
        success: false, 
        error: req.t('journeys.public.verify.codeExpired'),
        code: 'CODE_EXPIRED'
      });
    }
    
    // Mark as verified and issue a "remember me" token for auto-login
    const rememberToken = crypto.randomBytes(32).toString('base64url');
    await query(`
      UPDATE public_participants 
      SET email_verified = true, 
          email_verification_code = NULL,
          remember_token_hash = $2,
          updated_at = NOW()
      WHERE id = $1
    `, [participantId, hashRememberToken(rememberToken)]);
    req.session.publicVerifyAttempts = 0;
    
    res.json({ 
      success: true, 
      message: 'Email verified',
      rememberToken,
      participant: {
        email: p.email,
        firstName: p.first_name,
        lastName: p.last_name,
        isVerified: true
      }
    });
    
  } catch (err) {
    console.error('Public verify error:', err);
    res.status(500).json({ success: false, error: 'Failed to verify' });
  }
});

/**
 * POST /p/:token/poll/:stepId - Submit poll response for public journey
 */
router.post('/p/:token/poll/:stepId', async (req, res) => {
  const { token: _token, stepId } = req.params;
  const { option } = req.body;
  
  try {
    const participantId = req.session.publicParticipantId;
    
    if (!participantId) {
      return res.status(400).json({ success: false, error: 'Invalid session' });
    }
    
    // Verify participant is identified and verified
    const participant = await query(`
      SELECT * FROM public_participants WHERE id = $1 AND email_verified = true
    `, [participantId]);
    
    if (participant.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email verification required',
        code: 'VERIFICATION_REQUIRED'
      });
    }
    
    const p = participant.rows[0];
    
    // Helper function to get poll results for public journeys
    const getPublicPollResults = async (stepId, journeyId) => {
      const resultsQuery = await query(`
        SELECT selected_option, COUNT(*) as count
        FROM public_poll_responses
        WHERE step_id = $1 AND journey_id = $2
        GROUP BY selected_option
      `, [stepId, journeyId]);
      
      const results = {};
      let totalVotes = 0;
      resultsQuery.rows.forEach(row => {
        results[row.selected_option] = parseInt(row.count);
        totalVotes += parseInt(row.count);
      });
      
      return { results, totalVotes };
    };
    
    // Check if already voted
    const existingVote = await query(`
      SELECT id, selected_option FROM public_poll_responses 
      WHERE participant_id = $1 AND step_id = $2
    `, [participantId, stepId]);
    
    if (existingVote.rows.length > 0) {
      // Return results instead of error
      const { results, totalVotes } = await getPublicPollResults(stepId, p.journey_id);
      return res.json({ 
        success: true, 
        alreadyVoted: true,
        userVote: existingVote.rows[0].selected_option,
        results,
        totalVotes,
        message: req.t('builder.poll.alreadyVoted')
      });
    }
    
    // Also check by email (in case they used different session)
    const existingVoteByEmail = await query(`
      SELECT ppr.id, ppr.selected_option FROM public_poll_responses ppr
      JOIN public_participants pp ON ppr.participant_id = pp.id
      WHERE pp.email = $1 AND ppr.step_id = $2 AND pp.journey_id = $3
    `, [p.email, stepId, p.journey_id]);
    
    if (existingVoteByEmail.rows.length > 0) {
      // Return results instead of error
      const { results, totalVotes } = await getPublicPollResults(stepId, p.journey_id);
      return res.json({ 
        success: true, 
        alreadyVoted: true,
        userVote: existingVoteByEmail.rows[0].selected_option,
        results,
        totalVotes,
        message: req.t('builder.poll.alreadyVoted')
      });
    }
    
    // Record the vote
    await query(`
      INSERT INTO public_poll_responses 
        (participant_id, journey_id, step_id, selected_option)
      VALUES ($1, $2, $3, $4)
    `, [participantId, p.journey_id, stepId, option]);
    
    // Get updated results
    const { results, totalVotes } = await getPublicPollResults(stepId, p.journey_id);
    
    res.json({ 
      success: true, 
      message: req.t('builder.poll.voteRecorded'),
      userVote: option,
      results,
      totalVotes
    });
    
  } catch (err) {
    console.error('Public poll vote error:', err);
    res.status(500).json({ success: false, error: 'Failed to record vote' });
  }
});

/**
 * GET /p/:token/forms/submission-status/:stepId - Check if form was already submitted (public journey)
 * This allows users to skip forms they've already completed on repeat visits
 */
router.get('/p/:token/forms/submission-status/:stepId', async (req, res) => {
  const { stepId } = req.params;
  
  try {
    const participantId = req.session.publicParticipantId;
    
    if (!participantId) {
      // No session yet, so definitely hasn't submitted
      return res.json({
        success: true,
        hasSubmitted: false,
        submittedAt: null
      });
    }
    
    // Get participant info
    const participant = await query(`
      SELECT id, journey_id, email_verified 
      FROM public_participants 
      WHERE id = $1
    `, [participantId]);
    
    if (participant.rows.length === 0) {
      return res.json({
        success: true,
        hasSubmitted: false,
        submittedAt: null
      });
    }
    
    const p = participant.rows[0];
    
    // Check for previous submissions for this step by this participant
    const submissionResult = await query(`
      SELECT created_at 
      FROM public_form_submissions 
      WHERE participant_id = $1 
        AND journey_id = $2 
        AND step_id = $3
      ORDER BY created_at DESC
      LIMIT 1
    `, [participantId, p.journey_id, stepId]);
    
    if (submissionResult.rows.length > 0) {
      res.json({
        success: true,
        hasSubmitted: true,
        submittedAt: submissionResult.rows[0].created_at
      });
    } else {
      res.json({
        success: true,
        hasSubmitted: false,
        submittedAt: null
      });
    }
    
  } catch (err) {
    console.error('Public form submission status check error:', err);
    res.status(500).json({ success: false, error: 'Failed to check submission status' });
  }
});

/**
 * POST /p/:token/forms/submit - Submit form for public journey
 */
router.post('/p/:token/forms/submit', async (req, res) => {
  const { token: _token } = req.params;
  const { step_id, responses, attachments } = req.body;
  
  try {
    const participantId = req.session.publicParticipantId;
    
    if (!participantId) {
      return res.status(400).json({ success: false, error: 'Invalid session' });
    }
    
    // Verify participant is identified and verified
    const participant = await query(`
      SELECT pp.*, j.organization_id, j.title as journey_title,
             o.name as org_name, o.settings->>'default_language' as org_language
      FROM public_participants pp
      JOIN journeys j ON pp.journey_id = j.id
      JOIN organizations o ON j.organization_id = o.id
      WHERE pp.id = $1 AND pp.email_verified = true
    `, [participantId]);
    
    if (participant.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email verification required',
        code: 'VERIFICATION_REQUIRED'
      });
    }
    
    const p = participant.rows[0];
    
    // Get step info
    const stepResult = await query(`
      SELECT * FROM steps WHERE id = $1 AND journey_id = $2
    `, [step_id, p.journey_id]);
    
    if (stepResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Step not found' });
    }
    
    const step = stepResult.rows[0];
    const basicProps = step.basic_props || {};
    const formTitle = step.title || basicProps.title || 'Form';
    
    // Validate and decode uploaded files before saving anything
    let files;
    try {
      files = processAttachments(attachments);
    } catch (attachErr) {
      return res.status(400).json({ success: false, error: attachErr.message });
    }

    // Images are checked for NSFW content before anything is stored
    const imageCheck = await checkAttachmentImages(files);
    if (!imageCheck.allowed) {
      const nsfw = imageCheck.reason === 'nsfw';
      return res.status(nsfw ? 400 : 503).json({
        success: false,
        error: nsfw ? 'This image cannot be uploaded.' : 'The image could not be checked. Try again in a few minutes.',
        code: nsfw ? 'NSFW_CONTENT' : 'IMAGE_CHECK_UNAVAILABLE'
      });
    }
    
    // Save form submission (source of truth, shown in Analytics)
    const submissionResult = await query(`
      INSERT INTO public_form_submissions 
        (participant_id, journey_id, step_id, organization_id, responses, journey_title, step_title)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [participantId, p.journey_id, step_id, p.organization_id, JSON.stringify(responses), p.journey_title, formTitle]);
    const submissionId = submissionResult.rows[0].id;
    
    // Store uploaded files with secure, expiring download tokens
    const storedFiles = await storeSubmissionFiles({
      orgId: p.organization_id,
      journeyId: p.journey_id,
      stepId: step_id,
      publicSubmissionId: submissionId,
      files
    });
    
    // Send form notification email to recipient (with download links)
    const recipientEmail = basicProps.recipient_email;
    console.log(`[Public Form] Submission ${submissionId} received for step ${step_id}, recipient: ${recipientEmail || 'none configured'}`);
    
    if (recipientEmail) {
      const orgLanguage = p.org_language || 'en';
      const participantName = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email;
      
      const emailBody = buildFormSubmissionEmailBody({
        language: orgLanguage,
        journeyTitle: p.journey_title,
        formTitle,
        submitterName: participantName,
        submitterEmail: p.email,
        companyName: p.org_name || 'Gryffi',
        responses,
        fields: basicProps.fields,
        files: storedFiles,
        publicBadge: req.t('journeys.public.badge')
      });
      const subject = buildFormSubmissionSubject(orgLanguage, p.journey_title);
      
      let emailStatus = 'sent';
      let emailProviderId = null;
      let emailError = null;
      try {
        const result = await sendJourneyEmail({
          to: recipientEmail,
          userName: '',
          subject,
          body: emailBody,
          templateType: 'journey_info',
          journeyTitle: p.journey_title,
          stepTitle: formTitle,
          companyName: p.org_name || 'Gryffi',
          isHtmlBody: true,
          language: orgLanguage,
          orgId: p.organization_id
        });
        emailProviderId = result.emailId || null;
        
        await query(`
          UPDATE public_form_submissions SET email_sent = true, email_sent_at = NOW() WHERE id = $1
        `, [submissionId]);
        
        console.log(`[Public Form] Email sent successfully to ${recipientEmail}`);
      } catch (emailErr) {
        emailStatus = 'failed';
        emailError = emailErr.message;
        console.error('[Public Form] Failed to send email:', emailErr);
      }
      
      // Log the email attempt (sent or failed) for debugging/audit
      await query(`
        INSERT INTO email_logs 
          (organization_id, journey_id, step_id, to_email, subject, template_type, email_provider_id, status, error_message, variables)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        p.organization_id,
        p.journey_id,
        step_id,
        recipientEmail,
        subject,
        'form_submission',
        emailProviderId,
        emailStatus,
        emailError,
        JSON.stringify({ responses, submitter: { name: participantName, email: p.email }, files: storedFiles.map(f => f.original_name) })
      ]);
    } else {
      console.log(`[Public Form] No recipient email configured for step ${step_id}, skipping email notification`);
    }
    
    res.json({ success: true, message: 'Form submitted' });
    
  } catch (err) {
    console.error('Public form submit error:', err);
    res.status(500).json({ success: false, error: 'Failed to submit form' });
  }
});

/**
 * GET /files/forms/:token - Secure download of a form submission file
 * Used by form recipients via the link in the notification email.
 * Security: the token is a 256-bit random value (unguessable), expires after
 * DOWNLOAD_LINK_VALIDITY_DAYS and maps to exactly one file. No organization
 * or submission data is exposed in the URL.
 */
router.get('/files/forms/:token', magicLinkLimiter, async (req, res) => {
  const { token } = req.params;
  
  const renderError = (code, title, message) => res.status(code).render('pages/error', {
    title,
    message,
    code,
    user: req.session?.user,
    organization: req.session?.organization
  });
  
  try {
    // Basic shape check before hitting the database
    if (!token || token.length < 32 || token.length > 64 || !/^[\w-]+$/.test(token)) {
      return renderError(404, req.t('forms.download.notFoundTitle'), req.t('forms.download.notFoundMessage'));
    }
    
    const result = await query(`
      SELECT id, original_name, mime_type, storage_path, download_token_expires_at
      FROM form_submission_files
      WHERE download_token = $1
    `, [token]);
    
    if (result.rows.length === 0) {
      return renderError(404, req.t('forms.download.notFoundTitle'), req.t('forms.download.notFoundMessage'));
    }
    
    const file = result.rows[0];
    
    if (file.download_token_expires_at && new Date(file.download_token_expires_at) < new Date()) {
      return renderError(410, req.t('forms.download.expiredTitle'), req.t('forms.download.expiredMessage'));
    }
    
    const absolutePath = resolveStoragePath(file.storage_path);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return renderError(404, req.t('forms.download.notFoundTitle'), req.t('forms.download.notFoundMessage'));
    }
    
    await query(`
      UPDATE form_submission_files SET download_count = download_count + 1 WHERE id = $1
    `, [file.id]);
    
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.download(absolutePath, file.original_name);
    
  } catch (err) {
    console.error('Form file download error:', err);
    return renderError(500, req.t('pages.error'), req.t('errors.failedToLoad'));
  }
});

/**
 * GET /p/:token/rewards/availability/:stepId - Check if rewards are still available
 * This endpoint can be called without identification to show sold out message early
 */
router.get('/p/:token/rewards/availability/:stepId', async (req, res) => {
  const { token, stepId } = req.params;
  
  try {
    // Find journey by token
    const journeyResult = await query(`
      SELECT j.id FROM journeys j
      WHERE j.public_token = $1 AND j.is_public = true AND j.status = 'published'
    `, [token]);
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const journeyId = journeyResult.rows[0].id;
    
    // Get reward info for this step
    const rewardResult = await query(`
      SELECT r.id, r.max_recipients, r.is_random_codes
      FROM rewards r
      WHERE r.step_id = $1 AND r.journey_id = $2
    `, [stepId, journeyId]);
    
    if (rewardResult.rows.length === 0) {
      return res.json({ success: true, available: true }); // No reward configured, allow through
    }
    
    const reward = rewardResult.rows[0];
    
    // Check how many codes are available
    const availableCodesResult = await query(`
      SELECT COUNT(*) as count FROM reward_codes 
      WHERE reward_id = $1 AND is_claimed = false
    `, [reward.id]);
    
    const availableCodes = parseInt(availableCodesResult.rows[0].count);
    
    // If using random codes, check against max_recipients
    if (reward.is_random_codes) {
      if (reward.max_recipients) {
        const claimedCount = await query(`
          SELECT COUNT(*) as count FROM public_reward_claims WHERE reward_id = $1
        `, [reward.id]);
        const claimed = parseInt(claimedCount.rows[0].count);
        return res.json({ 
          success: true, 
          available: claimed < reward.max_recipients,
          soldOut: claimed >= reward.max_recipients
        });
      }
      return res.json({ success: true, available: true, soldOut: false });
    }
    
    // For manual codes, check if any are left
    return res.json({ 
      success: true, 
      available: availableCodes > 0,
      soldOut: availableCodes === 0
    });
    
  } catch (err) {
    console.error('Reward availability check error:', err);
    res.status(500).json({ success: false, error: 'Failed to check availability' });
  }
});

/**
 * POST /p/:token/rewards/claim - Claim reward for public journey
 */
router.post('/p/:token/rewards/claim', async (req, res) => {
  const { token: _token } = req.params;
  const { step_id } = req.body;
  
  // Reward email translations (same as private journey)
  const rewardEmailTranslations = {
    en: {
      subject: 'Your reward from {{journeyTitle}}',
      congratulations: 'Congratulations!',
      yourCode: 'Your reward code',
      redeemAt: 'Redeem at',
      yourReward: 'Your Reward'
    },
    nl: {
      subject: 'Jouw beloning van {{journeyTitle}}',
      congratulations: 'Gefeliciteerd!',
      yourCode: 'Jouw beloningscode',
      redeemAt: 'In te wisselen bij',
      yourReward: 'Jouw beloning'
    },
    de: {
      subject: 'Ihre Belohnung von {{journeyTitle}}',
      congratulations: 'Herzlichen Glückwunsch!',
      yourCode: 'Ihr Belohnungscode',
      redeemAt: 'Einzulösen bei',
      yourReward: 'Ihre Belohnung'
    },
    fr: {
      subject: 'Votre récompense de {{journeyTitle}}',
      congratulations: 'Félicitations !',
      yourCode: 'Votre code de récompense',
      redeemAt: 'À échanger chez',
      yourReward: 'Votre récompense'
    },
    es: {
      subject: 'Tu recompensa de {{journeyTitle}}',
      congratulations: '¡Felicitaciones!',
      yourCode: 'Tu código de recompensa',
      redeemAt: 'Canjear en',
      yourReward: 'Tu recompensa'
    },
    it: {
      subject: 'La tua ricompensa da {{journeyTitle}}',
      congratulations: 'Congratulazioni!',
      yourCode: 'Il tuo codice ricompensa',
      redeemAt: 'Da riscattare presso',
      yourReward: 'La tua ricompensa'
    },
    pt: {
      subject: 'Sua recompensa de {{journeyTitle}}',
      congratulations: 'Parabéns!',
      yourCode: 'Seu código de recompensa',
      redeemAt: 'Resgatar em',
      yourReward: 'Sua recompensa'
    },
    da: {
      subject: 'Din belønning fra {{journeyTitle}}',
      congratulations: 'Tillykke!',
      yourCode: 'Din belønningskode',
      redeemAt: 'Indløs hos',
      yourReward: 'Din belønning'
    },
    no: {
      subject: 'Din belønning fra {{journeyTitle}}',
      congratulations: 'Gratulerer!',
      yourCode: 'Din belønningskode',
      redeemAt: 'Innløs hos',
      yourReward: 'Din belønning'
    },
    fi: {
      subject: 'Palkkiosi kohteesta {{journeyTitle}}',
      congratulations: 'Onnittelut!',
      yourCode: 'Palkkiokoodisi',
      redeemAt: 'Lunasta kohteessa',
      yourReward: 'Palkkiosi'
    },
    sv: {
      subject: 'Din belöning från {{journeyTitle}}',
      congratulations: 'Grattis!',
      yourCode: 'Din belöningskod',
      redeemAt: 'Lös in hos',
      yourReward: 'Din belöning'
    },
    pl: {
      subject: 'Twoja nagroda z {{journeyTitle}}',
      congratulations: 'Gratulacje!',
      yourCode: 'Twój kod nagrody',
      redeemAt: 'Zrealizuj w',
      yourReward: 'Twoja nagroda'
    },
    ro: {
      subject: 'Recompensa ta de la {{journeyTitle}}',
      congratulations: 'Felicitări!',
      yourCode: 'Codul tău de recompensă',
      redeemAt: 'De revendicat la',
      yourReward: 'Recompensa ta'
    },
    tr: {
      subject: '{{journeyTitle}} ödülünüz',
      congratulations: 'Tebrikler!',
      yourCode: 'Ödül kodunuz',
      redeemAt: 'Kullanılacak yer',
      yourReward: 'Ödülünüz'
    }
  };
  
  try {
    const participantId = req.session.publicParticipantId;
    
    if (!participantId) {
      return res.status(400).json({ success: false, error: 'Invalid session' });
    }
    
    // Verify participant is identified and verified (include journey settings for language override)
    const participant = await query(`
      SELECT pp.*, j.organization_id, j.title as journey_title, j.settings as journey_settings
      FROM public_participants pp
      JOIN journeys j ON pp.journey_id = j.id
      WHERE pp.id = $1 AND pp.email_verified = true
    `, [participantId]);
    
    if (participant.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email verification required',
        code: 'VERIFICATION_REQUIRED'
      });
    }
    
    const p = participant.rows[0];
    
    // Reward info (outside the transaction: read only)
    const rewardResult = await query(`
      SELECT r.*, s.basic_props as step_props
      FROM rewards r
      JOIN steps s ON r.step_id = s.id
      WHERE r.step_id = $1 AND r.journey_id = $2
    `, [step_id, p.journey_id]);
    
    if (rewardResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Reward not found' });
    }
    
    const reward = rewardResult.rows[0];
    const stepProps = reward.step_props || {};
    
    // Claim in one transaction, serialized per journey, so concurrent requests
    // cannot claim twice for the same person or hand out one code twice.
    let code = null;
    let claimError = null;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`reward-claim:${p.journey_id}`]);

      // Already claimed by this participant, or by the same email address?
      const existingClaim = await client.query(`
        SELECT prc.id FROM public_reward_claims prc
        JOIN public_participants pp ON prc.participant_id = pp.id
        WHERE prc.step_id = $1 AND (prc.participant_id = $2 OR (pp.email = $3 AND pp.journey_id = $4))
        LIMIT 1
      `, [step_id, participantId, p.email, p.journey_id]);

      if (existingClaim.rows.length > 0) {
        claimError = { status: 400, body: { success: false, error: req.t('journeys.public.identify.alreadyClaimed'), code: 'ALREADY_CLAIMED' } };
      } else {
        const codeResult = await client.query(`
          SELECT * FROM reward_codes 
          WHERE reward_id = $1 AND is_claimed = false
          ORDER BY ${reward.is_random_codes ? 'RANDOM()' : 'created_at'}
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `, [reward.id]);

        if (codeResult.rows.length === 0) {
          let limitReached = false;
          if (reward.max_recipients) {
            const claimCount = await client.query(
              'SELECT COUNT(*) as count FROM public_reward_claims WHERE reward_id = $1',
              [reward.id]
            );
            limitReached = parseInt(claimCount.rows[0].count) >= reward.max_recipients;
          }
          claimError = { status: 400, body: { success: false, error: limitReached ? 'Reward limit reached' : 'No codes available', code: 'NO_MORE_REWARDS' } };
        } else {
          code = codeResult.rows[0].code;

          // Mark code as claimed (including public participant reference)
          await client.query(`
            UPDATE reward_codes 
            SET is_claimed = true,
                claimed_at = NOW(),
                claimed_by_public_participant_id = $2
            WHERE id = $1
          `, [codeResult.rows[0].id, participantId]);

          // Record the claim
          await client.query(`
            INSERT INTO public_reward_claims 
              (participant_id, journey_id, step_id, reward_id, code)
            VALUES ($1, $2, $3, $4, $5)
          `, [participantId, p.journey_id, step_id, reward.id, code]);
        }
      }
      await client.query('COMMIT');
    } catch (claimErr) {
      await client.query('ROLLBACK');
      throw claimErr;
    } finally {
      client.release();
    }

    if (claimError) {
      return res.status(claimError.status).json(claimError.body);
    }
    
    // Send email with code
    try {
      const orgResult = await query(`
        SELECT COALESCE(settings->>'default_language', 'en') as language
        FROM organizations WHERE id = $1
      `, [p.organization_id]);
      const orgLanguage = orgResult.rows[0]?.language || 'en';

      // Use journey language override if set, otherwise fall back to org language
      const pjSettings = typeof p.journey_settings === 'string'
        ? JSON.parse(p.journey_settings)
        : (p.journey_settings || {});
      const emailLanguage = (pjSettings.language_override && pjSettings.language_code)
        ? pjSettings.language_code
        : orgLanguage;
      const t = rewardEmailTranslations[emailLanguage] || rewardEmailTranslations.en;
      
      const rewardTitle = stepProps.title || 'Reward';
      
      const emailBody = `
        <div style="text-align: center; padding: 24px;">
          <h2 style="color: {{primaryColor}}; margin-bottom: 16px;">${t.congratulations}</h2>
          <p style="color: #666; margin-bottom: 24px;">${t.yourCode}</p>
          <div style="background: {{bgColor}}; border: 2px dashed {{primaryColor}}; border-radius: 12px; padding: 20px; margin: 20px 0;">
            <span style="font-size: 28px; font-weight: bold; color: {{primaryColor}}; letter-spacing: 2px;">${code}</span>
          </div>
          ${reward.redemption_location ? `<p style="color: #666; font-size: 14px;">${t.redeemAt}: ${reward.redemption_location}</p>` : ''}
          ${reward.terms_conditions ? `<p style="color: #999; font-size: 12px; margin-top: 16px;">${reward.terms_conditions}</p>` : ''}
        </div>
      `;
      
      await sendJourneyEmail({
        to: p.email,
        userName: p.first_name,
        subject: `${t.yourReward}: ${rewardTitle}`,
        body: emailBody,
        templateType: 'journey_custom',
        journeyTitle: p.journey_title,
        isHtmlBody: true,
        language: emailLanguage,
        orgId: p.organization_id
      });
      
      // Mark email as sent
      await query(`
        UPDATE public_reward_claims 
        SET email_sent = true, email_sent_at = NOW()
        WHERE participant_id = $1 AND step_id = $2
      `, [participantId, step_id]);
    } catch (emailErr) {
      console.error('[Public Reward] Failed to send email:', emailErr);
    }
    
    res.json({ 
      success: true, 
      code,
      reward: {
        title: stepProps.title,
        description: reward.description
      }
    });
    
  } catch (err) {
    console.error('Public reward claim error:', err);
    res.status(500).json({ success: false, error: 'Failed to claim reward' });
  }
});

/**
 * POST /p/:token/progress - Update progress for public participant
 */
router.post('/p/:token/progress', async (req, res) => {
  const { token: _token } = req.params;
  const { stepId, action } = req.body;
  
  try {
    const participantId = req.session.publicParticipantId;
    
    if (!participantId) {
      return res.status(400).json({ success: false, error: 'Invalid session' });
    }
    
    if (action === 'visit' && stepId) {
      await query(`
        UPDATE public_participants 
        SET current_step_id = $1,
            visited_steps = CASE 
              WHEN NOT ($2 = ANY(visited_steps)) 
              THEN array_append(visited_steps, $2)
              ELSE visited_steps
            END,
            updated_at = NOW()
        WHERE id = $3
      `, [stepId, stepId, participantId]);
    } else if (action === 'complete') {
      await query(`
        UPDATE public_participants 
        SET completed_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [participantId]);
    }
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('Public progress error:', err);
    res.status(500).json({ success: false, error: 'Failed to update progress' });
  }
});

/**
 * POST /p/:token/tts - Generate speech for step text (public journey)
 * No identification required (matches guide/chat); the journey token itself
 * grants access. The client falls back to the Web Speech API on errors.
 */
router.post('/p/:token/tts', playerTtsLimiter, async (req, res) => {
  const { token } = req.params;
  
  try {
    const journeyResult = await query(`
      SELECT j.id FROM journeys j
      WHERE j.public_token = $1 
        AND j.is_public = true 
        AND j.status = 'published'
        AND j.deleted_at IS NULL
    `, [token]);
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    return handleTtsRequest(req, res);
    
  } catch (err) {
    console.error('Public TTS error:', err);
    res.status(500).json({ success: false, error: 'TTS_ERROR' });
  }
});

/**
 * POST /p/:token/guide/chat - Chat with AI Guide for public journey
 * No identification required for guide chat
 */
router.post('/p/:token/guide/chat', playerAiLimiter, async (req, res) => {
  const { token } = req.params;
  const { guide_id, step_context, message, conversation_history, guide_language } = req.body;
  
  if (!token) {
    return res.status(400).json({ success: false, error: 'Invalid token' });
  }
  
  if (!guide_id || !message) {
    return res.status(400).json({ success: false, error: 'Guide ID and message are required' });
  }
  
  try {
    // Verify the public journey exists and get org info
    const journeyResult = await query(`
      SELECT j.id, j.organization_id, j.title, j.status, j.is_public
      FROM journeys j
      WHERE j.public_token = $1 
        AND j.is_public = true 
        AND j.status = 'published'
        AND j.deleted_at IS NULL
    `, [token]);
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const journey = journeyResult.rows[0];
    const orgId = journey.organization_id;
    
    // Out of AI questions: the player shows a calm message (or the static greeting)
    // and lets the end user continue
    if (!(await hasAiCreditsLeft(orgId, 'player'))) {
      return res.status(403).json({ success: false, code: 'AI_UNAVAILABLE' });
    }
    
    // Get guide info - verify it belongs to this organization
    const guideResult = await query(
      'SELECT * FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [guide_id, orgId]
    );
    
    if (guideResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }

    // Only guides used in this journey (or its nested journeys) can be asked
    if (!(await isGuideUsedInJourney(guide_id, journey.id))) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    const dbGuide = guideResult.rows[0];
    
    // Knowledge retrieval happens inside chatWithGuide (with similarity threshold)
    
    // Build guide object compatible with chatWithGuide function
    const guideObj = {
      name: dbGuide.name,
      role: dbGuide.role || 'Your Assistant',
      personality: dbGuide.personality || 'friendly',
      instructions: dbGuide.ai_instructions || '',
      topics: [],
      stepId: null,
      guideId: guide_id,
      organizationId: orgId,
      language: guide_language || 'en'
    };
    
    // Build conversation history array
    let historyArray = [];
    if (conversation_history) {
      if (Array.isArray(conversation_history)) {
        historyArray = conversation_history.map(msg => ({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content || ''
        }));
      } else if (typeof conversation_history === 'string') {
        const lines = conversation_history.split('\n').filter(l => l.trim());
        lines.forEach(line => {
          if (line.startsWith('User:')) {
            historyArray.push({ role: 'user', content: line.replace('User:', '').trim() });
          } else if (line.includes(':')) {
            historyArray.push({ role: 'assistant', content: line.split(':').slice(1).join(':').trim() });
          }
        });
      }
    }
    
    // Build journey context with media descriptions
    let journeyContext = step_context || '';
    
    // Enrich context with AI-generated descriptions of visual content
    const mediaDescriptions = await enrichContextWithMediaDescriptions(step_context);
    if (mediaDescriptions) {
      journeyContext += mediaDescriptions;
    }
    
    // Call the AI chat function
    const aiResult = await chatWithGuide(guideObj, message, historyArray, journeyContext);
    
    // Track AI credits if usage data is available
    if (aiResult.usage) {
      // 1 AI credit = 1 answered question
      await trackAiCredits(orgId, 1, {
        model: aiResult.usage.model,
        tokensInput: aiResult.usage.promptTokens,
        tokensOutput: aiResult.usage.completionTokens,
        guideId: guide_id,
        context: 'public_journey_chat'
      });
    }
    
    // Parse citations from response
    const citations = parseCitations(aiResult.response);
    const citationIds = [...new Set(citations.map(c => c.id))];
    
    // Get source information for citations
    let citationSources = [];
    if (citationIds.length > 0) {
      citationSources = await getCitationSources(citationIds, orgId);
    }
    
    res.json({ 
      success: true, 
      response: aiResult.response,
      citations: citations,
      citationSources: citationSources
    });
    
  } catch (err) {
    console.error('Public guide chat error:', err);
    res.status(500).json({ success: false, error: 'Failed to process chat' });
  }
});

/**
 * POST /p/:token/guide/opening - Generate dynamic guide opening for public journey
 * This endpoint generates a localized greeting for the AI Guide
 */
router.post('/p/:token/guide/opening', playerAiLimiter, async (req, res) => {
  const { token } = req.params;
  const { guide_id, guide_language, journey_context } = req.body;
  
  if (!token) {
    return res.status(400).json({ success: false, error: 'Invalid token' });
  }
  
  if (!guide_id) {
    return res.status(400).json({ success: false, error: 'Guide ID is required' });
  }
  
  try {
    // Verify the public journey exists
    const journeyResult = await query(`
      SELECT j.id, j.organization_id, j.title
      FROM journeys j
      WHERE j.public_token = $1 
        AND j.is_public = true 
        AND j.status = 'published'
        AND j.deleted_at IS NULL
    `, [token]);
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const journey = journeyResult.rows[0];
    const orgId = journey.organization_id;
    
    // Out of AI questions: the player shows a calm message (or the static greeting)
    // and lets the end user continue
    if (!(await hasAiCreditsLeft(orgId, 'player'))) {
      return res.status(403).json({ success: false, code: 'AI_UNAVAILABLE' });
    }
    
    // Get guide info
    const guideResult = await query(
      'SELECT * FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [guide_id, orgId]
    );
    
    if (guideResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }

    // Only guides used in this journey (or its nested journeys) can be asked
    if (!(await isGuideUsedInJourney(guide_id, journey.id))) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    const dbGuide = guideResult.rows[0];
    
    // Import generateGuideOpening
    const { generateGuideOpening } = await import('../services/mistral.js');
    
    // Build guide context with language override
    const guideContext = {
      name: dbGuide.name,
      role: dbGuide.role || 'Your Assistant',
      personality: dbGuide.personality || 'friendly',
      greeting: dbGuide.greeting || '',
      instructions: dbGuide.ai_instructions || '',
      language: guide_language || 'en'
    };
    
    // Generate AI opening and translate role in parallel for better performance
    const shouldTranslateRole = guide_language && guide_language !== 'en' && guideContext.role;
    
    let roleTranslationPromise;
    if (shouldTranslateRole) {
      const { translateText } = await import('../services/translation.js');
      roleTranslationPromise = translateText(guideContext.role, guide_language).catch(err => {
        console.warn('Failed to translate guide role:', err.message);
        return guideContext.role;
      });
    }
    
    // Generate opening in specified language
    const aiResult = await generateGuideOpening(guideContext, journey_context || '');
    
    // Wait for role translation (if started)
    const translatedRole = shouldTranslateRole 
      ? await roleTranslationPromise 
      : guideContext.role;
    
    res.json({ 
      success: true, 
      opening: aiResult.response,
      language: guide_language || 'en',
      guide: {
        name: guideContext.name,
        role: translatedRole,
        originalRole: guideContext.role
      }
    });
    
  } catch (err) {
    console.error('Public guide opening generation error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate opening' });
  }
});

// Gryffi Cloud routes (self signup) live in src/cloud/, which the Community Edition
// does not ship
if (isCloud()) {
  const cloud = await import('../cloud/index.js');
  cloud.registerSignupRoutes(router);
}

export default router;

