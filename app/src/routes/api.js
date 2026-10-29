/**
 * API Routes - Gryffi Hybrid Explorer
 * RESTful endpoints for builder and preview
 */
import { Router } from 'express';
import { query, getClient } from '../db/index.js';
import { requireApiAuth, isPlatformAdminEmail } from '../middleware/auth.js';
import { isCloud, isCommunity } from '../edition.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import i18next from 'i18next';
import { chatWithGuide, generateGuideOpening } from '../services/mistral.js';
import { searchPhotos, getCuratedPhotos, downloadPhoto, getSuggestedSearchTerms, ensureMediaDirectories } from '../services/pexels.js';
import { sendJourneyEmail, getEmailTemplates, getTemplateVariables, sendAutomationEmail, sendEmail, sendInvitationEmail } from '../services/email.js';
import {
  processAttachments, checkAttachmentImages, storeSubmissionFiles, resolveStoragePath as resolveFormFilePath,
  buildFormSubmissionEmailBody, buildFormSubmissionSubject, formatFileSize
} from '../services/formSubmissions.js';
import { 
  createKnowledgeSource, 
  processFile, 
  processText, 
  getKnowledgeSources, 
  deleteKnowledgeSource,
  updateTextKnowledgeSource,
  getKnowledgeStats,
  isFileTypeSupported,
  getSupportedFileTypes,
  parseDocument,
  formatKnowledgeError
} from '../services/knowledge.js';
import { buildJourneyPlan, computePlanLayout } from '../services/wizardJourney.js';
import { signOAuthState } from '../lib/oauthState.js';
import redis from '../db/redis.js';
import { isValidCountryCode } from '../utils/countries.js';
import { detectImageType } from '../utils/imageType.js';
import { getAppBaseUrl } from '../utils/appUrl.js';
import { encryptToken, decryptToken } from '../services/oauthTokens.js';
import {
  getAllTiers,
  getOrganizationUsage,
  getOrganizationUsageWithLimits,
  checkLimit,
  trackAiCredits,
  hasAiCreditsLeft,
  logUsageEvent,
  getPendingNotifications,
  acknowledgeNotification,
  isFeatureEnabled,
  getSyncEndUserAllowance,
  RESOURCE_TYPES,
  getOrganizationTier
} from '../services/subscription.js';
import { queueAnalysis, detectMediaType, getAnalysisDescription } from '../services/imageAnalysis.js';
import { isImageAllowed } from '../services/nsfwDetection.js';
import { searchHelp, generateHelpResponse, getHelpTopics } from '../services/help.js';
import { translateJourneyContent, getSupportedLanguages } from '../services/translation.js';
import { handleTtsRequest } from '../services/tts.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';
import sharp from 'sharp';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Helper function to get the filesystem path for a media URL
 * Supports both old (/media/organizations/...) and new (/uploads/organizations/...) URL structures
 * @param {string} url - The media URL from database
 * @returns {string} - The absolute filesystem path
 */
function getMediaFilePath(url) {
  if (!url || typeof url !== 'string') return null;

  // New structure: /uploads/... -> /app/uploads/...; old: /media/... -> /app/public/media/...
  let root;
  let relative;
  if (url.startsWith('/uploads/')) {
    root = path.resolve(__dirname, '../../uploads');
    relative = url.slice('/uploads/'.length);
  } else if (url.startsWith('/media/')) {
    root = path.resolve(__dirname, '../../public/media');
    relative = url.slice('/media/'.length);
  } else {
    return null;
  }
  // Never return a path outside the media directories (files get deleted with it)
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * Respond to an image that may not be stored: NSFW content (400) or a check
 * that could not run (503, the user can try again later).
 */
function rejectImage(req, res, reason) {
  if (reason === 'nsfw') {
    return res.status(400).json({
      success: false,
      error: req.t('errors.nsfw_content', 'This image appears to contain inappropriate content and cannot be uploaded.'),
      code: 'NSFW_CONTENT'
    });
  }
  return res.status(503).json({
    success: false,
    error: req.t('errors.image_check_unavailable', 'We could not check this image right now. Try again in a few minutes.'),
    code: 'IMAGE_CHECK_UNAVAILABLE'
  });
}

// Basic UUID v4-ish validation (accept any RFC4122 UUID)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

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
      // Get the URL (either captured group or full match)
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
      // Silently continue if description fetch fails
      console.debug('[MediaContext] Failed to get description for:', url.substring(0, 50));
    }
  }
  
  if (descriptions.length === 0) return '';
  
  // Format descriptions for the AI context
  return `\n\n=== VISUAL CONTENT DESCRIPTION ===
The user is viewing the following visual content:
${descriptions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

Use this information to help the user understand what they're seeing if relevant to their question.`;
}

// Configure multer for file uploads
// Media files are stored in /app/uploads/organizations/{orgId}/media/
// This maps to data/uploads/organizations/{orgId}/media/ on the host via Docker volume
// Uploads are buffered in memory first so the NSFW check can run before
// anything is written to disk.
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

/**
 * Generate a white/light version of a logo for dark backgrounds
 * Converts all non-transparent pixels to white while preserving transparency
 * @param {string} inputPath - Path to the original logo file
 * @param {string} outputPath - Path for the white version
 * @returns {Promise<boolean>} - Success status
 */
async function generateWhiteLogo(inputPath, outputPath) {
  try {
    // Read the image and get its metadata
    const image = sharp(inputPath);
    const _metadata = await image.metadata(); // Needed for sharp pipeline initialization
    
    // Get raw pixel data
    const { data, info } = await image
      .ensureAlpha() // Ensure we have an alpha channel
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    // Create a new buffer for the white version
    const whiteData = Buffer.alloc(data.length);
    
    // Process each pixel (4 bytes per pixel: R, G, B, A)
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      
      if (alpha > 0) {
        // Non-transparent pixel: make it white
        whiteData[i] = 255;     // R
        whiteData[i + 1] = 255; // G
        whiteData[i + 2] = 255; // B
        whiteData[i + 3] = alpha; // Keep original alpha
      } else {
        // Fully transparent pixel: keep transparent
        whiteData[i] = 0;
        whiteData[i + 1] = 0;
        whiteData[i + 2] = 0;
        whiteData[i + 3] = 0;
      }
    }
    
    // Create the white version
    await sharp(whiteData, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4
      }
    })
      .png() // Output as PNG to preserve transparency
      .toFile(outputPath);
    
    console.log(`[Logo] Generated white version: ${outputPath}`);
    return true;
  } catch (err) {
    console.error('[Logo] Error generating white logo:', err);
    return false;
  }
}

// Knowledge uploads storage (separate from media)
const knowledgeStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../../uploads/knowledge');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `${crypto.randomUUID()}${ext}`;
    cb(null, filename);
  }
});

const knowledgeUpload = multer({
  storage: knowledgeStorage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max for documents
  },
  fileFilter: (req, file, cb) => {
    if (isFileTypeSupported(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  }
});

// Spreadsheet upload storage (memory only - no file storage)
const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max for spreadsheets
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.spreadsheet'
    ];
    const allowedExtensions = ['.csv', '.xls', '.xlsx', '.ods'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('INVALID_FILE_TYPE'));
    }
  }
});

const router = Router();

// ===== LANGUAGE ROUTES (Public - no auth required) =====
// These routes must be before requireApiAuth so they work on login page

// Change user language preference (works for both logged in and logged out users)
router.post('/language', async (req, res) => {
  try {
    const { language } = req.body;
    const supportedLanguages = ['en', 'nl', 'de', 'fr', 'es'];
    
    if (!language || !supportedLanguages.includes(language)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid language. Supported: ' + supportedLanguages.join(', ') 
      });
    }
    
    // Set language in session
    if (req.session) {
      req.session.language = language;
    }
    
    // Set language cookie (1 year expiry)
    res.cookie('i18next', language, { 
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: false, // Allow JS to read it
      sameSite: 'lax',
      path: '/' // Important: cookie must be sent for all paths, not just /api
    });
    
    // Change i18next language for this request
    await req.i18n.changeLanguage(language);
    
    res.json({ 
      success: true, 
      language,
      message: 'Language changed successfully'
    });
  } catch (err) {
    console.error('Language change error:', err);
    res.status(500).json({ success: false, error: 'Failed to change language' });
  }
});

// Get current language and available languages (public)
router.get('/language', (req, res) => {
  const supportedLanguages = ['en', 'nl', 'de', 'fr', 'es'];
  const languageNames = {
    en: 'English',
    nl: 'Nederlands',
    de: 'Deutsch',
    fr: 'Français',
    es: 'Español'
  };
  
  res.json({
    success: true,
    current: req.language || 'en',
    supported: supportedLanguages,
    names: languageNames
  });
});

// ===== PUBLIC ROUTES (for end-users via magic-link) =====
// These routes must be before requireApiAuth so expedition users can access them

/**
 * GET /api/themes/public/:orgId - Get active theme for an organization (public route for magic-link users)
 */
router.get('/themes/public/:orgId', async (req, res) => {
  try {
    const orgId = req.params.orgId;
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(orgId)) {
      return res.status(400).json({ success: false, error: 'Invalid organization ID' });
    }
    
    // Get active theme for organization
    const result = await query(`
      SELECT t.id, t.name, t.logo_url, t.tokens, t.is_preset, t.preset_key
      FROM themes t
      JOIN organizations o ON o.active_theme_id = t.id
      WHERE o.id = $1
    `, [orgId]);
    
    if (result.rows.length === 0) {
      // Return default theme
      return res.json({
        success: true,
        theme: null,
        isDefault: true
      });
    }
    
    res.json({
      success: true,
      theme: result.rows[0],
      isDefault: false
    });
  } catch (err) {
    console.error('Public theme get error:', err);
    res.status(500).json({ success: false, error: 'Failed to get theme' });
  }
});

/**
 * GET /api/floorplans/public/:id - Get a floorplan (public route for magic-link users)
 * Only returns basic info needed for display - no sensitive data.
 * Scoped to the organization the caller belongs to (session or magic link).
 */
router.get('/floorplans/public/:id', async (req, res) => {
  try {
    const floorplanId = req.params.id;
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(floorplanId)) {
      return res.status(400).json({ success: false, error: 'Invalid floorplan ID' });
    }
    
    // Determine caller's organization from session (logged-in user, magic link, or public participant)
    let callerOrgId = req.session?.organization?.id || req.session?.publicOrgId;
    
    // For magic-link sessions: resolve org from the journey
    if (!callerOrgId && req.session?.expedition?.journeyId) {
      const journeyOrg = await query(
        'SELECT organization_id FROM journeys WHERE id = $1',
        [req.session.expedition.journeyId]
      );
      if (journeyOrg.rows.length > 0) {
        callerOrgId = journeyOrg.rows[0].organization_id;
      }
    }
    
    let result;
    if (callerOrgId) {
      result = await query(`
        SELECT id, name, description, image_url, width, height
        FROM floorplans 
        WHERE id = $1 AND organization_id = $2
      `, [floorplanId, callerOrgId]);
    } else {
      // Fallback for public journeys without session: verify the floorplan belongs to an org with public journeys
      result = await query(`
        SELECT f.id, f.name, f.description, f.image_url, f.width, f.height
        FROM floorplans f
        INNER JOIN journeys j ON j.organization_id = f.organization_id AND j.is_public = true
        WHERE f.id = $1
        LIMIT 1
      `, [floorplanId]);
    }
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Floorplan not found' });
    }
    
    res.json({
      success: true,
      floorplan: result.rows[0]
    });
  } catch (err) {
    console.error('Public floorplan get error:', err);
    res.status(500).json({ success: false, error: 'Failed to get floorplan' });
  }
});

/**
 * POST /api/polls/:stepId/vote - Submit a poll vote (for expedition/player mode)
 * Public route - end-users vote via magic-link without dashboard authentication
 */
/**
 * Access check for the poll routes, which run before requireApiAuth so end
 * users can use them. Returns who may act on this step's poll: a maker of the
 * step's organization, or an end user whose magic-link session opened the
 * given invitation of that organization.
 * @returns {Promise<{orgId: string, isMaker: boolean, invitationOk: boolean}|null>}
 */
async function getPollAccess(req, stepId, invitationId) {
  const step = await query(
    'SELECT j.organization_id FROM steps s JOIN journeys j ON j.id = s.journey_id WHERE s.id = $1',
    [stepId]
  );
  if (step.rows.length === 0) return null;
  const orgId = step.rows[0].organization_id;
  const isMaker = !!req.session?.user && req.session?.organization?.id === orgId;

  let invitationOk = false;
  if (invitationId && isUuid(invitationId)) {
    const inv = await query('SELECT token, organization_id FROM invitations WHERE id = $1', [invitationId]);
    const row = inv.rows[0];
    const sessionTokens = req.session?.verifiedExpeditionTokens || [];
    invitationOk = !!row && row.organization_id === orgId &&
      (sessionTokens.includes(row.token) || req.session?.expedition?.invitationId === invitationId);
  }
  return { orgId, isMaker, invitationOk };
}

router.post('/polls/:stepId/vote', async (req, res) => {
  try {
    const { stepId } = req.params;
    const { selectedOptions, invitationId, sessionId } = req.body;
    
    // Skip poll votes for demo journeys (demo steps don't have real polls)
    if (stepId && stepId.startsWith('demo-')) {
      return res.json({ success: true, demo: true, message: 'Demo poll vote skipped' });
    }
    
    if (!isUuid(stepId)) {
      return res.status(400).json({ success: false, error: 'Invalid step ID' });
    }
    
    if (invitationId && !isUuid(invitationId)) {
      return res.status(400).json({ success: false, error: 'Invalid invitation ID' });
    }
    
    if (!Array.isArray(selectedOptions) || selectedOptions.length === 0) {
      return res.status(400).json({ success: false, error: 'No options selected' });
    }

    // Only an end user whose session opened this invitation may vote
    const access = await getPollAccess(req, stepId, invitationId);
    if (!access) {
      return res.status(404).json({ success: false, error: 'Poll not found' });
    }
    if (!access.invitationOk) {
      return res.status(403).json({ success: false, error: 'Not allowed to vote on this poll' });
    }
    
    const sanitizedOptions = selectedOptions.map(o => parseInt(o, 10)).filter(n => !isNaN(n) && n >= 0 && n < 50);
    if (sanitizedOptions.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid options' });
    }
    
    // Get poll record and organization
    const pollResult = await query(`
      SELECT p.id, p.organization_id, s.basic_props
      FROM polls p
      JOIN steps s ON p.step_id = s.id
      WHERE p.step_id = $1
    `, [stepId]);
    
    let pollId, orgId;
    
    if (pollResult.rows.length === 0) {
      // Poll record doesn't exist yet, create it
      const stepCheck = await query(`
        SELECT s.id, j.organization_id
        FROM steps s
        JOIN journeys j ON s.journey_id = j.id
        WHERE s.id = $1 AND s.type = 'poll'
      `, [stepId]);
      
      if (stepCheck.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Poll not found' });
      }
      
      orgId = stepCheck.rows[0].organization_id;
      const newPoll = await query(
        'INSERT INTO polls (organization_id, step_id) VALUES ($1, $2) RETURNING id',
        [orgId, stepId]
      );
      pollId = newPoll.rows[0].id;
    } else {
      pollId = pollResult.rows[0].id;
      orgId = pollResult.rows[0].organization_id;
    }
    
    // Check if already voted (by invitation or session)
    if (invitationId) {
      const existingVote = await query(
        'SELECT id FROM poll_responses WHERE poll_id = $1 AND invitation_id = $2',
        [pollId, invitationId]
      );
      
      if (existingVote.rows.length > 0) {
        return res.status(400).json({ success: false, error: 'Already voted', alreadyVoted: true });
      }
    }
    
    // Insert vote - cast JavaScript array to PostgreSQL integer array
    await query(`
      INSERT INTO poll_responses (poll_id, organization_id, invitation_id, session_id, selected_options)
      VALUES ($1, $2, $3, $4, $5::integer[])
    `, [pollId, orgId, invitationId || null, sessionId || null, sanitizedOptions]);
    
    // Get updated results
    const responsesResult = await query(`
      SELECT 
        unnest(selected_options) as option_index,
        COUNT(*) as vote_count
      FROM poll_responses
      WHERE poll_id = $1
      GROUP BY option_index
      ORDER BY option_index
    `, [pollId]);
    
    const totalResult = await query(
      'SELECT COUNT(*) as total FROM poll_responses WHERE poll_id = $1',
      [pollId]
    );
    
    const votes = {};
    responsesResult.rows.forEach(row => {
      votes[row.option_index] = parseInt(row.vote_count);
    });
    
    res.json({
      success: true,
      votes,
      totalRespondents: parseInt(totalResult.rows[0].total)
    });
    
  } catch (err) {
    console.error('API poll vote error:', err);
    res.status(500).json({ success: false, error: 'Failed to submit vote' });
  }
});

/**
 * GET /api/polls/:stepId/results - Get poll results (for expedition/player mode)
 * Public route - end-users can view results after voting
 */
router.get('/polls/:stepId/results', async (req, res) => {
  try {
    const { stepId } = req.params;
    
    // Skip poll results for demo journeys (demo steps don't have real polls)
    if (stepId && stepId.startsWith('demo-')) {
      return res.json({ success: true, results: null, demo: true });
    }

    if (!isUuid(stepId)) {
      return res.status(400).json({ success: false, error: 'Invalid step ID' });
    }
    const access = await getPollAccess(req, stepId, req.session?.expedition?.invitationId);
    if (!access || (!access.isMaker && !access.invitationOk)) {
      return res.status(403).json({ success: false, error: 'Not allowed to view these results' });
    }
    
    // Get poll record
    const pollResult = await query(`
      SELECT p.id, s.basic_props
      FROM polls p
      JOIN steps s ON p.step_id = s.id
      WHERE p.step_id = $1
    `, [stepId]);
    
    if (pollResult.rows.length === 0) {
      return res.json({ success: true, results: null });
    }
    
    const pollId = pollResult.rows[0].id;
    
    // Get vote counts per option
    const responsesResult = await query(`
      SELECT 
        unnest(selected_options) as option_index,
        COUNT(*) as vote_count
      FROM poll_responses
      WHERE poll_id = $1
      GROUP BY option_index
      ORDER BY option_index
    `, [pollId]);
    
    const totalResult = await query(
      'SELECT COUNT(*) as total FROM poll_responses WHERE poll_id = $1',
      [pollId]
    );
    
    // Convert to option ID based format
    const basicProps = typeof pollResult.rows[0].basic_props === 'string' 
      ? JSON.parse(pollResult.rows[0].basic_props) 
      : pollResult.rows[0].basic_props;
    const options = basicProps?.options || [];
    
    const optionVotes = {};
    responsesResult.rows.forEach(row => {
      const optionIndex = parseInt(row.option_index);
      if (options[optionIndex]) {
        optionVotes[options[optionIndex].id] = parseInt(row.vote_count);
      }
    });
    
    res.json({
      success: true,
      results: {
        totalVotes: parseInt(totalResult.rows[0].total),
        optionVotes
      }
    });
    
  } catch (err) {
    console.error('API poll results error:', err);
    res.status(500).json({ success: false, error: 'Failed to get results' });
  }
});

/**
 * GET /api/polls/:stepId/check-vote - Check if user has already voted
 * Public route - called when loading poll step to determine UI state
 * Returns: hasVoted, userVotes (which options selected), and results if applicable
 */
router.get('/polls/:stepId/check-vote', async (req, res) => {
  try {
    const { stepId } = req.params;
    const { invitationId } = req.query;
    
    if (!invitationId || !isUuid(invitationId)) {
      // No valid invitation ID = anonymous user, can't track voting
      return res.json({ success: true, hasVoted: false });
    }
    
    if (!isUuid(stepId)) {
      return res.json({ success: true, hasVoted: false });
    }

    // Someone else's vote is private: only the session that opened this invitation may ask
    const access = await getPollAccess(req, stepId, invitationId);
    if (!access || !access.invitationOk) {
      return res.status(403).json({ success: false, error: 'Not allowed' });
    }
    
    // Get poll record and settings
    const pollResult = await query(`
      SELECT p.id, s.basic_props
      FROM polls p
      JOIN steps s ON p.step_id = s.id
      WHERE p.step_id = $1
    `, [stepId]);
    
    if (pollResult.rows.length === 0) {
      // Poll doesn't exist yet (no votes), user hasn't voted
      return res.json({ success: true, hasVoted: false });
    }
    
    const pollId = pollResult.rows[0].id;
    // Poll results are always shown after voting (show_results setting removed)
    const showResults = true;
    
    // Check if this invitation has already voted
    const voteResult = await query(
      'SELECT selected_options FROM poll_responses WHERE poll_id = $1 AND invitation_id = $2',
      [pollId, invitationId]
    );
    
    if (voteResult.rows.length === 0) {
      return res.json({ success: true, hasVoted: false });
    }
    
    // User has voted - get their selection
    const userVotes = voteResult.rows[0].selected_options;
    
    // Return the poll results (always shown after voting)
    const votes = {};
    let totalRespondents = 0;
    
    {
      const responsesResult = await query(`
        SELECT 
          unnest(selected_options) as option_index,
          COUNT(*) as vote_count
        FROM poll_responses
        WHERE poll_id = $1
        GROUP BY option_index
        ORDER BY option_index
      `, [pollId]);
      
      const totalResult = await query(
        'SELECT COUNT(*) as total FROM poll_responses WHERE poll_id = $1',
        [pollId]
      );
      
      responsesResult.rows.forEach(row => {
        votes[row.option_index] = parseInt(row.vote_count);
      });
      totalRespondents = parseInt(totalResult.rows[0].total);
    }
    
    res.json({
      success: true,
      hasVoted: true,
      userVotes,
      showResults,
      votes,
      totalRespondents
    });
    
  } catch (err) {
    console.error('API poll check-vote error:', err);
    res.status(500).json({ success: false, error: 'Failed to check vote status' });
  }
});

// Apply API auth to all routes below this point
router.use(requireApiAuth);

// Role-based access (simple + safe defaults)
// Viewer users are read-only (except language + own account + chat)
router.use((req, res, next) => {
  const role = req.user?.role;
  if (role !== 'viewer') return next();

  // Viewer should never access Team endpoints (even read-only)
  if (req.path.startsWith('/team')) {
    return res.status(403).json({
      success: false,
      message: req.t('team.messages.teamAccessDenied')
    });
  }

  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) return next();

  // Own account settings stay writable: consent must always be withdrawable
  const allowWritePaths = [
    '/language', '/me', '/me/password', '/me/marketing-consent', '/me/lifecycle-emails', '/me/two-factor',
    '/chat/guide', '/tts'
  ];
  if (allowWritePaths.includes(req.path)) return next();

  return res.status(403).json({
    success: false,
    message: req.t('team.messages.viewerReadOnly')
  });
});

/**
 * POST /api/tts - Generate speech for step text (journey previews)
 * Used by the builder preview and fullscreen preview for logged-in makers.
 * Same Voxtral pipeline as the player endpoints; see services/tts.js.
 */
router.post('/tts', handleTtsRequest);

// ============================================
// JOURNEYS
// ============================================

/**
 * GET /api/journeys/:id - Get journey with all data
 */
router.get('/journeys/:id', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;
    
    // Get journey
    const journey = await query(`
      SELECT * FROM journeys 
      WHERE id = $1 AND organization_id = $2
    `, [journeyId, orgId]);
    
    if (journey.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    // Get all related data in parallel
    const [steps, paths, resources] = await Promise.all([
      query('SELECT * FROM steps WHERE journey_id = $1 ORDER BY created_at', [journeyId]),
      query('SELECT * FROM paths WHERE journey_id = $1 ORDER BY sort_order', [journeyId]),
      query('SELECT * FROM resources WHERE journey_id = $1 ORDER BY name', [journeyId])
    ]);
    
    // Parse journey settings and extract convenience fields
    const journeyData = journey.rows[0];
    if (journeyData.settings && typeof journeyData.settings === 'string') {
      journeyData.settings = JSON.parse(journeyData.settings);
    }
    journeyData.automations = journeyData.settings?.automations || [];
    journeyData.welcome_message = journeyData.settings?.welcome_message || '';
    journeyData.completion_message = journeyData.settings?.completion_message || '';
    journeyData.allow_skip = journeyData.settings?.allow_skip || false;
    journeyData.track_progress = journeyData.settings?.track_progress !== false;
    journeyData.language_override = journeyData.settings?.language_override || false;
    journeyData.language_code = journeyData.settings?.language_code || null;
    journeyData.guide_language_override = journeyData.settings?.guide_language_override || false;
    journeyData.guide_language_code = journeyData.settings?.guide_language_code || null;
    journeyData.guide_opening_override = journeyData.settings?.guide_opening_override || '';
    
    res.json({
      success: true,
      journey: journeyData,
      steps: steps.rows,
      paths: paths.rows,
      resources: resources.rows
    });
    
  } catch (err) {
    console.error('API get journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to load journey' });
  }
});

/**
 * PUT /api/journeys/:id - Update journey
 */
router.put('/journeys/:id', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;
    const { 
      title, 
      description, 
      status, 
      guide_id,
      settings,
      automations,
      welcome_message,
      completion_message,
      allow_skip,
      track_progress,
      language_override,
      language_code,
      guide_language_override,
      guide_language_code,
      guide_opening_override
    } = req.body;

    // Publishing permission: only manager/admin
    if (status === 'published' && (req.user?.role === 'member')) {
      return res.status(403).json({ success: false, message: req.t('team.messages.publishNotAllowed') });
    }

    // Check if journey is used as nested journey when trying to unpublish
    if (status === 'draft') {
      const currentJourney = await query(
        `SELECT status FROM journeys WHERE id = $1 AND organization_id = $2`,
        [journeyId, orgId]
      );
      
      if (currentJourney.rows.length > 0 && currentJourney.rows[0].status === 'published') {
        const nestedUsage = await query(`
          SELECT j.id, j.title 
          FROM steps s
          JOIN journeys j ON s.journey_id = j.id
          WHERE s.type = 'nested_journey' 
          AND s.basic_props->>'nested_journey_id' = $1
          AND j.status = 'published'
          AND j.organization_id = $2
        `, [journeyId, orgId]);
        
        if (nestedUsage.rows.length > 0) {
          const errorMessage = nestedUsage.rows.length === 1
            ? req.t('journeys.actions.cannotUnpublishNested', { journeyTitle: nestedUsage.rows[0].title })
            : req.t('journeys.actions.cannotUnpublishNestedMultiple', { count: nestedUsage.rows.length });
          
          return res.status(400).json({
            success: false,
            error: errorMessage,
            code: 'USED_AS_NESTED',
            usedBy: nestedUsage.rows
          });
        }
      }
    }

    // Archive mode removed: treat 'archived' as 'draft' (use trash instead)
    const effectiveStatus = status === 'archived' ? 'draft' : status;
    
    // Check for start and end steps when publishing
    if (status === 'published') {
      const stepsResult = await query(
        `SELECT id, is_start, is_end FROM steps WHERE journey_id = $1`,
        [journeyId]
      );
      
      const hasStartStep = stepsResult.rows.some(s => s.is_start);
      const hasEndStep = stepsResult.rows.some(s => s.is_end);
      
      if (!hasStartStep) {
        return res.status(400).json({ 
          success: false, 
          error: req.t('journeys.publish.noStartStep'),
          code: 'NO_START_STEP'
        });
      }
      
      if (!hasEndStep) {
        return res.status(400).json({ 
          success: false, 
          error: req.t('journeys.publish.noEndStep'),
          code: 'NO_END_STEP'
        });
      }
    }
    
    // Fetch existing settings to preserve them when not all fields are sent
    const existingJourney = await query(
      `SELECT settings FROM journeys WHERE id = $1 AND organization_id = $2`,
      [journeyId, orgId]
    );
    
    if (existingJourney.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    // Parse existing settings
    const existingSettings = typeof existingJourney.rows[0].settings === 'string'
      ? JSON.parse(existingJourney.rows[0].settings)
      : (existingJourney.rows[0].settings || {});
    
    // Build settings object by merging existing settings with any new values
    // Start with existing settings to preserve all values
    const settingsObj = { ...existingSettings };
    
    // Only override if explicitly provided in request
    if (settings && typeof settings === 'object') {
      Object.assign(settingsObj, settings);
    }
    if (automations !== undefined) settingsObj.automations = automations;
    if (welcome_message !== undefined) settingsObj.welcome_message = welcome_message;
    if (completion_message !== undefined) settingsObj.completion_message = completion_message;
    if (allow_skip !== undefined) settingsObj.allow_skip = allow_skip;
    if (track_progress !== undefined) settingsObj.track_progress = track_progress;
    if (language_override !== undefined) settingsObj.language_override = language_override;
    if (language_code !== undefined) settingsObj.language_code = language_code;
    if (guide_language_override !== undefined) settingsObj.guide_language_override = guide_language_override;
    if (guide_language_code !== undefined) settingsObj.guide_language_code = guide_language_code;
    if (guide_opening_override !== undefined) settingsObj.guide_opening_override = guide_opening_override;
    
    console.log('[Journey Update] Preserving settings - language_override:', settingsObj.language_override, 
      'guide_language_override:', settingsObj.guide_language_override);
    
    // Only change the journey guide when the request explicitly sends guide_id
    // (most saves do not, and used to wipe it). A new guide must belong to this org.
    const guideIdProvided = Object.prototype.hasOwnProperty.call(req.body, 'guide_id');
    if (guideIdProvided && guide_id) {
      const guideCheck = await query(
        'SELECT 1 FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [guide_id, orgId]
      );
      if (guideCheck.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Guide not found' });
      }
    }

    const result = await query(`
      UPDATE journeys 
      SET title = COALESCE($1, title),
          description = COALESCE($2, description),
          status = COALESCE($3, status),
          settings = COALESCE($4, settings),
          guide_id = CASE WHEN $8::boolean THEN $5::uuid ELSE guide_id END,
          updated_at = NOW()
      WHERE id = $6 AND organization_id = $7
      RETURNING *
    `, [title, description, effectiveStatus, JSON.stringify(settingsObj), guide_id || null, journeyId, orgId, guideIdProvided]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    // Parse settings back for response
    const journey = result.rows[0];
    if (journey.settings && typeof journey.settings === 'string') {
      journey.settings = JSON.parse(journey.settings);
    }
    journey.automations = journey.settings?.automations || [];
    journey.welcome_message = journey.settings?.welcome_message || '';
    journey.completion_message = journey.settings?.completion_message || '';
    journey.allow_skip = journey.settings?.allow_skip || false;
    journey.track_progress = journey.settings?.track_progress !== false;
    journey.language_override = journey.settings?.language_override || false;
    journey.language_code = journey.settings?.language_code || null;
    journey.guide_language_override = journey.settings?.guide_language_override || false;
    journey.guide_language_code = journey.settings?.guide_language_code || null;
    journey.guide_opening_override = journey.settings?.guide_opening_override || '';
    
    res.json({ success: true, journey });
    
  } catch (err) {
    console.error('API update journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to update journey' });
  }
});

/**
 * GET /api/journeys/:id/impact - Get impact analysis before deletion/unpublishing
 */
router.get('/journeys/:id/impact', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;
    
    // Get journey details
    const journeyResult = await query(
      'SELECT id, title, status FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [journeyId, orgId]
    );
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const journey = journeyResult.rows[0];
    
    // Get active invitations count
    const invitationsResult = await query(`
      SELECT COUNT(*) as count FROM invitations 
      WHERE journey_id = $1 AND status = 'pending' 
      AND (expires_at IS NULL OR expires_at > NOW())
    `, [journeyId]);
    const activeInvitations = parseInt(invitationsResult.rows[0].count) || 0;
    
    // Get rewards with their claim status
    const rewardsResult = await query(`
      SELECT 
        r.id,
        r.title,
        r.valid_until,
        r.is_random_codes,
        r.max_recipients,
        s.title as step_title,
        (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id AND is_claimed = true) as claimed_count,
        (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id AND is_claimed = false) as unclaimed_count
      FROM rewards r
      JOIN steps s ON r.step_id = s.id
      WHERE r.journey_id = $1 AND r.is_archived = false
    `, [journeyId]);
    
    const rewards = rewardsResult.rows.map(r => ({
      id: r.id,
      title: r.title,
      stepTitle: r.step_title,
      validUntil: r.valid_until,
      isRandomCodes: r.is_random_codes,
      maxRecipients: r.max_recipients,
      claimedCount: parseInt(r.claimed_count) || 0,
      unclaimedCount: parseInt(r.unclaimed_count) || 0
    }));
    
    const totalClaimedCodes = rewards.reduce((sum, r) => sum + r.claimedCount, 0);
    const totalUnclaimedCodes = rewards.reduce((sum, r) => sum + r.unclaimedCount, 0);
    const hasActiveRewards = rewards.some(r => r.claimedCount > 0 || (r.validUntil && new Date(r.validUntil) > new Date()));
    
    // Get polls with their response counts
    const pollsResult = await query(`
      SELECT 
        p.id,
        s.title as step_title,
        s.basic_props->>'question' as question,
        (SELECT COUNT(*) FROM poll_responses WHERE poll_id = p.id) as response_count
      FROM polls p
      JOIN steps s ON p.step_id = s.id
      WHERE s.journey_id = $1 AND (p.is_archived = false OR p.is_archived IS NULL)
    `, [journeyId]);
    
    const polls = pollsResult.rows.map(p => ({
      id: p.id,
      stepTitle: p.step_title,
      question: p.question || p.step_title,
      responseCount: parseInt(p.response_count) || 0
    }));
    
    const totalPollResponses = polls.reduce((sum, p) => sum + p.responseCount, 0);
    const hasPolls = polls.length > 0;
    
    res.json({
      success: true,
      journey: {
        id: journey.id,
        title: journey.title,
        status: journey.status,
        isPublished: journey.status === 'published'
      },
      impact: {
        activeInvitations,
        rewards,
        totalClaimedCodes,
        totalUnclaimedCodes,
        hasActiveRewards,
        polls,
        totalPollResponses,
        hasPolls,
        canDelete: journey.status !== 'published',
        mustUnpublishFirst: journey.status === 'published'
      }
    });
    
  } catch (err) {
    console.error('API journey impact error:', err);
    res.status(500).json({ success: false, error: 'Failed to get journey impact' });
  }
});

/**
 * GET /api/journeys/:id/available-for-nesting - Get journeys that can be nested
 * Returns published journeys excluding the current one and any that would create circular references
 * 
 * SECURITY RULES:
 * - Public parent journey → only public + published sub-journeys (to prevent private info leaking)
 * - Private parent journey → all published journeys (public or private) can be used
 */
router.get('/journeys/:id/available-for-nesting', async (req, res) => {
  try {
    const currentJourneyId = req.params.id;
    const orgId = req.organizationId;

    // The demo journey (id "demo-...") is not a journey of the organization
    if (!isUuid(currentJourneyId)) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    // First, check if the current journey is public
    const currentJourneyResult = await query(`
      SELECT is_public FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
    `, [currentJourneyId, orgId]);
    
    if (currentJourneyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const isParentPublic = currentJourneyResult.rows[0].is_public;
    
    // Build query based on parent journey visibility
    let queryText = `
      SELECT 
        j.id, 
        j.title, 
        j.description,
        j.cover_image_url,
        j.is_public,
        (SELECT COUNT(*) FROM steps WHERE journey_id = j.id) as step_count
      FROM journeys j
      WHERE j.organization_id = $1 
      AND j.status = 'published' 
      AND j.deleted_at IS NULL
      AND j.id != $2
    `;
    
    // For PUBLIC parent journeys, only allow PUBLIC sub-journeys (security)
    // For PRIVATE parent journeys, allow all published journeys (public or private)
    if (isParentPublic) {
      queryText += ` AND j.is_public = true`;
    }
    
    queryText += ` ORDER BY j.title ASC`;
    
    const journeysResult = await query(queryText, [orgId, currentJourneyId]);
    
    // Filter out journeys that would create circular references
    const availableJourneys = [];
    
    for (const journey of journeysResult.rows) {
      const wouldCreateCircular = await checkCircularReference(currentJourneyId, journey.id, orgId);
      if (!wouldCreateCircular) {
        availableJourneys.push({
          id: journey.id,
          title: journey.title,
          description: journey.description,
          cover_image_url: journey.cover_image_url,
          step_count: parseInt(journey.step_count) || 0,
          is_public: journey.is_public
        });
      }
    }
    
    res.json({ 
      success: true, 
      journeys: availableJourneys,
      parentIsPublic: isParentPublic
    });
    
  } catch (err) {
    console.error('API available journeys error:', err);
    res.status(500).json({ success: false, error: 'Failed to get available journeys' });
  }
});

/**
 * Check if nesting targetJourneyId in currentJourneyId would create a circular reference
 */
async function checkCircularReference(currentJourneyId, targetJourneyId, orgId, visited = new Set()) {
  if (visited.has(targetJourneyId)) return true;
  if (targetJourneyId === currentJourneyId) return true;
  
  visited.add(targetJourneyId);
  
  // Find all nested journeys within the target journey
  const nestedSteps = await query(`
    SELECT basic_props->>'nested_journey_id' as nested_id 
    FROM steps 
    WHERE journey_id = $1 
    AND type = 'nested_journey'
    AND basic_props->>'nested_journey_id' IS NOT NULL
  `, [targetJourneyId]);
  
  for (const step of nestedSteps.rows) {
    if (step.nested_id) {
      const isCircular = await checkCircularReference(currentJourneyId, step.nested_id, orgId, visited);
      if (isCircular) return true;
    }
  }
  
  return false;
}

/**
 * GET /api/journeys/:id/nested-preview/:nestedId - Get nested journey data for builder preview
 * Used when previewing a journey with nested journey steps in the builder
 */
router.get('/journeys/:id/nested-preview/:nestedId', async (req, res) => {
  try {
    const nestedJourneyId = req.params.nestedId;
    const orgId = req.organizationId;
    
    // Verify the nested journey exists and belongs to same organization
    const nestedJourneyResult = await query(`
      SELECT 
        j.id, j.title, j.description, j.cover_image_url, j.settings, j.status
      FROM journeys j
      WHERE j.id = $1 AND j.organization_id = $2 AND j.deleted_at IS NULL
    `, [nestedJourneyId, orgId]);
    
    if (nestedJourneyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Nested journey not found' });
    }
    
    const nestedJourney = nestedJourneyResult.rows[0];
    
    // Load nested journey steps and paths
    const stepsResult = await query(
      `SELECT * FROM steps WHERE journey_id = $1 ORDER BY position_y, position_x`,
      [nestedJourneyId]
    );
    
    const pathsResult = await query(
      `SELECT * FROM paths WHERE journey_id = $1 ORDER BY sort_order`,
      [nestedJourneyId]
    );
    
    const resourcesResult = await query(
      `SELECT * FROM resources WHERE journey_id = $1`,
      [nestedJourneyId]
    );
    
    // Get guides for this organization
    const guidesResult = await query(
      `SELECT * FROM guides WHERE organization_id = $1`,
      [orgId]
    );
    
    // Find start step
    const startStep = stepsResult.rows.find(s => s.is_start) || stepsResult.rows[0];
    
    // Parse settings
    const nestedSettings = typeof nestedJourney.settings === 'string' 
      ? JSON.parse(nestedJourney.settings) 
      : (nestedJourney.settings || {});
    
    // Get organization default language
    const orgResult = await query(`SELECT settings FROM organizations WHERE id = $1`, [orgId]);
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
        status: nestedJourney.status,
        language_override: nestedSettings.language_override,
        language_code: nestedSettings.language_code
      },
      steps: stepsResult.rows,
      paths: pathsResult.rows,
      resources: resourcesResult.rows,
      guides: guidesResult.rows,
      startStepId: startStep?.id,
      translations: nestedTranslations,
      language: nestedLanguage
    });
    
  } catch (err) {
    console.error('API nested preview error:', err);
    res.status(500).json({ success: false, error: 'Failed to get nested journey data' });
  }
});

/**
 * GET /api/translations/:language - Get translations for a specific language
 * Used for dynamic language switching in nested journeys
 */
router.get('/translations/:language', async (req, res) => {
  try {
    const language = req.params.language || 'en';
    
    // Validate language code
    const supportedLanguages = ['en', 'nl', 'de', 'fr', 'es'];
    const langCode = supportedLanguages.includes(language) ? language : 'en';
    
    // Get translations for the requested language
    const t = i18next.getFixedT(langCode);
    const translations = {
      builder: t('builder', { returnObjects: true }),
      common: t('common', { returnObjects: true }),
      journeys: t('journeys', { returnObjects: true }),
      imagePicker: t('imagePicker', { returnObjects: true }),
      resourcePicker: t('resourcePicker', { returnObjects: true }),
      cropper: t('cropper', { returnObjects: true })
    };
    
    res.json({
      success: true,
      language: langCode,
      translations: translations
    });
    
  } catch (err) {
    console.error('API translations error:', err);
    res.status(500).json({ success: false, error: 'Failed to get translations' });
  }
});

/**
 * DELETE /api/journeys/:id - Soft delete journey (move to trash)
 * Only admin and manager can delete
 * Published journeys must be unpublished first
 */
router.delete('/journeys/:id', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;
    const userRole = req.user?.role;
    const { confirmRewardsArchive, archivePolls } = req.body; // archivePolls: true = archive, false = delete

    // Check permissions: only admin and manager can delete
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ 
        success: false, 
        error: req.t('journeys.delete.noPermission') 
      });
    }

    // Verify journey belongs to organization and is not already deleted
    const journeyCheck = await query(
      'SELECT id, title, status FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [journeyId, orgId]
    );

    if (journeyCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }

    const journey = journeyCheck.rows[0];

    // Block deletion of published journeys - must unpublish first
    if (journey.status === 'published') {
      return res.status(400).json({ 
        success: false, 
        code: 'MUST_UNPUBLISH_FIRST',
        error: req.t('journeys.delete.mustUnpublishFirst')
      });
    }

    // Check if this journey is used as a sub-journey in other journeys
    const nestedUsage = await query(`
      SELECT j.id, j.title 
      FROM steps s
      JOIN journeys j ON s.journey_id = j.id
      WHERE s.type = 'nested_journey' 
      AND s.basic_props->>'nested_journey_id' = $1
      AND j.deleted_at IS NULL
      AND j.organization_id = $2
    `, [journeyId, orgId]);
    
    if (nestedUsage.rows.length > 0) {
      const errorMessage = nestedUsage.rows.length === 1
        ? req.t('journeys.actions.cannotDeleteNested', { journeyTitle: nestedUsage.rows[0].title })
        : req.t('journeys.actions.cannotDeleteNestedMultiple', { count: nestedUsage.rows.length });
      
      return res.status(400).json({
        success: false,
        code: 'USED_AS_SUBJOURNEY',
        error: errorMessage,
        usedIn: nestedUsage.rows.map(j => ({ id: j.id, title: j.title }))
      });
    }

    // Check for rewards with claimed codes
    const rewardsCheck = await query(`
      SELECT r.id, r.title,
        (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id AND is_claimed = true) as claimed_count
      FROM rewards r
      WHERE r.journey_id = $1 AND (r.is_archived = false OR r.is_archived IS NULL)
    `, [journeyId]);

    const rewardsWithClaims = rewardsCheck.rows.filter(r => parseInt(r.claimed_count) > 0);

    // If there are rewards with claims, require confirmation
    if (rewardsWithClaims.length > 0 && !confirmRewardsArchive) {
      return res.status(400).json({
        success: false,
        code: 'REWARDS_WILL_BE_ARCHIVED',
        error: req.t('journeys.delete.rewardsWillBeArchived'),
        rewards: rewardsWithClaims.map(r => ({
          id: r.id,
          title: r.title,
          claimedCount: parseInt(r.claimed_count)
        }))
      });
    }

    // Archive rewards with claimed codes (they'll be visible in Analytics archive)
    if (rewardsWithClaims.length > 0) {
      await query(`
        UPDATE rewards SET is_archived = true, archived_at = NOW(), updated_at = NOW()
        WHERE journey_id = $1 AND id = ANY($2::uuid[])
      `, [journeyId, rewardsWithClaims.map(r => r.id)]);
    }

    // Handle polls based on user's choice
    let archivedPolls = 0;
    if (archivePolls === true) {
      // Archive polls: save question/options data before journey deletion
      const pollsToArchive = await query(`
        SELECT p.id, s.basic_props->>'question' as question, s.basic_props->'options' as options
        FROM polls p
        JOIN steps s ON p.step_id = s.id
        WHERE s.journey_id = $1 AND (p.is_archived = false OR p.is_archived IS NULL)
      `, [journeyId]);
      
      for (const poll of pollsToArchive.rows) {
        // Convert options to JSON string for JSONB column
        const optionsJson = typeof poll.options === 'string' 
          ? poll.options 
          : JSON.stringify(poll.options || []);
        await query(`
          UPDATE polls SET 
            is_archived = true, 
            archived_at = NOW(), 
            archived_question = $1,
            archived_options = $2::jsonb,
            archived_journey_title = $3,
            updated_at = NOW()
          WHERE id = $4
        `, [poll.question, optionsJson, journey.title, poll.id]);
      }
      archivedPolls = pollsToArchive.rows.length;
    }
    // If archivePolls is false or undefined, polls will be deleted with the cascade

    // Soft delete: set deleted_at timestamp
    await query(
      'UPDATE journeys SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2',
      [journeyId, orgId]
    );

    res.json({ 
      success: true, 
      message: req.t('journeys.delete.movedToTrash'),
      archivedRewards: rewardsWithClaims.length,
      archivedPolls: archivedPolls
    });

  } catch (err) {
    console.error('API delete journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete journey' });
  }
});

/**
 * POST /api/journeys/:id/restore - Restore journey from trash
 * Only admin and manager can restore
 */
router.post('/journeys/:id/restore', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;
    const userRole = req.user?.role;

    // Check permissions: only admin and manager can restore
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ 
        success: false, 
        error: req.t('journeys.delete.noPermission') 
      });
    }

    // Verify journey belongs to organization and is deleted
    const journeyCheck = await query(
      'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NOT NULL',
      [journeyId, orgId]
    );

    if (journeyCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found in trash' });
    }

    // Check journey limit before restoring
    // (journeys in trash don't count towards limit, but we need to check if restoring would exceed)
    const usageData = await getOrganizationUsageWithLimits(orgId);
    if (usageData && usageData.usage.journeys.isAtLimit) {
      return res.status(403).json({ 
        success: false, 
        code: 'LIMIT_EXCEEDED',
        limitType: 'journeys',
        error: req.t('journeys.restore.limitExceeded')
      });
    }

    // Restore: clear deleted_at timestamp and reset status to draft
    // Restored journeys always go back to draft status for safety
    await query(
      `UPDATE journeys SET deleted_at = NULL, status = 'draft', updated_at = NOW() WHERE id = $1 AND organization_id = $2`,
      [journeyId, orgId]
    );
    
    // Restore any archived polls that belong to this journey
    const restoredPolls = await query(`
      UPDATE polls p
      SET is_archived = false, archived_at = NULL, updated_at = NOW()
      FROM steps s
      WHERE p.step_id = s.id 
        AND s.journey_id = $1 
        AND p.is_archived = true
      RETURNING p.id
    `, [journeyId]);
    
    // Restore any archived rewards that belong to this journey
    const restoredRewards = await query(`
      UPDATE rewards 
      SET is_archived = false, archived_at = NULL, updated_at = NOW()
      WHERE journey_id = $1 AND is_archived = true
      RETURNING id
    `, [journeyId]);

    res.json({ 
      success: true, 
      message: req.t('journeys.restore.success'),
      restoredPolls: restoredPolls.rows.length,
      restoredRewards: restoredRewards.rows.length
    });

  } catch (err) {
    console.error('API restore journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to restore journey' });
  }
});

/**
 * POST /api/journeys/:id/copy - Copy a journey with all steps and paths
 * Admin, manager, and member can copy
 */
router.post('/journeys/:id/copy', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;
    const userId = req.user?.id;
    const userRole = req.user?.role;

    // Check permissions: viewer cannot copy
    if (userRole === 'viewer') {
      return res.status(403).json({ 
        success: false, 
        error: req.t('journeys.copy.noPermission') 
      });
    }

    // Check journey limit before copying
    const usageData = await getOrganizationUsageWithLimits(orgId);
    if (usageData && usageData.usage.journeys.isAtLimit) {
      return res.status(403).json({ 
        success: false, 
        code: 'LIMIT_EXCEEDED',
        limitType: 'journeys',
        error: req.t('subscription.limits.journeysExceeded')
      });
    }

    // Get the original journey
    const journeyResult = await query(
      'SELECT * FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [journeyId, orgId]
    );

    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }

    const originalJourney = journeyResult.rows[0];
    
    // Create the copy with translated "Copy of" prefix
    const copyPrefix = req.t('common.copyOf');
    const newTitle = `${copyPrefix} ${originalJourney.title}`;

    // Insert new journey
    const newJourneyResult = await query(
      `INSERT INTO journeys (organization_id, created_by, title, description, status, cover_image_url, settings)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6)
       RETURNING id`,
      [orgId, userId, newTitle, originalJourney.description, originalJourney.cover_image_url, originalJourney.settings]
    );

    const newJourneyId = newJourneyResult.rows[0].id;

    // Get all steps from original journey
    const stepsResult = await query(
      'SELECT * FROM steps WHERE journey_id = $1 ORDER BY created_at',
      [journeyId]
    );

    // Map old step IDs to new step IDs
    const stepIdMap = new Map();

    // Copy all steps
    for (const step of stepsResult.rows) {
      const newStepResult = await query(
        `INSERT INTO steps (journey_id, type, title, position_x, position_y, is_start, is_end, basic_props, advanced_props)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [newJourneyId, step.type, step.title, step.position_x, step.position_y, step.is_start, step.is_end, step.basic_props, step.advanced_props]
      );
      stepIdMap.set(step.id, newStepResult.rows[0].id);
    }

    // Get all paths from original journey
    const pathsResult = await query(
      'SELECT * FROM paths WHERE journey_id = $1',
      [journeyId]
    );

    // Copy all paths with remapped step IDs
    for (const path of pathsResult.rows) {
      const newFromStepId = stepIdMap.get(path.from_step_id);
      const newToStepId = stepIdMap.get(path.to_step_id);
      
      if (newFromStepId && newToStepId) {
        await query(
          `INSERT INTO paths (journey_id, from_step_id, to_step_id, label, description, icon, condition, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [newJourneyId, newFromStepId, newToStepId, path.label, path.description, path.icon, path.condition, path.sort_order]
        );
      }
    }

    // Copy resources if any
    const resourcesResult = await query(
      'SELECT * FROM resources WHERE journey_id = $1',
      [journeyId]
    );

    for (const resource of resourcesResult.rows) {
      await query(
        `INSERT INTO resources (journey_id, name, description, icon, type, content)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newJourneyId, resource.name, resource.description, resource.icon, resource.type, resource.content]
      );
    }

    res.json({ 
      success: true, 
      message: req.t('journeys.copy.success'),
      journeyId: newJourneyId
    });

  } catch (err) {
    console.error('API copy journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to copy journey' });
  }
});

/**
 * POST /api/translate-text - Quick translation of a short text
 * Used for previewing translated titles before copy-translate
 */
router.post('/translate-text', async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    if (!text || !targetLang) {
      return res.status(400).json({ success: false, error: 'Missing text or targetLang' });
    }
    const { translateText } = await import('../services/translation.js');
    const translated = await translateText(text, targetLang);
    res.json({ success: true, translated });
  } catch (err) {
    console.error('[TranslateText] Error:', err.message);
    res.json({ success: false, translated: req.body.text });
  }
});

/**
 * POST /api/journeys/:id/copy-translate - Copy and translate a journey to another language
 * Uses Server-Sent Events for progress updates
 * Admin, manager, and member can copy-translate
 */
router.post('/journeys/:id/copy-translate', async (req, res) => {
  console.log('[CopyTranslate] Starting copy-translate request');
  
  // Set up SSE headers - ensure no buffering anywhere
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'close'); // Force connection close after SSE to prevent HTTP/2 reuse issues
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  
  // Flush headers immediately to establish the SSE connection
  res.flushHeaders();
  
  const sendProgress = (progress, status, extra = {}) => {
    console.log(`[CopyTranslate] Progress: ${progress}% - ${status}`, extra);
    res.write(`data: ${JSON.stringify({ progress, status, ...extra })}\n\n`);
    // Force flush to ensure the event is sent immediately
    if (res.flush) res.flush();
  };
  
  try {
    const journeyId = req.params.id;
    const { target_language, new_title } = req.body;
    console.log('[CopyTranslate] Journey:', journeyId, 'Target language:', target_language, 'New title:', new_title);
    const orgId = req.organizationId;
    const userId = req.user?.id;
    const userRole = req.user?.role;

    // Validate target language
    const supportedLanguages = getSupportedLanguages();
    const isValidLanguage = supportedLanguages.some(l => l.code === target_language);
    if (!target_language || !isValidLanguage) {
      sendProgress(0, 'error', { error: req.t('journeys.copyTranslate.invalidLanguage') });
      res.end();
      return;
    }

    // Check permissions: viewer cannot copy
    if (userRole === 'viewer') {
      sendProgress(0, 'error', { error: req.t('journeys.copy.noPermission') });
      res.end();
      return;
    }

    sendProgress(5, 'starting');

    // Check journey limit before copying
    const usageData = await getOrganizationUsageWithLimits(orgId);
    if (usageData && usageData.usage.journeys.isAtLimit) {
      sendProgress(0, 'error', { 
        error: req.t('subscription.limits.journeysExceeded'),
        code: 'LIMIT_EXCEEDED'
      });
      res.end();
      return;
    }

    // Get the original journey
    const journeyResult = await query(
      'SELECT * FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [journeyId, orgId]
    );

    if (journeyResult.rows.length === 0) {
      sendProgress(0, 'error', { error: req.t('common.notFound') });
      res.end();
      return;
    }

    const originalJourney = journeyResult.rows[0];
    sendProgress(10, 'loading');

    // Get all steps from original journey
    const stepsResult = await query(
      'SELECT * FROM steps WHERE journey_id = $1 ORDER BY created_at',
      [journeyId]
    );

    // Get all paths from original journey
    const pathsResult = await query(
      'SELECT * FROM paths WHERE journey_id = $1',
      [journeyId]
    );

    // Get all resources from original journey
    const resourcesResult = await query(
      'SELECT * FROM resources WHERE journey_id = $1',
      [journeyId]
    );

    sendProgress(15, 'translating');

    // Prepare data for translation
    const journeyData = {
      journey: {
        title: originalJourney.title,
        description: originalJourney.description
      },
      steps: stepsResult.rows,
      paths: pathsResult.rows,
      resources: resourcesResult.rows
    };

    // Translate content with progress updates
    const translatedData = await translateJourneyContent(
      journeyData,
      target_language,
      'auto',
      (progress, status) => {
        // Map internal progress (0-100) to our range (15-85)
        const mappedProgress = 15 + Math.round(progress * 0.7);
        sendProgress(mappedProgress, status === 'translating' ? 'translating' : status);
      }
    );

    sendProgress(85, 'creating');

    // Use provided title or translated title
    const finalTitle = new_title || translatedData.journey.title;

    // Update settings with language overrides
    const originalSettings = typeof originalJourney.settings === 'string' 
      ? JSON.parse(originalJourney.settings) 
      : (originalJourney.settings || {});
    
    console.log('[CopyTranslate] Original settings type:', typeof originalJourney.settings, 
      'Original language_override:', originalSettings.language_override);
    
    const newSettings = {
      ...originalSettings,
      language_override: true,
      language_code: target_language,
      guide_language_override: true,
      guide_language_code: target_language
    };
    
    console.log('[CopyTranslate] New settings - language_override:', newSettings.language_override, 
      'language_code:', newSettings.language_code, 
      'guide_language_override:', newSettings.guide_language_override,
      'guide_language_code:', newSettings.guide_language_code);
    
    // If the journey has a central guide, translate its greeting for the opening override
    console.log('[CopyTranslate] Checking for guide - guide_id:', originalJourney.guide_id);
    if (originalJourney.guide_id) {
      sendProgress(86, 'translating_guide');
      const guideResult = await query(
        'SELECT greeting, role, name FROM guides WHERE id = $1 AND organization_id = $2',
        [originalJourney.guide_id, orgId]
      );
      
      console.log('[CopyTranslate] Guide query result:', guideResult.rows.length > 0 ? `Found guide: ${guideResult.rows[0].name}` : 'No guide found');
      
      if (guideResult.rows.length > 0 && guideResult.rows[0].greeting) {
        try {
          console.log('[CopyTranslate] Original greeting:', guideResult.rows[0].greeting.substring(0, 50) + '...');
          const { translateText } = await import('../services/translation.js');
          const translatedGreeting = await translateText(guideResult.rows[0].greeting, target_language);
          newSettings.guide_opening_override = translatedGreeting;
          console.log('[CopyTranslate] Translated guide greeting to:', target_language, '- Result:', translatedGreeting.substring(0, 50) + '...');
        } catch (translateErr) {
          console.warn('[CopyTranslate] Failed to translate guide greeting:', translateErr.message);
        }
      } else {
        console.log('[CopyTranslate] Guide has no greeting set');
      }
    } else {
      console.log('[CopyTranslate] Journey has no central guide assigned');
    }

    // Insert new journey (including guide_id to preserve central guide assignment)
    // Ensure settings is properly JSON-serialized for PostgreSQL JSONB column
    const settingsJson = JSON.stringify(newSettings);
    console.log('[CopyTranslate] Inserting new journey with settings:', settingsJson);
    const newJourneyResult = await query(
      `INSERT INTO journeys (organization_id, created_by, title, description, status, cover_image_url, settings, guide_id)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6::jsonb, $7)
       RETURNING id, settings`,
      [orgId, userId, finalTitle, translatedData.journey.description, originalJourney.cover_image_url, settingsJson, originalJourney.guide_id]
    );

    const newJourneyId = newJourneyResult.rows[0].id;
    console.log('[CopyTranslate] Inserted journey', newJourneyId, '- Saved settings:', JSON.stringify(newJourneyResult.rows[0].settings));

    sendProgress(90, 'creating_steps');

    // Map old step IDs to new step IDs
    const stepIdMap = new Map();

    // Copy all translated steps
    for (let i = 0; i < stepsResult.rows.length; i++) {
      const originalStep = stepsResult.rows[i];
      const translatedStep = translatedData.steps[i];
      
      const newStepResult = await query(
        `INSERT INTO steps (journey_id, type, title, position_x, position_y, is_start, is_end, basic_props, advanced_props)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          newJourneyId, 
          originalStep.type, 
          translatedStep.title || originalStep.title, 
          originalStep.position_x, 
          originalStep.position_y, 
          originalStep.is_start, 
          originalStep.is_end, 
          translatedStep.basic_props || originalStep.basic_props, 
          translatedStep.advanced_props || originalStep.advanced_props
        ]
      );
      stepIdMap.set(originalStep.id, newStepResult.rows[0].id);
    }

    sendProgress(95, 'creating_paths');

    // Copy all translated paths with remapped step IDs
    for (let i = 0; i < pathsResult.rows.length; i++) {
      const originalPath = pathsResult.rows[i];
      const translatedPath = translatedData.paths[i];
      
      const newFromStepId = stepIdMap.get(originalPath.from_step_id);
      const newToStepId = stepIdMap.get(originalPath.to_step_id);
      
      if (newFromStepId && newToStepId) {
        await query(
          `INSERT INTO paths (journey_id, from_step_id, to_step_id, label, description, icon, condition, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            newJourneyId, 
            newFromStepId, 
            newToStepId, 
            translatedPath.label || originalPath.label, 
            translatedPath.description || originalPath.description, 
            originalPath.icon, 
            originalPath.condition, 
            originalPath.sort_order
          ]
        );
      }
    }

    // Copy translated resources
    for (let i = 0; i < resourcesResult.rows.length; i++) {
      const originalResource = resourcesResult.rows[i];
      const translatedResource = translatedData.resources[i];
      
      await query(
        `INSERT INTO resources (journey_id, name, description, icon, type, content)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newJourneyId, 
          translatedResource.name || originalResource.name, 
          translatedResource.description || originalResource.description, 
          originalResource.icon, 
          originalResource.type, 
          originalResource.content
        ]
      );
    }

    sendProgress(100, 'done', { 
      done: true, 
      journeyId: newJourneyId,
      message: req.t('journeys.copyTranslate.success')
    });
    res.end();

  } catch (err) {
    console.error('API copy-translate journey error:', err);
    let errorMessage = req.t('journeys.copyTranslate.error');
    if (err.statusCode === 502 || err.statusCode === 503) {
      errorMessage = req.t('journeys.copyTranslate.translationServiceUnavailable') || 'Translation service is temporarily unavailable. Please try again in a few minutes.';
    } else if (err.statusCode === 401 || err.statusCode === 403) {
      errorMessage = req.t('journeys.copyTranslate.translationAuthError') || 'Translation service authentication failed. Please contact support.';
    } else if (err.statusCode === 429) {
      errorMessage = req.t('journeys.copyTranslate.translationRateLimit') || 'Translation rate limit reached. Please wait a moment and try again.';
    } else if (err.message?.includes('Translation failed')) {
      errorMessage = req.t('journeys.copyTranslate.translationFailed') || 'Translation failed. The translation service may be experiencing issues. Please try again later.';
    }
    sendProgress(0, 'error', { error: errorMessage });
    res.end();
  }
});

/**
 * GET /api/languages/supported - Get list of supported languages for translation
 */
router.get('/languages/supported', (req, res) => {
  const languages = getSupportedLanguages();
  res.json({ success: true, languages });
});

// ============================================
// PUBLIC JOURNEYS (Tier 3+ Feature)
// ============================================

/**
 * POST /api/journeys/:id/convert-public - Convert journey to public
 * Only admin and manager can convert to public
 * Only available for Tier 3 (Enterprise) and Tier 4 (Custom)
 */
router.post('/journeys/:id/convert-public', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;
    const userRole = req.user?.role;

    // Check permissions: only admin and manager can convert
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ 
        success: false, 
        error: 'No permission to convert journeys' 
      });
    }

    if (!(await isFeatureEnabled(orgId, 'public_journeys'))) {
      return res.status(403).json({ 
        success: false, 
        error: 'Public journeys are only available for Enterprise and Custom plans' 
      });
    }

    // Verify journey belongs to organization
    const journeyCheck = await query(
      'SELECT id, title, is_public FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [journeyId, orgId]
    );

    if (journeyCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }

    if (journeyCheck.rows[0].is_public) {
      return res.status(400).json({ success: false, error: 'Journey is already public' });
    }

    // Check if this journey uses any private sub-journeys
    // If so, it cannot be made public until those are made public or removed
    const privateSubjourneys = await query(`
      SELECT j.id, j.title
      FROM steps s
      JOIN journeys j ON s.basic_props->>'nested_journey_id' = j.id::text
      WHERE s.journey_id = $1
      AND s.type = 'nested_journey'
      AND s.basic_props->>'nested_journey_id' IS NOT NULL
      AND (j.is_public = false OR j.is_public IS NULL)
      AND j.deleted_at IS NULL
    `, [journeyId]);
    
    if (privateSubjourneys.rows.length > 0) {
      return res.status(400).json({
        success: false,
        code: 'HAS_PRIVATE_SUBJOURNEYS',
        error: req.t('journeys.actions.cannotMakePublicWithPrivateSubjourneys'),
        privateSubjourneys: privateSubjourneys.rows.map(j => ({ id: j.id, title: j.title }))
      });
    }

    // Generate unique public token
    const publicToken = crypto.randomBytes(32).toString('hex');

    // Update journey to public
    await query(`
      UPDATE journeys 
      SET is_public = true, 
          public_token = $1, 
          public_link_created_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
    `, [publicToken, journeyId]);

    const baseUrl = getAppBaseUrl();
    const publicLink = `${baseUrl}/p/${publicToken}`;

    res.json({ 
      success: true, 
      message: req.t('journeys.public.convertedToPublic'),
      publicToken,
      publicLink
    });

  } catch (err) {
    console.error('API convert to public error:', err);
    res.status(500).json({ success: false, error: req.t('journeys.public.convertError') });
  }
});

/**
 * POST /api/journeys/:id/convert-private - Convert journey back to private
 * Only admin and manager can convert
 */
router.post('/journeys/:id/convert-private', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;
    const userRole = req.user?.role;

    // Check permissions: only admin and manager can convert
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ 
        success: false, 
        error: 'No permission to convert journeys' 
      });
    }

    // Verify journey belongs to organization
    const journeyCheck = await query(
      'SELECT id, title, is_public FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [journeyId, orgId]
    );

    if (journeyCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }

    if (!journeyCheck.rows[0].is_public) {
      return res.status(400).json({ success: false, error: 'Journey is already private' });
    }

    // Check if this journey is used as a sub-journey in PUBLIC parent journeys
    // Private parent journeys can use private sub-journeys, so we only block if used in public parents
    const nestedUsageInPublic = await query(`
      SELECT j.id, j.title 
      FROM steps s
      JOIN journeys j ON s.journey_id = j.id
      WHERE s.type = 'nested_journey' 
      AND s.basic_props->>'nested_journey_id' = $1
      AND j.deleted_at IS NULL
      AND j.organization_id = $2
      AND j.is_public = true
    `, [journeyId, orgId]);
    
    if (nestedUsageInPublic.rows.length > 0) {
      const errorMessage = nestedUsageInPublic.rows.length === 1
        ? req.t('journeys.actions.cannotChangeVisibilityNested', { journeyTitle: nestedUsageInPublic.rows[0].title })
        : req.t('journeys.actions.cannotChangeVisibilityNestedMultiple', { count: nestedUsageInPublic.rows.length });
      
      return res.status(400).json({
        success: false,
        code: 'USED_AS_SUBJOURNEY',
        error: errorMessage,
        usedIn: nestedUsageInPublic.rows.map(j => ({ id: j.id, title: j.title }))
      });
    }

    // Update journey to private (keep the token for potential future re-enable)
    await query(`
      UPDATE journeys 
      SET is_public = false,
          updated_at = NOW()
      WHERE id = $1
    `, [journeyId]);

    res.json({ 
      success: true, 
      message: req.t('journeys.public.convertedToPrivate')
    });

  } catch (err) {
    console.error('API convert to private error:', err);
    res.status(500).json({ success: false, error: req.t('journeys.public.convertError') });
  }
});

/**
 * GET /api/journeys/:id/public-link - Get public link for a journey
 */
router.get('/journeys/:id/public-link', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;

    const journeyResult = await query(
      'SELECT id, is_public, public_token FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [journeyId, orgId]
    );

    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }

    const journey = journeyResult.rows[0];

    if (!journey.is_public || !journey.public_token) {
      return res.status(400).json({ success: false, error: 'Journey is not public' });
    }

    const baseUrl = getAppBaseUrl();
    const publicLink = `${baseUrl}/p/${journey.public_token}`;

    res.json({ 
      success: true, 
      publicLink,
      publicToken: journey.public_token
    });

  } catch (err) {
    console.error('API get public link error:', err);
    res.status(500).json({ success: false, error: 'Failed to get public link' });
  }
});

/**
 * DELETE /api/journeys/:id/permanent - Permanently delete journey
 * Only admin and manager can permanently delete
 */
router.delete('/journeys/:id/permanent', async (req, res) => {
  try {
    const journeyId = req.params.id;
    const orgId = req.organizationId;
    const userRole = req.user?.role;

    // Check permissions: only admin and manager can permanently delete
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ 
        success: false, 
        error: req.t('journeys.delete.noPermission') 
      });
    }

    // Verify journey belongs to organization and is deleted
    const journeyCheck = await query(
      'SELECT id, title FROM journeys WHERE id = $1 AND organization_id = $2 AND deleted_at IS NOT NULL',
      [journeyId, orgId]
    );

    if (journeyCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found in trash' });
    }
    
    const journeyTitle = journeyCheck.rows[0].title;
    
    // Before deleting: detach archived polls from steps so they survive cascade delete
    // Set step_id to NULL and store journey title for reference
    await query(`
      UPDATE polls p
      SET step_id = NULL, archived_journey_title = COALESCE(archived_journey_title, $2), updated_at = NOW()
      FROM steps s
      WHERE p.step_id = s.id 
        AND s.journey_id = $1 
        AND p.is_archived = true
    `, [journeyId, journeyTitle]);
    
    // Before deleting: detach archived rewards from journey/steps so they survive cascade delete
    await query(`
      UPDATE rewards 
      SET step_id = NULL, journey_id = NULL, updated_at = NOW()
      WHERE journey_id = $1 AND is_archived = true
    `, [journeyId]);

    // Permanently delete: cascade will handle non-archived related records
    await query(
      'DELETE FROM journeys WHERE id = $1 AND organization_id = $2',
      [journeyId, orgId]
    );

    res.json({ success: true, message: req.t('journeys.delete.permanentSuccess') });

  } catch (err) {
    console.error('API permanent delete journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to permanently delete journey' });
  }
});

// ============================================
// STEPS (Space, Guide, Content, Challenge)
// ============================================

/**
 * POST /api/steps - Create new step
 */
router.post('/steps', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { id, journey_id, type, title, position_x, position_y, is_start, is_end, basic_props, advanced_props } = req.body;
    
    // Verify journey belongs to organization
    const journeyCheck = await query(
      'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2',
      [journey_id, orgId]
    );
    
    if (journeyCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: req.t('team.messages.noPermission') });
    }
    
    // If this is a start step, clear other start steps
    if (is_start) {
      await query('UPDATE steps SET is_start = false WHERE journey_id = $1', [journey_id]);
    }
    
    // Allow client-supplied UUID for undo/redo restores (safe: must be UUID and unique)
    if (id && !isUuid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid step id' });
    }

    const insertStepSql = id
      ? `
        INSERT INTO steps (id, journey_id, type, title, position_x, position_y, is_start, is_end, basic_props, advanced_props)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `
      : `
        INSERT INTO steps (journey_id, type, title, position_x, position_y, is_start, is_end, basic_props, advanced_props)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `;

    const params = id
      ? [
          id,
          journey_id,
          type || 'content',
          title || getDefaultTitle(type),
          position_x || 100,
          position_y || 100,
          is_start || false,
          is_end || false,
          JSON.stringify(basic_props || getDefaultBasicProps(type, req)),
          JSON.stringify(advanced_props || {})
        ]
      : [
          journey_id,
          type || 'content',
          title || getDefaultTitle(type),
          position_x || 100,
          position_y || 100,
          is_start || false,
          is_end || false,
          JSON.stringify(basic_props || getDefaultBasicProps(type, req)),
          JSON.stringify(advanced_props || {})
        ];

    const result = await query(insertStepSql, params);
    
    // Update journey timestamp
    await query('UPDATE journeys SET updated_at = NOW() WHERE id = $1', [journey_id]);
    
    res.json({ success: true, step: result.rows[0] });
    
  } catch (err) {
    console.error('API create step error:', err);
    res.status(500).json({ success: false, error: 'Failed to create step' });
  }
});

/**
 * PUT /api/steps/:id - Update step
 */
router.put('/steps/:id', async (req, res) => {
  try {
    const stepId = req.params.id;
    const orgId = req.organizationId;
    const { type, title, position_x, position_y, is_start, is_end, basic_props, advanced_props } = req.body;
    
    // Verify step belongs to organization via journey
    const stepCheck = await query(`
      SELECT s.journey_id FROM steps s
      JOIN journeys j ON s.journey_id = j.id
      WHERE s.id = $1 AND j.organization_id = $2
    `, [stepId, orgId]);
    
    if (stepCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: req.t('team.messages.noPermission') });
    }
    
    const journeyId = stepCheck.rows[0].journey_id;
    
    // If this is a start step, clear other start steps
    if (is_start) {
      await query('UPDATE steps SET is_start = false WHERE journey_id = $1 AND id != $2', [journeyId, stepId]);
    }
    
    const result = await query(`
      UPDATE steps 
      SET type = COALESCE($1, type),
          title = COALESCE($2, title),
          position_x = COALESCE($3, position_x),
          position_y = COALESCE($4, position_y),
          is_start = COALESCE($5, is_start),
          is_end = COALESCE($6, is_end),
          basic_props = COALESCE($7, basic_props),
          advanced_props = COALESCE($8, advanced_props),
          updated_at = NOW()
      WHERE id = $9
      RETURNING *
    `, [
      type, 
      title, 
      position_x, 
      position_y, 
      is_start, 
      is_end, 
      basic_props ? JSON.stringify(basic_props) : null, 
      advanced_props ? JSON.stringify(advanced_props) : null, 
      stepId
    ]);
    
    // Update journey timestamp
    await query('UPDATE journeys SET updated_at = NOW() WHERE id = $1', [journeyId]);
    
    // Queue image/video analysis in the background (non-blocking)
    // This generates AI descriptions for Step Assistants
    if (basic_props) {
      // Image analysis for content/space steps
      if (basic_props.image_url) {
        const mediaType = detectMediaType(basic_props.image_url);
        queueAnalysis(basic_props.image_url, mediaType).catch(err => {
          console.error('Failed to queue image analysis:', err.message);
        });
      }
      
      // Video analysis (YouTube) for content steps
      if (basic_props.video_url) {
        const mediaType = detectMediaType(basic_props.video_url);
        queueAnalysis(basic_props.video_url, mediaType).catch(err => {
          console.error('Failed to queue video analysis:', err.message);
        });
      }
      
      // 360 photo analysis for space steps
      if (basic_props.panorama_url) {
        queueAnalysis(basic_props.panorama_url, 'image').catch(err => {
          console.error('Failed to queue panorama analysis:', err.message);
        });
      }
    }
    
    res.json({ success: true, step: result.rows[0] });
    
  } catch (err) {
    console.error('API update step error:', err);
    res.status(500).json({ success: false, error: 'Failed to update step' });
  }
});

/**
 * GET /api/steps/:id/impact - Get impact analysis before step deletion
 */
router.get('/steps/:id/impact', async (req, res) => {
  try {
    const stepId = req.params.id;
    const orgId = req.organizationId;
    
    // Verify step belongs to organization
    const stepCheck = await query(`
      SELECT s.id, s.type, s.title, s.journey_id 
      FROM steps s
      JOIN journeys j ON s.journey_id = j.id
      WHERE s.id = $1 AND j.organization_id = $2
    `, [stepId, orgId]);
    
    if (stepCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Step not found' });
    }
    
    const step = stepCheck.rows[0];
    
    // Check if this is a reward step with claimed codes
    let rewardInfo = null;
    if (step.type === 'reward') {
      const rewardCheck = await query(`
        SELECT r.id, r.title, r.valid_until,
          (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id AND is_claimed = true) as claimed_count,
          (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id AND is_claimed = false) as unclaimed_count
        FROM rewards r
        WHERE r.step_id = $1
      `, [stepId]);
      
      if (rewardCheck.rows.length > 0) {
        const reward = rewardCheck.rows[0];
        rewardInfo = {
          id: reward.id,
          title: reward.title,
          validUntil: reward.valid_until,
          claimedCount: parseInt(reward.claimed_count) || 0,
          unclaimedCount: parseInt(reward.unclaimed_count) || 0,
          hasClaims: parseInt(reward.claimed_count) > 0
        };
      }
    }
    
    res.json({
      success: true,
      step: {
        id: step.id,
        type: step.type,
        title: step.title
      },
      reward: rewardInfo,
      canDelete: !rewardInfo?.hasClaims,
      canDeactivate: rewardInfo?.hasClaims
    });
    
  } catch (err) {
    console.error('API step impact error:', err);
    res.status(500).json({ success: false, error: 'Failed to get step impact' });
  }
});

/**
 * DELETE /api/steps/:id - Delete step
 * Reward steps with claimed codes cannot be deleted, only deactivated
 */
router.delete('/steps/:id', async (req, res) => {
  try {
    const stepId = req.params.id;
    const orgId = req.organizationId;
    const { forceArchive } = req.body; // Allow archiving reward instead of blocking
    
    // Verify and get journey_id and step type
    const stepCheck = await query(`
      SELECT s.journey_id, s.type, s.title FROM steps s
      JOIN journeys j ON s.journey_id = j.id
      WHERE s.id = $1 AND j.organization_id = $2
    `, [stepId, orgId]);
    
    if (stepCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: req.t('team.messages.noPermission') });
    }
    
    const journeyId = stepCheck.rows[0].journey_id;
    const stepType = stepCheck.rows[0].type;
    
    // Check if this is a reward step with claimed codes
    if (stepType === 'reward') {
      const rewardCheck = await query(`
        SELECT r.id, r.title,
          (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id AND is_claimed = true) as claimed_count
        FROM rewards r
        WHERE r.step_id = $1
      `, [stepId]);
      
      if (rewardCheck.rows.length > 0) {
        const reward = rewardCheck.rows[0];
        const claimedCount = parseInt(reward.claimed_count) || 0;
        
        if (claimedCount > 0) {
          if (!forceArchive) {
            // Block deletion - codes have been claimed
            return res.status(400).json({
              success: false,
              code: 'REWARD_HAS_CLAIMS',
              error: req.t('builder.reward.cannotDeleteWithClaims'),
              reward: {
                id: reward.id,
                title: reward.title,
                claimedCount: claimedCount
              }
            });
          }
          
          // Archive the reward instead of deleting
          await query(`
            UPDATE rewards SET is_archived = true, archived_at = NOW(), updated_at = NOW()
            WHERE id = $1
          `, [reward.id]);
        }
      }
    }
    
    // Delete step (cascades to paths, and rewards if not archived)
    await query('DELETE FROM steps WHERE id = $1', [stepId]);
    
    // Update journey timestamp
    await query('UPDATE journeys SET updated_at = NOW() WHERE id = $1', [journeyId]);
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('API delete step error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete step' });
  }
});

// ============================================
// PATHS (Connections)
// ============================================

/**
 * POST /api/paths - Create path between steps
 */
router.post('/paths', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { id, journey_id, from_step_id, to_step_id, label, description, icon, requires_resource_id, condition, sort_order } = req.body;
    
    // Verify journey belongs to organization
    const journeyCheck = await query(
      'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2',
      [journey_id, orgId]
    );
    
    if (journeyCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: req.t('team.messages.noPermission') });
    }
    
    if (id && !isUuid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid path id' });
    }

    const insertPathSql = id
      ? `
        INSERT INTO paths (id, journey_id, from_step_id, to_step_id, label, description, icon, requires_resource_id, condition, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `
      : `
        INSERT INTO paths (journey_id, from_step_id, to_step_id, label, description, icon, requires_resource_id, condition, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `;

    const params = id
      ? [
          id,
          journey_id,
          from_step_id,
          to_step_id,
          label || 'Continue',
          description,
          icon || 'arrow-right',
          requires_resource_id,
          JSON.stringify(condition || {}),
          sort_order || 0
        ]
      : [
          journey_id,
          from_step_id,
          to_step_id,
          label || 'Continue',
          description,
          icon || 'arrow-right',
          requires_resource_id,
          JSON.stringify(condition || {}),
          sort_order || 0
        ];

    const result = await query(insertPathSql, params);
    
    // Update journey timestamp
    await query('UPDATE journeys SET updated_at = NOW() WHERE id = $1', [journey_id]);
    
    res.json({ success: true, path: result.rows[0] });
    
  } catch (err) {
    console.error('API create path error:', err);
    res.status(500).json({ success: false, error: 'Failed to create path' });
  }
});

/**
 * PUT /api/paths/:id - Update path
 */
router.put('/paths/:id', async (req, res) => {
  try {
    const pathId = req.params.id;
    const orgId = req.organizationId;
    const { label, description, icon, requires_resource_id, condition, sort_order } = req.body;
    
    // Verify path belongs to organization via journey
    const pathCheck = await query(`
      SELECT p.journey_id FROM paths p
      JOIN journeys j ON p.journey_id = j.id
      WHERE p.id = $1 AND j.organization_id = $2
    `, [pathId, orgId]);
    
    if (pathCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: req.t('team.messages.noPermission') });
    }
    
    const result = await query(`
      UPDATE paths 
      SET label = COALESCE($1, label),
          description = COALESCE($2, description),
          icon = COALESCE($3, icon),
          requires_resource_id = $4,
          condition = COALESCE($5, condition),
          sort_order = COALESCE($6, sort_order)
      WHERE id = $7
      RETURNING *
    `, [label, description, icon, requires_resource_id, condition ? JSON.stringify(condition) : null, sort_order, pathId]);
    
    res.json({ success: true, path: result.rows[0] });
    
  } catch (err) {
    console.error('API update path error:', err);
    res.status(500).json({ success: false, error: 'Failed to update path' });
  }
});

/**
 * DELETE /api/paths/:id - Delete path
 */
router.delete('/paths/:id', async (req, res) => {
  try {
    const pathId = req.params.id;
    const orgId = req.organizationId;
    
    // Verify path belongs to organization
    const pathCheck = await query(`
      SELECT p.journey_id FROM paths p
      JOIN journeys j ON p.journey_id = j.id
      WHERE p.id = $1 AND j.organization_id = $2
    `, [pathId, orgId]);
    
    if (pathCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: req.t('team.messages.noPermission') });
    }
    
    await query('DELETE FROM paths WHERE id = $1', [pathId]);
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('API delete path error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete path' });
  }
});

// ============================================
// RESOURCES
// ============================================

/**
 * GET /api/resources/:journeyId - Get all resources for a journey
 */
router.get('/resources/:journeyId', async (req, res) => {
  try {
    const journeyId = req.params.journeyId;
    const orgId = req.organizationId;
    
    // Verify journey belongs to organization
    const journeyCheck = await query(
      'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2',
      [journeyId, orgId]
    );
    
    if (journeyCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: req.t('team.messages.noPermission') });
    }
    
    const result = await query(
      'SELECT * FROM resources WHERE journey_id = $1 ORDER BY name',
      [journeyId]
    );
    
    res.json({ success: true, resources: result.rows });
    
  } catch (err) {
    console.error('API get resources error:', err);
    res.status(500).json({ success: false, error: 'Failed to load resources' });
  }
});

/**
 * POST /api/resources - Create resource
 */
router.post('/resources', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { id, journey_id, name, description, icon, type, content } = req.body;
    
    // Verify journey belongs to organization
    const journeyCheck = await query(
      'SELECT id FROM journeys WHERE id = $1 AND organization_id = $2',
      [journey_id, orgId]
    );
    
    if (journeyCheck.rows.length === 0) {
      return res.status(403).json({ success: false, error: req.t('team.messages.noPermission') });
    }
    
    if (id && !isUuid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid resource id' });
    }

    const insertResourceSql = id
      ? `
        INSERT INTO resources (id, journey_id, name, description, icon, type, content)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `
      : `
        INSERT INTO resources (journey_id, name, description, icon, type, content)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `;

    const params = id
      ? [id, journey_id, name, description, icon || 'file', type || 'document', JSON.stringify(content || {})]
      : [journey_id, name, description, icon || 'file', type || 'document', JSON.stringify(content || {})];

    const result = await query(insertResourceSql, params);
    
    res.json({ success: true, resource: result.rows[0] });
    
  } catch (err) {
    console.error('API create resource error:', err);
    res.status(500).json({ success: false, error: 'Failed to create resource' });
  }
});

/**
 * DELETE /api/resources/:id - Delete resource
 */
router.delete('/resources/:id', async (req, res) => {
  try {
    const resourceId = req.params.id;
    const orgId = req.organizationId;
    
    // Verify resource belongs to organization
    const check = await query(`
      SELECT r.id FROM resources r
      JOIN journeys j ON r.journey_id = j.id
      WHERE r.id = $1 AND j.organization_id = $2
    `, [resourceId, orgId]);
    
    if (check.rows.length === 0) {
      return res.status(403).json({ success: false, error: req.t('team.messages.noPermission') });
    }
    
    await query('DELETE FROM resources WHERE id = $1', [resourceId]);
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('API delete resource error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete resource' });
  }
});

// ============================================
// AI GUIDE CHAT
// ============================================

/**
 * POST /api/guide/chat - Chat with AI Guide
 */
router.post('/guide/chat', async (req, res) => {
  try {
    const { step_id, message, conversation_history, journey_context } = req.body;
    const orgId = req.organizationId;
    
    if (!(await hasAiCreditsLeft(orgId, 'maker'))) {
      const limitMessage = req.t('subscription.limits.aiCreditsExceeded');
      return res.status(403).json({ success: false, code: 'AI_CREDITS_EXHAUSTED', error: limitMessage, response: limitMessage });
    }
    
    // Get step with guide info and journey context
    const stepResult = await query(`
      SELECT s.*, j.title as journey_title, j.description as journey_description
      FROM steps s
      JOIN journeys j ON s.journey_id = j.id
      WHERE s.id = $1 AND j.organization_id = $2 AND s.type = 'guide'
    `, [step_id, orgId]);
    
    if (stepResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    const step = stepResult.rows[0];
    const basicProps = typeof step.basic_props === 'string' ? JSON.parse(step.basic_props) : step.basic_props;
    const advancedProps = typeof step.advanced_props === 'string' ? JSON.parse(step.advanced_props) : step.advanced_props;
    
    // Build guide context with all necessary info
    // SECURITY: Include organizationId for defense-in-depth verification
    const guideContext = {
      stepId: step_id, // For RAG knowledge retrieval
      organizationId: orgId, // SECURITY: For knowledge retrieval verification
      name: basicProps.name || step.title,
      role: basicProps.role || 'Guide',
      personality: basicProps.personality || 'friendly',  // Use preset key
      customPersonality: basicProps.customPersonality || '',
      greeting: basicProps.greeting || '',
      instructions: advancedProps.ai_instructions || '',
      topics: advancedProps.topics || []
    };
    
    // Build journey context string
    const journeyContextStr = journey_context || `
This guide is part of the journey: "${step.journey_title}"
${step.journey_description ? `Journey description: ${step.journey_description}` : ''}
Current location: ${step.title}
    `.trim();
    
    // Call Mistral AI with enhanced context
    const aiResult = await chatWithGuide(
      guideContext, 
      message, 
      conversation_history || [],
      journeyContextStr
    );
    
    // Track AI credits if usage data is available
    if (aiResult.usage) {
      // 1 AI credit = 1 answered question
      await trackAiCredits(orgId, 1, {
        model: aiResult.usage.model,
        tokensInput: aiResult.usage.promptTokens,
        tokensOutput: aiResult.usage.completionTokens,
        guideId: basicProps.guide_id || null,
        stepId: step_id,
        context: 'builder_preview'
      });
    }
    
    // Parse citations from response
    const { parseCitations, getCitationSources } = await import('../services/knowledge.js');
    const citations = aiResult.response ? parseCitations(aiResult.response) : [];
    const citationIds = [...new Set(citations.map(c => c.id))];
    
    // Get source information for citations (with security check)
    let citationSources = [];
    if (citationIds.length > 0) {
      citationSources = await getCitationSources(citationIds, orgId);
    }
    
    const responseData = { 
      success: true, 
      response: aiResult.response,
      citations: citations,
      citationSources: citationSources,
      guide: {
        name: guideContext.name,
        role: guideContext.role,
        personality: guideContext.personality
      }
    };
    if (aiResult.error) {
      responseData.serviceError = true;
    }
    res.json(responseData);
    
  } catch (err) {
    console.error('API guide chat error:', err);
    res.status(500).json({ success: false, error: 'Failed to chat with guide' });
  }
});

/**
 * POST /api/guide/opening - Generate AI opening greeting for a guide
 * This makes the AI "own" its greeting, so it remembers what it said
 * Supports guide_language parameter for localized greetings (used in preview mode)
 */
router.post('/guide/opening', async (req, res) => {
  try {
    const { step_id, guide_id, guide_language, journey_context } = req.body;
    const orgId = req.organizationId;
    
    // Out of AI questions: the client falls back to the guide's static greeting
    if (!(await hasAiCreditsLeft(orgId, 'maker'))) {
      return res.status(403).json({ success: false, code: 'AI_CREDITS_EXHAUSTED' });
    }
    
    // Two modes: step-based (step_id) or guide-based (guide_id for preview mode)
    let guideContext;
    let journeyContextStr = journey_context || '';
    
    if (step_id) {
      // Step-based: Get step with guide info
      const stepResult = await query(`
        SELECT s.*, j.title as journey_title, j.description as journey_description
        FROM steps s
        JOIN journeys j ON s.journey_id = j.id
        WHERE s.id = $1 AND j.organization_id = $2 AND s.type = 'guide'
      `, [step_id, orgId]);
      
      if (stepResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Guide step not found' });
      }
      
      const step = stepResult.rows[0];
      const basicProps = typeof step.basic_props === 'string' ? JSON.parse(step.basic_props) : step.basic_props;
      const advancedProps = typeof step.advanced_props === 'string' ? JSON.parse(step.advanced_props) : step.advanced_props;
      
      guideContext = {
        name: basicProps.name || step.title,
        role: basicProps.role || 'Guide',
        personality: basicProps.personality || 'friendly',
        customPersonality: basicProps.customPersonality || '',
        greeting: basicProps.greeting || '',
        instructions: advancedProps.ai_instructions || '',
        topics: advancedProps.topics || [],
        language: guide_language || 'en'
      };
      
      if (!journeyContextStr) {
        journeyContextStr = `
This guide is part of the journey: "${step.journey_title}"
${step.journey_description ? `Journey description: ${step.journey_description}` : ''}
Current location: ${step.title}
        `.trim();
      }
    } else if (guide_id) {
      // Guide-based: Get guide directly (for preview mode)
      const guideResult = await query(`
        SELECT * FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
      `, [guide_id, orgId]);
      
      if (guideResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Guide not found' });
      }
      
      const dbGuide = guideResult.rows[0];
      
      guideContext = {
        name: dbGuide.name,
        role: dbGuide.role || 'Guide',
        personality: dbGuide.personality || 'friendly',
        customPersonality: dbGuide.custom_personality || '',
        greeting: dbGuide.greeting || '',
        instructions: dbGuide.ai_instructions || '',
        language: guide_language || 'en'
      };
    } else {
      return res.status(400).json({ success: false, error: 'Either step_id or guide_id is required' });
    }
    
    // Generate AI opening and translate role in parallel for better performance
    const shouldTranslateRole = guide_language && guide_language !== 'en' && guideContext.role;
    
    let roleTranslationPromise;
    if (shouldTranslateRole) {
      const { translateText } = await import('../services/translation.js');
      roleTranslationPromise = translateText(guideContext.role, guide_language).catch(err => {
        console.warn('Failed to translate guide role:', err.message);
        return guideContext.role; // Return original on error
      });
    }
    
    // Generate the opening
    const aiResult = await generateGuideOpening(guideContext, journeyContextStr);
    
    // The opening is not a question: it does not count as an AI credit
    
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
        originalRole: guideContext.role,
        personality: guideContext.personality
      }
    });
    
  } catch (err) {
    console.error('API guide opening error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate opening' });
  }
});

// ============================================
// MEDIA & PEXELS
// ============================================

/**
 * GET /api/media/search - Search Pexels photos
 */
router.get('/media/search', async (req, res) => {
  try {
    const { q, page = 1, per_page = 15 } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Search query required (min 2 characters)' });
    }
    
    const results = await searchPhotos(q.trim(), parseInt(per_page), parseInt(page));
    
    res.json({
      success: true,
      ...results
    });
  } catch (err) {
    console.error('Media search error:', err);
    res.status(500).json({ success: false, error: 'Search failed' });
  }
});

/**
 * GET /api/media/suggestions - Get suggested photos based on step
 * Translates non-English titles and uses context-aware search terms
 */
router.get('/media/suggestions', async (req, res) => {
  try {
    const { type = 'space', title = '' } = req.query;

    const { terms, orientation } = await getSuggestedSearchTerms(type, title);
    const primaryTerm = terms[0] || 'office';
    const secondaryTerm = terms[1];

    // Run primary search, optionally a secondary to diversify results
    const opts = orientation ? { orientation } : {};
    const [primary, secondary] = await Promise.all([
      searchPhotos(primaryTerm, secondaryTerm ? 4 : 6, 1, opts),
      secondaryTerm ? searchPhotos(secondaryTerm, 4, 1, opts) : Promise.resolve({ photos: [] })
    ]);

    // Merge and deduplicate by photo id
    const seen = new Set();
    const merged = [];
    for (const photo of [...primary.photos, ...secondary.photos]) {
      if (!seen.has(photo.id)) {
        seen.add(photo.id);
        merged.push(photo);
      }
      if (merged.length >= 8) break;
    }

    res.json({
      success: true,
      suggested_term: primaryTerm,
      all_terms: terms,
      photos: merged,
      total_results: merged.length
    });
  } catch (err) {
    console.error('Media suggestions error:', err);
    res.status(500).json({ success: false, error: 'Failed to get suggestions' });
  }
});

/**
 * GET /api/media/curated - Get trending/curated photos
 */
router.get('/media/curated', async (req, res) => {
  try {
    const { page = 1, per_page = 15 } = req.query;
    
    const results = await getCuratedPhotos(parseInt(per_page), parseInt(page));
    
    res.json({
      success: true,
      ...results
    });
  } catch (err) {
    console.error('Media curated error:', err);
    res.status(500).json({ success: false, error: 'Failed to get curated photos' });
  }
});

/**
 * POST /api/media/download-pexels - Download photo from Pexels
 */
router.post('/media/download-pexels', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { photo, size = 'large' } = req.body;
    
    if (!photo || !photo.id) {
      return res.status(400).json({ success: false, error: 'Photo data required' });
    }
    
    // Ensure directories exist
    ensureMediaDirectories(orgId);
    
    // Download the photo
    const result = await downloadPhoto(orgId, photo, size);
    
    // Save to database - check if already exists first
    const existingMedia = await query(`
      SELECT * FROM media WHERE organization_id = $1 AND pexels_id = $2
    `, [orgId, result.pexels_id]);
    
    let mediaResult;
    if (existingMedia.rows.length > 0) {
      // Update existing
      mediaResult = await query(`
        UPDATE media SET url = $1, updated_at = NOW() WHERE id = $2 RETURNING *
      `, [result.url, existingMedia.rows[0].id]);
    } else {
      // Insert new
      mediaResult = await query(`
        INSERT INTO media (organization_id, uploaded_by, filename, original_name, mime_type, url, source, pexels_id, photographer, photographer_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `, [
        orgId,
        req.user.id,
        result.filename,
        result.alt || 'Pexels photo',
        'image/jpeg',
        result.url,
        'pexels',
        result.pexels_id,
        result.photographer,
        result.photographer_url
      ]);
    }
    
    // Queue image analysis in the background (non-blocking)
    // This generates an AI description for Step Assistants
    queueAnalysis(result.url, 'image').catch(err => {
      console.error('Failed to queue Pexels image analysis:', err.message);
    });
    
    res.json({
      success: true,
      media: mediaResult.rows[0],
      url: result.url,
      photographer: result.photographer,
      photographer_url: result.photographer_url
    });
  } catch (err) {
    console.error('Media download error:', err);
    res.status(500).json({ success: false, error: 'Download failed' });
  }
});

/**
 * POST /api/media/upload - Upload own image
 * Uses memory upload first to check for NSFW content before saving to disk
 */
router.post('/media/upload', memoryUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: req.t('errors.no_file_uploaded', 'No file uploaded') });
    }
    
    const orgId = req.organizationId;
    const file = req.file;

    // Derive the format from the file content: the client chooses mimetype and filename
    const imageType = await detectImageType(file.buffer);
    if (!imageType) {
      return res.status(400).json({ success: false, error: req.t('errors.invalid_image_type', 'This file is not a supported image. Upload a JPG, PNG, GIF or WebP file.'), code: 'INVALID_IMAGE_TYPE' });
    }
    
    // NSFW Check - only for images, and only if NudeNet service is available
    // NSFW check. Fails closed: an image that could not be checked is not stored
    const nsfwCheck = await isImageAllowed(file.buffer, `upload${imageType.ext}`);
    if (!nsfwCheck.allowed) {
      return rejectImage(req, res, nsfwCheck.reason);
    }
    
    // NSFW check passed or not applicable - save to disk
    const ext = imageType.ext;
    const filename = `${crypto.randomUUID()}${ext}`;
    const uploadDir = path.join(__dirname, '../../uploads/organizations', orgId, 'media');
    const filePath = path.join(uploadDir, filename);
    
    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    // Write file to disk
    fs.writeFileSync(filePath, file.buffer);
    
    const url = `/uploads/organizations/${orgId}/media/${filename}`;
    
    // Save to database
    const mediaResult = await query(`
      INSERT INTO media (organization_id, uploaded_by, filename, original_name, mime_type, size_bytes, url, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      orgId,
      req.user.id,
      filename,
      file.originalname,
      imageType.mime,
      file.size,
      url,
      'upload'
    ]);
    
    // Queue image analysis in the background (non-blocking)
    // This generates an AI description for Step Assistants
    if (file.mimetype.startsWith('image/')) {
      queueAnalysis(url, 'image').catch(err => {
        console.error('Failed to queue image analysis:', err.message);
      });
    }
    
    res.json({
      success: true,
      media: mediaResult.rows[0],
      url: url
    });
  } catch (err) {
    console.error('Media upload error:', err);
    res.status(500).json({ success: false, error: req.t('errors.upload_failed', 'Upload failed') });
  }
});

/**
 * GET /api/media/library - Get organization's media library
 */
router.get('/media/library', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { page = 1, per_page = 20, source } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(per_page);
    
    // "Library" should only show images already used within this organization
    // (prevents clutter + supports privacy expectations).
    let whereClause = `
      WHERE organization_id = $1
        AND (
          EXISTS (
            SELECT 1 FROM guides g
            WHERE g.organization_id = media.organization_id
              AND g.avatar_url = media.url
          )
          OR EXISTS (
            SELECT 1 FROM steps s
            JOIN journeys j ON s.journey_id = j.id
            WHERE j.organization_id = media.organization_id
              AND (
                (s.basic_props->>'image_url') = media.url
              )
          )
        )
    `;
    const params = [orgId];
    
    if (source && ['pexels', 'upload'].includes(source)) {
      whereClause += ' AND source = $2';
      params.push(source);
    }
    
    const result = await query(`
      SELECT * FROM media 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, parseInt(per_page), offset]);
    
    const countResult = await query(`
      SELECT COUNT(*) as total FROM media ${whereClause}
    `, params);
    
    res.json({
      success: true,
      media: result.rows,
      total: parseInt(countResult.rows[0].total),
      page: parseInt(page),
      per_page: parseInt(per_page)
    });
  } catch (err) {
    console.error('Media library error:', err);
    res.status(500).json({ success: false, error: 'Failed to load library' });
  }
});

/**
 * DELETE /api/media/:id - Delete media file
 */
router.delete('/media/:id', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const mediaId = req.params.id;
    
    // Get media info first
    const mediaResult = await query(`
      SELECT * FROM media WHERE id = $1 AND organization_id = $2
    `, [mediaId, orgId]);
    
    if (mediaResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Media not found' });
    }
    
    const media = mediaResult.rows[0];
    
    // Delete file from disk (supports both old and new URL structures)
    const filePath = getMediaFilePath(media.url);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // Delete from database
    await query('DELETE FROM media WHERE id = $1', [mediaId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Media delete error:', err);
    res.status(500).json({ success: false, error: 'Delete failed' });
  }
});

// ============================================
// HEALTH CHECK
// ============================================

router.get('/health', (req, res) => {
  res.json({ status: 'ok', user: req.user?.email });
});

// ============================================
// HELPERS
// ============================================

function getDefaultTitle(type) {
  const titles = {
    space: 'New Space',
    guide: 'New Guide',
    content: 'New Content',
    challenge: 'New Challenge',
    form: 'New Form',
    poll: 'New Poll',
    nested_journey: 'New Sub-Journey'
  };
  return titles[type] || 'New Step';
}

function getDefaultBasicProps(type, req = null) {
  // Helper to get translation if req is available
  const t = (key) => {
    if (req && typeof req.t === 'function') {
      const translated = req.t(key);
      return translated !== key ? translated : key;
    }
    return key;
  };

  const defaults = {
    space: {
      description: '', // Empty so HTML placeholder is visible
      image_url: null
    },
    guide: {
      name: t('builder.defaults.guideName') || 'Guide',
      role: t('builder.defaults.guideRole') || 'Helpful Guide',
      avatar_url: null,
      greeting: t('builder.defaults.guideGreeting') || 'Hello! How can I help you?',
      personality: 'friendly'
    },
    content: {
      body: '',
      media_type: 'markdown'
    },
    challenge: {
      type: 'multiple_choice',
      questions: [{
        id: crypto.randomUUID(),
        question: '',
        options: [
          { id: 'a', text: t('builder.defaults.challengeOptionA') || 'Option A', correct: false },
          { id: 'b', text: t('builder.defaults.challengeOptionB') || 'Option B', correct: true }
        ]
      }]
    },
    form: {
      description: '', // Empty so HTML placeholder is visible
      recipient_email: '',
      email_subject: t('builder.defaults.formEmailSubject') || 'Form submission: {{journey_title}}',
      fields: [{
        id: crypto.randomUUID(),
        label: '', // Empty so HTML placeholder is visible
        type: 'text',
        required: true,
        options: ''
      }]
    },
    poll: {
      question: t('builder.defaults.pollQuestion') || 'What do you think?',
      options: [
        { id: crypto.randomUUID(), text: t('builder.defaults.pollOption1') || 'Option 1' },
        { id: crypto.randomUUID(), text: t('builder.defaults.pollOption2') || 'Option 2' }
      ],
      allow_multiple: false,
      show_results: true
    },
    nested_journey: {
      nested_journey_id: null
    }
  };
  return defaults[type] || {};
}

// ============================================
// EMAIL API
// ============================================

/**
 * GET /api/email/templates - Get available email templates
 */
router.get('/email/templates', (req, res) => {
  res.json({
    success: true,
    templates: getEmailTemplates()
  });
});

/**
 * GET /api/email/variables - Get available template variables
 */
router.get('/email/variables', (req, res) => {
  res.json({
    success: true,
    variables: getTemplateVariables()
  });
});

/**
 * POST /api/email/preview - Generate email preview (without sending)
 */
router.post('/email/preview', async (req, res) => {
  try {
    const { 
      to = 'preview@example.com',
      subject = 'Preview',
      body: _body = 'This is a preview of your email.',
      template_type: _template_type = 'journey_info',
      journey_id,
      step_id,
      link,
      link_text
    } = req.body;
    const orgId = req.organizationId;
    
    // Get organization info
    const orgResult = await query(
      'SELECT name FROM organizations WHERE id = $1',
      [orgId]
    );
    const companyName = orgResult.rows[0]?.name || 'Gryffi';
    
    // Get journey/step info
    let journeyTitle = '';
    let stepTitle = '';
    if (journey_id) {
      const journeyResult = await query(
        'SELECT title FROM journeys WHERE id = $1 AND organization_id = $2',
        [journey_id, orgId]
      );
      journeyTitle = journeyResult.rows[0]?.title || '';
    }
    if (step_id) {
      const stepResult = await query(
        'SELECT s.title FROM steps s JOIN journeys j ON j.id = s.journey_id WHERE s.id = $1 AND j.organization_id = $2',
        [step_id, orgId]
      );
      stepTitle = stepResult.rows[0]?.title || '';
    }
    
    // Generate preview variables
    const variables = {
      user_name: 'John Smith',
      user_first_name: 'John',
      user_email: to,
      company_name: companyName,
      journey_title: journeyTitle || 'Onboarding Journey',
      step_title: stepTitle || 'Current Step',
      subject: subject,
      ...(link && { custom_link: link }),
      ...(link_text && { custom_link_text: link_text })
    };
    
    res.json({
      success: true,
      preview: {
        to: to,
        subject: subject,
        variables: variables
      }
    });
    
  } catch (err) {
    console.error('API email preview error:', err);
    res.status(500).json({ success: false, error: 'Could not generate preview' });
  }
});

// ============================================
// AUTOMATION TRIGGERS
// ============================================

/**
 * POST /api/automations/trigger - Trigger automation emails
 * Used when journey events occur (start, complete, step enter/complete)
 */
router.post('/automations/trigger', async (req, res) => {
  try {
    const { 
      trigger,      // 'on_journey_start', 'on_journey_complete', 'on_step_enter', 'on_step_complete', 'on_path:uuid'
      journey_id,
      step_id,
      path_id,
      user_email    // Email of the user going through the journey
    } = req.body;
    const orgId = req.organizationId;
    
    if (!trigger || !journey_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Trigger type and journey_id are required' 
      });
    }
    
    // Skip automations for demo journeys (they don't have real automations)
    if (journey_id.startsWith('demo-')) {
      return res.json({ success: true, triggered: 0, skipped: 'demo_journey' });
    }
    
    // Get journey with automations
    const journeyResult = await query(
      'SELECT * FROM journeys WHERE id = $1 AND organization_id = $2',
      [journey_id, orgId]
    );
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const journey = journeyResult.rows[0];
    const journeySettings = typeof journey.settings === 'string' 
      ? JSON.parse(journey.settings) 
      : (journey.settings || {});
    const journeyAutomations = journeySettings.automations || [];
    
    // Get step with automations if step_id provided
    let step = null;
    let stepAutomations = [];
    if (step_id) {
      // Bind the step to this organization: step ids of public journeys are visible to anyone
      const stepResult = await query(
        'SELECT s.* FROM steps s JOIN journeys j ON j.id = s.journey_id WHERE s.id = $1 AND j.organization_id = $2',
        [step_id, orgId]
      );
      if (stepResult.rows.length > 0) {
        step = stepResult.rows[0];
        const stepAdvancedProps = typeof step.advanced_props === 'string'
          ? JSON.parse(step.advanced_props)
          : (step.advanced_props || {});
        stepAutomations = stepAdvancedProps.automations || [];
        console.log(`[Automation] Step ${step_id} (${step.title}) has ${stepAutomations.length} automations:`, stepAutomations.map(a => a.trigger));
      } else {
        console.log(`[Automation] Step ${step_id} not found`);
      }
    } else {
      console.log(`[Automation] No step_id provided for trigger: ${trigger}`);
    }
    
    // Get user info - use provided email or fall back to current session user
    let user = null;
    const emailToUse = user_email || req.user?.email;
    if (emailToUse) {
      const userResult = await query(
        'SELECT * FROM users WHERE email = $1 AND organization_id = $2',
        [emailToUse, orgId]
      );
      if (userResult.rows.length > 0) {
        user = userResult.rows[0];
      } else if (req.user) {
        // If no user found but we have a session user, use their info
        user = req.user;
      }
    } else if (req.user) {
      // No email provided, use current session user
      user = req.user;
    }
    
    // Get organization info
    const orgResult = await query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    const organization = orgResult.rows[0];
    
    // Build context
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
    
    // Process automations
    const results = [];
    for (const automation of automationsToProcess) {
      const result = await sendAutomationEmail(automation, context);
      results.push({ trigger: automation.trigger, template: automation.template, ...result });
    }
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    res.json({
      success: true,
      message: `Processed ${automationsToProcess.length} automation(s)`,
      triggered: successCount,
      failed: failCount,
      results
    });
    
  } catch (err) {
    console.error('API automation trigger error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Could not process automations: ' + err.message 
    });
  }
});

/**
 * POST /api/automations/test - Test an automation by sending a test email
 */
router.post('/automations/test', async (req, res) => {
  try {
    const { 
      automation,   // The automation object to test
      test_email,   // Email to send the test to
      journey_id,
      step_id
    } = req.body;
    const orgId = req.organizationId;
    
    if (!automation || !test_email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Automation config and test email are required' 
      });
    }

    // Test mails only go to makers of this organization. The body is free
    // text from the request, so any other recipient would make this an open
    // mail relay on our domain.
    const teamMember = await query(
      'SELECT 1 FROM users WHERE organization_id = $1 AND LOWER(email) = LOWER($2) AND is_active = true',
      [orgId, String(test_email).trim()]
    );
    if (teamMember.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: req.t('errors.test_email_not_team_member', 'Test emails can only go to members of your team. Enter the email address of a team member.')
      });
    }
    
    // Get journey info
    let journey = { title: 'Test Journey' };
    if (journey_id) {
      const journeyResult = await query(
        'SELECT title FROM journeys WHERE id = $1 AND organization_id = $2',
        [journey_id, orgId]
      );
      if (journeyResult.rows.length > 0) {
        journey = journeyResult.rows[0];
      }
    }
    
    // Get step info
    let step = { title: 'Test Step' };
    if (step_id) {
      const stepResult = await query(
        'SELECT s.title FROM steps s JOIN journeys j ON j.id = s.journey_id WHERE s.id = $1 AND j.organization_id = $2',
        [step_id, orgId]
      );
      if (stepResult.rows.length > 0) {
        step = stepResult.rows[0];
      }
    }
    
    // Get organization
    const orgResult = await query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    const organization = orgResult.rows[0];
    
    // Create test context - use logged in user's name for more realistic test
    const context = {
      user: { 
        email: test_email, 
        first_name: req.user?.first_name || 'Test', 
        last_name: req.user?.last_name || 'User' 
      },
      journey,
      step,
      organization
    };
    
    // Override recipient to test email
    const testAutomation = { ...automation, recipient: test_email };
    
    // Modify subject to indicate it's a test
    testAutomation.subject = `[TEST] ${testAutomation.subject || 'Automation Test'}`;
    
    const result = await sendAutomationEmail(testAutomation, context);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Test email sent successfully',
        emailId: result.emailId
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to send test email'
      });
    }
    
  } catch (err) {
    console.error('API automation test error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Could not send test email: ' + err.message 
    });
  }
});

// ============================================
// KNOWLEDGE ENGINE API
// ============================================

/**
 * Reject a knowledge upload when the knowledge base is already full.
 * A source that is too large for the room left fails after chunking instead
 * (see assertKnowledgeRoom in services/knowledge.js).
 * @returns {Promise<boolean>} true when the response has been sent
 */
async function rejectWhenKnowledgeFull(req, res) {
  const limit = await checkLimit(req.organizationId, RESOURCE_TYPES.KNOWLEDGE_CHUNKS);
  if (limit.allowed) return false;
  if (req.file) {
    try { fs.unlinkSync(req.file.path); } catch (_e) {}
  }
  const message = req.t('subscription.limits.chunksExceeded');
  res.status(403).json({ success: false, code: 'LIMIT_EXCEEDED', limitType: 'knowledgeChunks', error: message, message });
  return true;
}

/**
 * GET /api/knowledge/supported-types - Get supported file types
 */
router.get('/knowledge/supported-types', (req, res) => {
  res.json({
    success: true,
    types: getSupportedFileTypes()
  });
});

/**
 * GET /api/knowledge/:guideStepId - Get all knowledge sources for a guide
 */
router.get('/knowledge/:guideStepId', async (req, res) => {
  try {
    const { guideStepId } = req.params;
    const orgId = req.organizationId;
    
    // Verify the step belongs to this organization
    const stepResult = await query(
      `SELECT s.id FROM steps s 
       JOIN journeys j ON s.journey_id = j.id 
       WHERE s.id = $1 AND j.organization_id = $2`,
      [guideStepId, orgId]
    );
    
    if (stepResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide step not found' });
    }
    
    const sources = (await getKnowledgeSources(guideStepId))
      .map(source => ({ ...source, error_message: formatKnowledgeError(source.error_message, req.t) }));
    const stats = await getKnowledgeStats(guideStepId);
    
    res.json({
      success: true,
      sources,
      stats
    });
    
  } catch (err) {
    console.error('API knowledge get error:', err);
    res.status(500).json({ success: false, error: 'Could not fetch knowledge sources' });
  }
});

/**
 * POST /api/knowledge/:guideStepId/upload - Upload a file for knowledge processing
 */
router.post('/knowledge/:guideStepId/upload', knowledgeUpload.single('file'), async (req, res) => {
  try {
    const { guideStepId } = req.params;
    const orgId = req.organizationId;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    
    if (await rejectWhenKnowledgeFull(req, res)) return;
    
    // Verify the step belongs to this organization and is a guide
    const stepResult = await query(
      `SELECT s.id, s.type FROM steps s 
       JOIN journeys j ON s.journey_id = j.id 
       WHERE s.id = $1 AND j.organization_id = $2`,
      [guideStepId, orgId]
    );
    
    if (stepResult.rows.length === 0) {
      // Clean up uploaded file
      fs.unlinkSync(file.path);
      return res.status(404).json({ success: false, error: 'Guide step not found' });
    }
    
    if (stepResult.rows[0].type !== 'guide') {
      fs.unlinkSync(file.path);
      return res.status(400).json({ success: false, error: 'Knowledge can only be added to AI Guide steps' });
    }
    
    // Create knowledge source entry
    const source = await createKnowledgeSource({
      guideStepId,
      organizationId: orgId,
      sourceType: 'file',
      sourceName: file.originalname,
      originalFilename: file.originalname,
      contentType: file.mimetype,
      fileSize: file.size
    });
    
    // Start processing in background
    processFile(source.id, file.path, file.mimetype)
      .then(result => {
        console.log(`[Knowledge] File processing completed: ${result.success ? 'success' : 'failed'}`);
      })
      .catch(err => {
        console.error('[Knowledge] File processing error:', err);
      });
    
    res.json({
      success: true,
      source: {
        id: source.id,
        sourceName: source.source_name,
        status: source.status
      },
      message: 'File uploaded and processing started'
    });
    
  } catch (err) {
    console.error('API knowledge upload error:', err);
    // Clean up file on error
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_e) {}
    }
    res.status(500).json({ success: false, error: 'Could not upload file: ' + err.message });
  }
});

/**
 * POST /api/knowledge/:guideStepId/text - Add text as knowledge source
 */
router.post('/knowledge/:guideStepId/text', async (req, res) => {
  try {
    const { guideStepId } = req.params;
    const { name, text } = req.body;
    const orgId = req.organizationId;
    
    if (!name || !text) {
      return res.status(400).json({ success: false, error: 'Name and text are required' });
    }
    
    if (text.length < 10) {
      return res.status(400).json({ success: false, error: 'Text must be at least 10 characters' });
    }
    
    if (await rejectWhenKnowledgeFull(req, res)) return;
    
    // Verify the step belongs to this organization and is a guide
    const stepResult = await query(
      `SELECT s.id, s.type FROM steps s 
       JOIN journeys j ON s.journey_id = j.id 
       WHERE s.id = $1 AND j.organization_id = $2`,
      [guideStepId, orgId]
    );
    
    if (stepResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide step not found' });
    }
    
    if (stepResult.rows[0].type !== 'guide') {
      return res.status(400).json({ success: false, error: 'Knowledge can only be added to AI Guide steps' });
    }
    
    // Create knowledge source entry
    const source = await createKnowledgeSource({
      guideStepId,
      organizationId: orgId,
      sourceType: 'text',
      sourceName: name,
      rawText: text
    });
    
    // Start processing in background
    processText(source.id)
      .then(result => {
        console.log(`[Knowledge] Text processing completed: ${result.success ? 'success' : 'failed'}`);
      })
      .catch(err => {
        console.error('[Knowledge] Text processing error:', err);
      });
    
    res.json({
      success: true,
      source: {
        id: source.id,
        sourceName: source.source_name,
        status: source.status
      },
      message: 'Text added and processing started'
    });
    
  } catch (err) {
    console.error('API knowledge text error:', err);
    res.status(500).json({ success: false, error: 'Could not add text: ' + err.message });
  }
});

/**
 * DELETE /api/knowledge/:guideStepId/:sourceId - Delete a knowledge source
 */
router.delete('/knowledge/:guideStepId/:sourceId', async (req, res) => {
  try {
    const { guideStepId, sourceId } = req.params;
    const orgId = req.organizationId;
    
    // Verify the step belongs to this organization
    const stepResult = await query(
      `SELECT s.id FROM steps s 
       JOIN journeys j ON s.journey_id = j.id 
       WHERE s.id = $1 AND j.organization_id = $2`,
      [guideStepId, orgId]
    );
    
    if (stepResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide step not found' });
    }
    
    await deleteKnowledgeSource(sourceId, orgId);
    
    res.json({ success: true, message: 'Knowledge source deleted' });
    
  } catch (err) {
    console.error('API knowledge delete error:', err);
    res.status(500).json({ success: false, error: 'Could not delete knowledge source: ' + err.message });
  }
});

/**
 * GET /api/knowledge/:guideStepId/status/:sourceId - Get processing status
 */
router.get('/knowledge/:guideStepId/status/:sourceId', async (req, res) => {
  try {
    const { guideStepId, sourceId } = req.params;
    const orgId = req.organizationId;
    
    const result = await query(
      `SELECT ks.* FROM knowledge_sources ks
       JOIN steps s ON ks.guide_step_id = s.id
       JOIN journeys j ON s.journey_id = j.id
       WHERE ks.id = $1 AND ks.guide_step_id = $2 AND j.organization_id = $3`,
      [sourceId, guideStepId, orgId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Source not found' });
    }
    
    const source = result.rows[0];
    
    res.json({
      success: true,
      status: source.status,
      chunksCount: source.chunks_count,
      errorMessage: formatKnowledgeError(source.error_message, req.t)
    });
    
  } catch (err) {
    console.error('API knowledge status error:', err);
    res.status(500).json({ success: false, error: 'Could not get status' });
  }
});

// ============================================
// FORMS
// ============================================

/**
 * POST /api/forms/submit - Submit a form and send email to recipient
 * Used by builder preview mode (authenticated makers testing their journey).
 * Preview submissions are NOT stored as submissions (they would pollute
 * Analytics), but uploaded files ARE stored so the email can contain the
 * same secure download links as real player submissions.
 */
router.post('/forms/submit', async (req, res) => {
  try {
    const { journey_id, step_id, step_title, responses, attachments } = req.body;
    const orgId = req.organizationId;
    
    // Skip form submission for demo journeys (they are just for demonstration)
    if (journey_id && journey_id.startsWith('demo-')) {
      return res.json({ success: true, skipped: 'demo_journey', message: 'Form submission skipped for demo journey' });
    }

    // Recipient and subject come from the saved step, never from the request:
    // otherwise this route could send mail with our domain to any address.
    const stepCheck = await query(
      `SELECT s.basic_props FROM steps s
       JOIN journeys j ON j.id = s.journey_id
       WHERE s.id = $1 AND s.journey_id = $2 AND j.organization_id = $3`,
      [step_id, journey_id, orgId]
    );
    if (stepCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Step not found' });
    }
    const recipient_email = stepCheck.rows[0].basic_props?.recipient_email;
    const email_subject = stepCheck.rows[0].basic_props?.email_subject;
    
    if (!recipient_email) {
      return res.status(400).json({ success: false, error: 'No recipient email configured' });
    }
    
    if (!responses || Object.keys(responses).length === 0) {
      return res.status(400).json({ success: false, error: 'No form responses provided' });
    }
    
    // Validate and decode uploaded files
    let files;
    try {
      files = processAttachments(attachments);
    } catch (attachErr) {
      return res.status(400).json({ success: false, error: attachErr.message });
    }

    // Images are checked for NSFW content before anything is stored
    const imageCheck = await checkAttachmentImages(files);
    if (!imageCheck.allowed) {
      return rejectImage(req, res, imageCheck.reason);
    }
    
    // Get journey title, step fields and organization info including language
    const journeyResult = await query('SELECT title FROM journeys WHERE id = $1 AND organization_id = $2', [journey_id, orgId]);
    const journeyTitle = journeyResult.rows[0]?.title || 'Unknown Journey';
    
    const stepResult = await query('SELECT basic_props FROM steps WHERE id = $1 AND journey_id = $2', [step_id, journey_id]);
    const stepFields = stepResult.rows[0]?.basic_props?.fields || null;
    
    const orgResult = await query("SELECT name, settings->>'default_language' as org_language FROM organizations WHERE id = $1", [orgId]);
    const companyName = orgResult.rows[0]?.name || 'Gryffi';
    const orgLanguage = orgResult.rows[0]?.org_language || 'en';
    
    // Store uploaded files with secure download tokens (no submission row for
    // preview mode; both submission references stay NULL)
    const storedFiles = await storeSubmissionFiles({
      orgId,
      journeyId: journey_id,
      stepId: step_id,
      files
    });
    
    // Build email body (org language, themed, with download links)
    const submitterName = req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;
    const emailBody = buildFormSubmissionEmailBody({
      language: orgLanguage,
      journeyTitle,
      formTitle: step_title || 'Form',
      submitterName,
      submitterEmail: req.user.email,
      companyName,
      responses,
      fields: stepFields,
      files: storedFiles
    });
    const subject = email_subject || buildFormSubmissionSubject(orgLanguage, journeyTitle);
    
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
    
    if (result.success) {
      // Log the email
      await query(`
        INSERT INTO email_logs 
          (organization_id, user_id, journey_id, step_id, to_email, subject, template_type, email_provider_id, status, variables)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        orgId,
        req.user.id,
        journey_id,
        step_id,
        recipient_email,
        subject,
        'form_submission',
        result.emailId || null,
        'sent',
        JSON.stringify({ responses, files: storedFiles.map(f => f.original_name) })
      ]);
      
      res.json({ success: true, message: 'Form submitted successfully' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to send form email' });
    }
    
  } catch (err) {
    console.error('API form submit error:', err);
    res.status(500).json({ success: false, error: 'Could not submit form: ' + err.message });
  }
});

/**
 * GET /api/analytics/form-submissions - List form submissions for Analytics
 * Only admins and managers can view submitted form data (may contain
 * personal information). Strictly organization-scoped (org filter + RLS).
 */
router.get('/analytics/form-submissions', async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ success: false, error: 'Permission denied' });
    }
    
    const orgId = req.organizationId;
    
    // Private (magic link) and public journey submissions combined.
    // COALESCE keeps archived titles visible after journey/step deletion.
    const submissionsResult = await query(`
      SELECT s.id, 'private' AS source,
             COALESCE(j.title, s.journey_title) AS journey_title,
             COALESCE(st.title, s.step_title) AS step_title,
             TRIM(COALESCE(eu.first_name, '') || ' ' || COALESCE(eu.last_name, '')) AS submitter_name,
             eu.email AS submitter_email,
             s.responses, s.email_sent, s.created_at
      FROM private_form_submissions s
      LEFT JOIN journeys j ON s.journey_id = j.id
      LEFT JOIN steps st ON s.step_id = st.id
      LEFT JOIN end_users eu ON s.end_user_id = eu.id
      WHERE s.organization_id = $1
      
      UNION ALL
      
      SELECT p.id, 'public' AS source,
             COALESCE(j.title, p.journey_title) AS journey_title,
             COALESCE(st.title, p.step_title) AS step_title,
             TRIM(COALESCE(pp.first_name, '') || ' ' || COALESCE(pp.last_name, '')) AS submitter_name,
             pp.email AS submitter_email,
             p.responses, p.email_sent, p.created_at
      FROM public_form_submissions p
      LEFT JOIN journeys j ON p.journey_id = j.id
      LEFT JOIN steps st ON p.step_id = st.id
      LEFT JOIN public_participants pp ON p.participant_id = pp.id
      WHERE p.organization_id = $1
      
      ORDER BY created_at DESC
      LIMIT 500
    `, [orgId]);
    
    // Attach uploaded files per submission
    const submissionIds = submissionsResult.rows.map(r => r.id);
    const filesBySubmission = {};
    if (submissionIds.length > 0) {
      const filesResult = await query(`
        SELECT id, private_submission_id, public_submission_id,
               field_label, original_name, mime_type, size_bytes, download_count
        FROM form_submission_files
        WHERE organization_id = $1
          AND (private_submission_id = ANY($2) OR public_submission_id = ANY($2))
        ORDER BY created_at ASC
      `, [orgId, submissionIds]);
      
      for (const file of filesResult.rows) {
        const submissionId = file.private_submission_id || file.public_submission_id;
        if (!filesBySubmission[submissionId]) filesBySubmission[submissionId] = [];
        filesBySubmission[submissionId].push({
          id: file.id,
          field_label: file.field_label,
          original_name: file.original_name,
          mime_type: file.mime_type,
          size_bytes: file.size_bytes,
          size_label: formatFileSize(file.size_bytes),
          download_count: file.download_count
        });
      }
    }
    
    const submissions = submissionsResult.rows.map(row => ({
      ...row,
      files: filesBySubmission[row.id] || []
    }));
    
    res.json({ success: true, submissions });
  } catch (err) {
    console.error('API form submissions error:', err);
    res.status(500).json({ success: false, error: 'Failed to load form submissions' });
  }
});

/**
 * GET /api/analytics/form-submissions/files/:fileId/download
 * Authenticated download of a form submission file for Analytics.
 * Only admins and managers of the owning organization.
 */
router.get('/analytics/form-submissions/files/:fileId/download', async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ success: false, error: 'Permission denied' });
    }
    
    const { fileId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    
    // Organization check on top of RLS: never serve another org's file
    const result = await query(`
      SELECT id, original_name, storage_path
      FROM form_submission_files
      WHERE id = $1 AND organization_id = $2
    `, [fileId, req.organizationId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    
    const file = result.rows[0];
    const absolutePath = resolveFormFilePath(file.storage_path);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.download(absolutePath, file.original_name);
  } catch (err) {
    console.error('API form file download error:', err);
    res.status(500).json({ success: false, error: 'Failed to download file' });
  }
});

// ============================================
// CENTRAL GUIDE LIBRARY
// ============================================

/**
 * GET /api/guides - List all guides for organization
 */
router.get('/guides', async (req, res) => {
  try {
    const orgId = req.organizationId;
    
    const result = await query(`
      SELECT g.*, 
             (SELECT COUNT(*) FROM knowledge_sources WHERE guide_id = g.id) as knowledge_count,
             (SELECT COUNT(*) FROM journeys WHERE guide_id = g.id AND deleted_at IS NULL) as journey_count
      FROM guides g 
      WHERE g.organization_id = $1 AND g.deleted_at IS NULL
      ORDER BY g.created_at DESC
    `, [orgId]);
    
    res.json({ success: true, guides: result.rows });
  } catch (err) {
    console.error('API get guides error:', err);
    res.status(500).json({ success: false, error: 'Failed to load guides' });
  }
});

/**
 * GET /api/guides/trash - Get all deleted guides (trash)
 * Only admin and manager can view trash
 * NOTE: This route MUST be before /guides/:id to avoid 'trash' being matched as an id
 */
router.get('/guides/trash', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const userRole = req.user?.role;

    // Check permissions: only admin and manager can view trash
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ 
        success: false, 
        error: req.t('guides.delete.noPermission') 
      });
    }

    const guides = await query(`
      SELECT g.*, 
             (SELECT COUNT(*) FROM knowledge_sources WHERE guide_id = g.id) as knowledge_count
      FROM guides g
      WHERE g.organization_id = $1 AND g.deleted_at IS NOT NULL
      ORDER BY g.deleted_at DESC
    `, [orgId]);

    res.json({ success: true, guides: guides.rows });

  } catch (err) {
    console.error('API get guides trash error:', err);
    res.status(500).json({ success: false, error: 'Failed to load trash' });
  }
});

/**
 * GET /api/guides/:id - Get single guide with knowledge sources
 */
router.get('/guides/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.organizationId;
    
    const guideResult = await query(`
      SELECT * FROM guides WHERE id = $1 AND organization_id = $2
    `, [id, orgId]);
    
    if (guideResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    const knowledgeResult = await query(`
      SELECT id, source_type, source_name, status, chunks_count, created_at
      FROM knowledge_sources 
      WHERE guide_id = $1 AND organization_id = $2
      ORDER BY created_at DESC
    `, [id, orgId]);
    
    res.json({ 
      success: true, 
      guide: guideResult.rows[0],
      knowledge_sources: knowledgeResult.rows
    });
  } catch (err) {
    console.error('API get guide error:', err);
    res.status(500).json({ success: false, error: 'Failed to load guide' });
  }
});

/**
 * POST /api/guides - Create a new guide
 */
router.post('/guides', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { name, role, personality, greeting, ai_instructions, avatar_url } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'Guide name is required' });
    }
    
    // Check tier limit for guides
    const limitCheck = await checkLimit(orgId, RESOURCE_TYPES.GUIDES);
    if (!limitCheck.allowed) {
      return res.status(403).json({
        success: false,
        code: 'LIMIT_EXCEEDED',
        error: req.t('subscription.limits.guidesExceeded'),
        limitType: 'guides',
        current: limitCheck.current,
        limit: limitCheck.limit,
        tier: limitCheck.tier,
        tierDisplayName: limitCheck.tierDisplayName
      });
    }
    
    const result = await query(`
      INSERT INTO guides (organization_id, name, role, personality, greeting, ai_instructions, avatar_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [orgId, name, role || null, personality || 'friendly', greeting || null, ai_instructions || null, avatar_url || null]);
    
    // Log usage event
    await logUsageEvent(orgId, 'guide_create', 'guide', result.rows[0].id, req.user?.id);
    
    res.json({ success: true, guide: result.rows[0] });
  } catch (err) {
    console.error('API create guide error:', err);
    res.status(500).json({ success: false, error: 'Failed to create guide' });
  }
});

/**
 * PUT /api/guides/:id - Update a guide
 */
router.put('/guides/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.organizationId;
    const { name, role, personality, greeting, ai_instructions, avatar_url, is_active, language } = req.body;
    
    const result = await query(`
      UPDATE guides 
      SET name = COALESCE($1, name),
          role = COALESCE($2, role),
          personality = COALESCE($3, personality),
          greeting = COALESCE($4, greeting),
          ai_instructions = COALESCE($5, ai_instructions),
          avatar_url = COALESCE($6, avatar_url),
          is_active = COALESCE($7, is_active),
          language = COALESCE($8, language),
          updated_at = NOW()
      WHERE id = $9 AND organization_id = $10
      RETURNING *
    `, [name, role, personality, greeting, ai_instructions, avatar_url, is_active, language, id, orgId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    res.json({ success: true, guide: result.rows[0] });
  } catch (err) {
    console.error('API update guide error:', err);
    res.status(500).json({ success: false, error: 'Failed to update guide' });
  }
});

/**
 * DELETE /api/guides/:id - Soft delete guide (move to trash)
 * Only admin and manager can delete
 */
router.delete('/guides/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.organizationId;
    const userRole = req.user?.role;

    // Check permissions: only admin and manager can delete
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ 
        success: false, 
        error: req.t('guides.delete.noPermission') 
      });
    }

    // Verify guide belongs to organization and is not already deleted
    const guideCheck = await query(
      'SELECT id FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, orgId]
    );

    if (guideCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }

    // Check if guide is used by any active journey: as journey guide, in a
    // guide step or as step assistant
    const usageCheck = await query(`
      SELECT COUNT(*) FROM journeys j
      WHERE j.organization_id = $2 AND j.deleted_at IS NULL
        AND (j.guide_id = $1 OR EXISTS (
          SELECT 1 FROM steps s
          WHERE s.journey_id = j.id
            AND (s.basic_props->>'guide_id' = $1::text OR s.advanced_props->>'assistant_guide_id' = $1::text)
        ))
    `, [id, orgId]);

    if (parseInt(usageCheck.rows[0].count) > 0) {
      return res.status(400).json({ 
        success: false, 
        error: req.t('guides.delete.assignedToJourneys')
      });
    }

    // Soft delete: set deleted_at timestamp
    await query(
      'UPDATE guides SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2',
      [id, orgId]
    );

    res.json({ success: true, message: req.t('guides.delete.success') });

  } catch (err) {
    console.error('API delete guide error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete guide' });
  }
});

/**
 * POST /api/guides/:id/restore - Restore guide from trash
 * Only admin and manager can restore
 */
router.post('/guides/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.organizationId;
    const userRole = req.user?.role;

    // Check permissions: only admin and manager can restore
    if (userRole !== 'admin' && userRole !== 'manager') {
      return res.status(403).json({ 
        success: false, 
        error: req.t('guides.delete.noPermission') 
      });
    }

    // Verify guide belongs to organization and is deleted
    const guideCheck = await query(
      'SELECT id FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NOT NULL',
      [id, orgId]
    );

    if (guideCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found in trash' });
    }

    // Check guide limit before restoring
    const usageData = await getOrganizationUsageWithLimits(orgId);
    if (usageData && usageData.usage.guides.isAtLimit) {
      return res.status(403).json({ 
        success: false, 
        code: 'LIMIT_EXCEEDED',
        limitType: 'guides',
        error: req.t('guides.restore.limitExceeded')
      });
    }

    // Restore: clear deleted_at timestamp and deactivate guide
    await query(
      `UPDATE guides SET deleted_at = NULL, is_active = false, updated_at = NOW() WHERE id = $1 AND organization_id = $2`,
      [id, orgId]
    );

    res.json({ success: true, message: req.t('guides.restore.success') });

  } catch (err) {
    console.error('API restore guide error:', err);
    res.status(500).json({ success: false, error: 'Failed to restore guide' });
  }
});

/**
 * DELETE /api/guides/:id/permanent - Permanently delete a guide
 * Only admin can permanently delete
 */
router.delete('/guides/:id/permanent', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.organizationId;
    const userRole = req.user?.role;

    // Check permissions: only admin can permanently delete
    if (userRole !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: req.t('guides.delete.noPermission') 
      });
    }

    // Verify guide belongs to organization and is deleted
    const guideCheck = await query(
      'SELECT id FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NOT NULL',
      [id, orgId]
    );

    if (guideCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found in trash' });
    }

    // Permanently delete: cascade will handle related records
    await query(
      'DELETE FROM guides WHERE id = $1 AND organization_id = $2',
      [id, orgId]
    );

    res.json({ success: true, message: req.t('guides.delete.permanentSuccess') });

  } catch (err) {
    console.error('API permanent delete guide error:', err);
    res.status(500).json({ success: false, error: 'Failed to permanently delete guide' });
  }
});


/**
 * POST /api/guides/:id/copy - Copy a guide with all knowledge sources and chunks
 * Admin, manager, and member can copy
 */
router.post('/guides/:id/copy', async (req, res) => {
  try {
    const guideId = req.params.id;
    const orgId = req.organizationId;
    const userRole = req.user?.role;
    
    // Check permissions: viewer cannot copy
    if (userRole === 'viewer') {
      return res.status(403).json({ 
        success: false, 
        error: req.t('guides.copy.noPermission')
      });
    }
    
    // Check guide limit before copying
    const usageData = await getOrganizationUsageWithLimits(orgId);
    if (usageData && usageData.usage.guides.isAtLimit) {
      return res.status(403).json({ 
        success: false, 
        code: 'LIMIT_EXCEEDED',
        limitType: 'guides',
        error: req.t('subscription.limits.guidesExceeded')
      });
    }
    
    // Get the original guide (exclude deleted guides)
    const guideResult = await query(
      'SELECT * FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [guideId, orgId]
    );
    
    if (guideResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    const originalGuide = guideResult.rows[0];
    
    // The copied knowledge chunks must fit in the knowledge limit
    const chunkCountResult = await query(
      'SELECT COUNT(*)::int AS count FROM knowledge_chunks WHERE guide_id = $1 AND organization_id = $2',
      [guideId, orgId]
    );
    const copiedChunks = chunkCountResult.rows[0].count;
    const chunkLimit = copiedChunks > 0
      ? await checkLimit(orgId, RESOURCE_TYPES.KNOWLEDGE_CHUNKS, copiedChunks)
      : { allowed: true };
    if (!chunkLimit.allowed) {
      return res.status(403).json({ 
        success: false, 
        code: 'LIMIT_EXCEEDED',
        limitType: 'knowledgeChunks',
        error: req.t('subscription.limits.knowledgeCopyTooLarge', { needed: copiedChunks, available: Math.max(0, chunkLimit.limit - chunkLimit.current) })
      });
    }
    
    // Create the copy with translated "Copy of" prefix
    const copyPrefix = req.t('common.copyOf');
    const newName = `${copyPrefix} ${originalGuide.name}`;
    
    // Insert new guide (starts as inactive)
    const newGuideResult = await query(
      `INSERT INTO guides (organization_id, name, role, personality, greeting, ai_instructions, avatar_url, language, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
       RETURNING id, name`,
      [
        orgId, 
        newName, 
        originalGuide.role, 
        originalGuide.personality, 
        originalGuide.greeting, 
        originalGuide.ai_instructions, 
        originalGuide.avatar_url,
        originalGuide.language
      ]
    );
    
    const newGuide = newGuideResult.rows[0];
    const newGuideId = newGuide.id;
    
    // Copy sources and chunks in batch to avoid N+1 queries
    const sourcesResult = await query(
      'SELECT id, guide_step_id, source_type, source_name, original_filename, content_type, file_size, raw_text, status, chunks_count FROM knowledge_sources WHERE guide_id = $1 AND organization_id = $2',
      [guideId, orgId]
    );
    
    const sourceIdMap = new Map();
    let totalChunksCopied = 0;
    
    // Batch insert sources (one INSERT per source is acceptable; they're few)
    for (const source of sourcesResult.rows) {
      const newSourceResult = await query(
        `INSERT INTO knowledge_sources (
          guide_id, guide_step_id, organization_id, source_type, source_name, 
          original_filename, content_type, file_size, raw_text, status, chunks_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id`,
        [
          newGuideId,
          source.guide_step_id,
          orgId,
          source.source_type,
          source.source_name,
          source.original_filename,
          source.content_type,
          source.file_size,
          source.raw_text,
          source.status,
          source.chunks_count
        ]
      );
      sourceIdMap.set(source.id, newSourceResult.rows[0].id);
    }
    
    // Batch copy all chunks at once instead of per-source per-chunk
    if (sourcesResult.rows.length > 0) {
      const allChunks = await query(
        'SELECT source_id, guide_step_id, content, embedding, chunk_index, metadata FROM knowledge_chunks WHERE source_id = ANY($1) AND organization_id = $2',
        [sourcesResult.rows.map(s => s.id), orgId]
      );
      
      // Batch insert in groups of 50 to avoid overly large queries
      const BATCH_SIZE = 50;
      for (let i = 0; i < allChunks.rows.length; i += BATCH_SIZE) {
        const batch = allChunks.rows.slice(i, i + BATCH_SIZE);
        const values = [];
        const params = [];
        let paramIdx = 1;
        
        for (const chunk of batch) {
          const newSourceId = sourceIdMap.get(chunk.source_id);
          values.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7})`);
          params.push(newSourceId, newGuideId, chunk.guide_step_id, orgId, chunk.content, chunk.embedding, chunk.chunk_index, chunk.metadata);
          paramIdx += 8;
        }
        
        await query(
          `INSERT INTO knowledge_chunks (source_id, guide_id, guide_step_id, organization_id, content, embedding, chunk_index, metadata)
           VALUES ${values.join(', ')}`,
          params
        );
        totalChunksCopied += batch.length;
      }
    }
    
    // Log usage event
    await logUsageEvent(orgId, 'guide_copy', 'guide', newGuideId, req.user?.id, {
      originalGuideId: guideId,
      sourcesCopied: sourcesResult.rows.length,
      chunksCopied: totalChunksCopied
    });
    
    console.log(`[Guide Copy] Copied guide "${originalGuide.name}" to "${newName}" with ${sourcesResult.rows.length} sources and ${totalChunksCopied} chunks`);
    
    res.json({ 
      success: true, 
      message: req.t('guides.copy.success'),
      guide: newGuide,
      stats: {
        sourcesCopied: sourcesResult.rows.length,
        chunksCopied: totalChunksCopied
      }
    });
    
  } catch (err) {
    console.error('API copy guide error:', err);
    res.status(500).json({ success: false, error: 'Failed to copy guide' });
  }
});

/**
 * POST /api/guides/:id/knowledge/file - Upload knowledge file to guide
 */
router.post('/guides/:id/knowledge/file', knowledgeUpload.single('file'), async (req, res) => {
  try {
    const { id: guideId } = req.params;
    const orgId = req.organizationId;
    
    // Verify guide exists
    const guideCheck = await query('SELECT id FROM guides WHERE id = $1 AND organization_id = $2', [guideId, orgId]);
    if (guideCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    
    if (await rejectWhenKnowledgeFull(req, res)) return;
    
    // Create knowledge source record (for central guide)
    const source = await createKnowledgeSource({
      guideId: guideId,
      guideStepId: null, // Not linked to a step
      organizationId: orgId,
      sourceType: 'file',
      sourceName: req.file.originalname,
      originalFilename: req.file.originalname,
      contentType: req.file.mimetype,
      fileSize: req.file.size
    });
    
    // Process file asynchronously
    processFile(source.id, req.file.path, req.file.mimetype, guideId, null, orgId);
    
    res.json({ 
      success: true, 
      source: {
        id: source.id,
        source_type: 'file',
        source_name: req.file.originalname,
        status: 'processing'
      }
    });
    
  } catch (err) {
    console.error('API guide knowledge upload error:', err);
    res.status(500).json({ success: false, error: 'Failed to upload file: ' + err.message });
  }
});

/**
 * POST /api/guides/:id/knowledge/text - Add text knowledge to guide
 */
router.post('/guides/:id/knowledge/text', async (req, res) => {
  try {
    const { id: guideId } = req.params;
    const orgId = req.organizationId;
    const { title, content } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Content is required' });
    }
    
    // Verify guide exists
    const guideCheck = await query('SELECT id FROM guides WHERE id = $1 AND organization_id = $2', [guideId, orgId]);
    if (guideCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    if (await rejectWhenKnowledgeFull(req, res)) return;
    
    // Create knowledge source
    const source = await createKnowledgeSource({
      guideId: guideId,
      guideStepId: null,
      organizationId: orgId,
      sourceType: 'text',
      sourceName: title || 'Text note',
      rawText: content
    });
    
    // Process text
    processText(source.id, content, guideId, null, orgId);
    
    res.json({ 
      success: true, 
      source: {
        id: source.id,
        source_type: 'text',
        source_name: title || 'Text note',
        status: 'processing'
      }
    });
    
  } catch (err) {
    console.error('API guide knowledge text error:', err);
    res.status(500).json({ success: false, error: 'Failed to add text: ' + err.message });
  }
});

/**
 * PUT /api/guides/:id/knowledge/:sourceId - Update text knowledge source
 */
router.put('/guides/:id/knowledge/:sourceId', async (req, res) => {
  try {
    const { id: guideId, sourceId } = req.params;
    const orgId = req.organizationId;
    const { title, content } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Content is required' });
    }
    
    // Verify source belongs to this guide and organization
    const sourceCheck = await query(
      'SELECT id, source_type FROM knowledge_sources WHERE id = $1 AND guide_id = $2 AND organization_id = $3',
      [sourceId, guideId, orgId]
    );
    
    if (sourceCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Knowledge source not found' });
    }
    
    if (sourceCheck.rows[0].source_type !== 'text') {
      return res.status(400).json({ success: false, error: 'Only text sources can be updated' });
    }
    
    const result = await updateTextKnowledgeSource(sourceId, orgId, title, content);
    
    res.json({ 
      success: true, 
      message: 'Text updated and reprocessed',
      chunksCreated: result.chunksCreated
    });
  } catch (err) {
    if (err.message?.startsWith('KNOWLEDGE_LIMIT:')) {
      return res.status(403).json({ success: false, code: 'LIMIT_EXCEEDED', limitType: 'knowledgeChunks', error: formatKnowledgeError(err.message, req.t) });
    }
    console.error('API guide knowledge update error:', err);
    res.status(500).json({ success: false, error: 'Failed to update knowledge source: ' + err.message });
  }
});

/**
 * GET /api/guides/:id/knowledge/:sourceId/status - Get knowledge source status
 */
router.get('/guides/:id/knowledge/:sourceId/status', async (req, res) => {
  try {
    const { id: guideId, sourceId } = req.params;
    const orgId = req.organizationId;
    
    // Verify source belongs to this guide and organization
    const sourceResult = await query(
      'SELECT * FROM knowledge_sources WHERE id = $1 AND guide_id = $2 AND organization_id = $3',
      [sourceId, guideId, orgId]
    );
    
    if (sourceResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Source not found' });
    }
    
    const source = sourceResult.rows[0];
    
    res.json({
      success: true,
      status: source.status,
      chunksCount: source.chunks_count,
      errorMessage: formatKnowledgeError(source.error_message, req.t)
    });
    
  } catch (err) {
    console.error('API knowledge status error:', err);
    res.status(500).json({ success: false, error: 'Could not get status' });
  }
});

/**
 * DELETE /api/guides/:id/knowledge/:sourceId - Delete knowledge source from guide
 */
router.delete('/guides/:id/knowledge/:sourceId', async (req, res) => {
  try {
    const { id: guideId, sourceId } = req.params;
    const orgId = req.organizationId;
    
    // Verify source belongs to this guide and organization
    const sourceCheck = await query(
      'SELECT id FROM knowledge_sources WHERE id = $1 AND guide_id = $2 AND organization_id = $3',
      [sourceId, guideId, orgId]
    );
    
    if (sourceCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Knowledge source not found' });
    }
    
    await deleteKnowledgeSource(sourceId, orgId);
    
    res.json({ success: true, message: 'Knowledge source deleted' });
  } catch (err) {
    console.error('API guide knowledge delete error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete knowledge source' });
  }
});

/**
 * POST /api/chat/guide - Chat with a central guide (with RAG)
 */
router.post('/chat/guide', async (req, res) => {
  try {
    const { guide_id, journey_id: _journey_id, step_context, message, conversation_history, guide_language } = req.body;
    const orgId = req.organizationId;
    
    if (!(await hasAiCreditsLeft(orgId, 'maker'))) {
      const limitMessage = req.t('subscription.limits.aiCreditsExceeded');
      return res.status(403).json({ success: false, code: 'AI_CREDITS_EXHAUSTED', error: limitMessage, response: limitMessage });
    }
    
    if (!guide_id || !message) {
      return res.status(400).json({ success: false, error: 'Guide ID and message are required' });
    }
    
    // Get guide info
    const guideResult = await query(
      'SELECT * FROM guides WHERE id = $1 AND organization_id = $2',
      [guide_id, orgId]
    );
    
    if (guideResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guide not found' });
    }
    
    const dbGuide = guideResult.rows[0];
    
    // Knowledge retrieval happens inside chatWithGuide (with similarity threshold and verification)
    
    // Build guide object compatible with chatWithGuide function
    // SECURITY: Include organizationId for defense-in-depth verification
    const guideObj = {
      name: dbGuide.name,
      role: dbGuide.role || 'Your Assistant',
      personality: dbGuide.personality || 'friendly',
      instructions: dbGuide.ai_instructions || '',
      topics: [],
      stepId: null, // Not using step-based knowledge
      guideId: guide_id, // Central guide ID for knowledge retrieval
      organizationId: orgId, // SECURITY: For knowledge retrieval verification
      language: guide_language || 'en' // AI Guide response language
    };
    
    // Build conversation history array for the function
    // Supports both JSON array format (preferred) and legacy string format
    let historyArray = [];
    if (conversation_history) {
      if (Array.isArray(conversation_history)) {
        // New JSON array format - use directly
        historyArray = conversation_history.map(msg => ({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content || ''
        }));
        console.log('[Guide Chat] Using JSON array history with', historyArray.length, 'messages');
      } else if (typeof conversation_history === 'string') {
        // Legacy string format - parse it
        const lines = conversation_history.split('\n').filter(l => l.trim());
        lines.forEach(line => {
          if (line.startsWith('User:')) {
            historyArray.push({ role: 'user', content: line.replace('User:', '').trim() });
          } else if (line.includes(':')) {
            historyArray.push({ role: 'assistant', content: line.split(':').slice(1).join(':').trim() });
          }
        });
        console.log('[Guide Chat] Parsed string history into', historyArray.length, 'messages');
      }
    }
    
    // Build journey context with media descriptions
    let journeyContext = step_context || '';
    
    // Extract media URLs from context and add AI-generated descriptions
    // This helps the guide understand visual content the user is seeing
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
        context: 'api_chat'
      });
    }
    
    // Parse citations from response
    const { parseCitations, getCitationSources } = await import('../services/knowledge.js');
    const citations = aiResult.response ? parseCitations(aiResult.response) : [];
    const citationIds = [...new Set(citations.map(c => c.id))];
    
    // Get source information for citations (with security check)
    let citationSources = [];
    if (citationIds.length > 0) {
      citationSources = await getCitationSources(citationIds, orgId);
    }
    
    const responseData = { 
      success: true, 
      response: aiResult.response,
      citations: citations,
      citationSources: citationSources
    };
    if (aiResult.error) {
      responseData.serviceError = true;
    }
    res.json(responseData);
    
  } catch (err) {
    console.error('API guide chat error:', err);
    res.status(500).json({ success: false, error: 'Failed to process chat: ' + err.message });
  }
});

// ============================================
// ACCOUNT / SETTINGS
// ============================================

/**
 * PATCH /api/me - Update current user's profile
 */
router.patch('/me', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const userId = req.user?.id;
    const firstNameRaw = req.body?.firstName;
    const lastNameRaw = req.body?.lastName;

    const firstName = typeof firstNameRaw === 'string' ? firstNameRaw.trim() : '';
    const lastName = typeof lastNameRaw === 'string' ? lastNameRaw.trim() : '';

    if (firstName.length > 100 || lastName.length > 100) {
      return res.status(400).json({
        success: false,
        message: req.t('settings.messages.nameTooLong')
      });
    }

    const result = await query(
      `
        UPDATE users
        SET first_name = $1,
            last_name = $2,
            updated_at = NOW()
        WHERE id = $3 AND organization_id = $4
        RETURNING id, email, first_name, last_name, role, avatar_url
      `,
      [firstName || null, lastName || null, userId, orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: req.t('errors.failedToUpdate') });
    }

    const updated = result.rows[0];

    // Keep session in sync (used across the dashboard)
    if (req.session?.user) {
      req.session.user.firstName = updated.first_name;
      req.session.user.lastName = updated.last_name;
      req.session.user.fullName =
        [updated.first_name, updated.last_name].filter(Boolean).join(' ') || updated.email;
    }

    res.json({
      success: true,
      message: req.t('settings.messages.profileSaved'),
      user: {
        id: updated.id,
        email: updated.email,
        firstName: updated.first_name,
        lastName: updated.last_name,
        role: updated.role,
        avatarUrl: updated.avatar_url
      }
    });
  } catch (err) {
    console.error('API update me error:', err);
    res.status(500).json({ success: false, message: req.t('errors.failedToUpdate') });
  }
});

/**
 * PATCH /api/me/marketing-consent - Update marketing email consent (GDPR Art. 7(3))
 */
router.patch('/me/marketing-consent', async (req, res) => {
  try {
    const userId = req.user?.id;
    const orgId = req.organizationId;
    const enabled = req.body?.enabled === true;

    // marketing_consent_source = 'settings' records that this was a deliberate
    // choice, so the one-off legacy opt-in migration never overrides it.
    await query(
      `UPDATE users
       SET marketing_consent_at = $1, marketing_consent_source = 'settings', updated_at = NOW()
       WHERE id = $2 AND organization_id = $3`,
      [enabled ? new Date() : null, userId, orgId]
    );

    res.json({ success: true, message: req.t('settings.emailPreferences.marketingUpdated'), enabled });
  } catch (err) {
    console.error('API update marketing consent error:', err);
    res.status(500).json({ success: false, message: req.t('errors.failedToUpdate') });
  }
});

/**
 * PATCH /api/me/lifecycle-emails - Turn the getting-started help emails on or off
 */
router.patch('/me/lifecycle-emails', async (req, res) => {
  try {
    const userId = req.user?.id;
    const orgId = req.organizationId;
    const enabled = req.body?.enabled === true;

    await query(
      `UPDATE users SET lifecycle_emails_enabled = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
      [enabled, userId, orgId]
    );

    res.json({ success: true, message: req.t('settings.emailPreferences.marketingUpdated'), enabled });
  } catch (err) {
    console.error('API update lifecycle emails error:', err);
    res.status(500).json({ success: false, message: req.t('errors.failedToUpdate') });
  }
});

/**
 * POST /api/me/password - Change current user's password
 */
router.post('/me/password', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const userId = req.user?.id;
    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: req.t('settings.messages.fillAllFields') });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ success: false, message: req.t('settings.messages.passwordTooShort') });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: req.t('settings.messages.passwordsDoNotMatch') });
    }

    const userResult = await query(
      `
        SELECT password_hash
        FROM users
        WHERE id = $1 AND organization_id = $2 AND is_active = true
      `,
      [userId, orgId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: req.t('errors.failedToUpdate') });
    }

    const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!valid) {
      return res.status(400).json({ success: false, message: req.t('settings.messages.currentPasswordIncorrect') });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await query(
      `
        UPDATE users
        SET password_hash = $1,
            updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
      `,
      [passwordHash, userId, orgId]
    );

    res.json({ success: true, message: req.t('settings.messages.passwordUpdated') });
  } catch (err) {
    console.error('API change password error:', err);
    res.status(500).json({ success: false, message: req.t('errors.failedToUpdate') });
  }
});

/**
 * POST /api/me/two-factor - Toggle 2FA (email verification code)
 */
router.post('/me/two-factor', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { enabled } = req.body || {};
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Invalid request' });
    }
    
    await query(
      `UPDATE users SET two_factor_enabled = $1, updated_at = NOW() WHERE id = $2`,
      [enabled, userId]
    );
    
    const message = enabled 
      ? req.t('settings.security.twoFactorEnabled')
      : req.t('settings.security.twoFactorDisabled');
    
    res.json({ success: true, message, enabled });
  } catch (err) {
    console.error('API toggle 2FA error:', err);
    res.status(500).json({ success: false, message: req.t('errors.failedToUpdate') });
  }
});

// ============================================
// TEAM (Builder users)
// ============================================

const TEAM_ROLES = ['admin', 'manager', 'member', 'viewer'];


function isAdmin(req) {
  return req.user?.role === 'admin';
}

function requireTeamAdmin(req, res) {
  if (!isAdmin(req)) {
    res.status(403).json({ success: false, message: req.t('team.messages.noPermission') });
    return false;
  }
  return true;
}

/**
 * GET /api/team/members - List builder users in org
 * Note: Hidden users (is_visible = false) are excluded - used for super admin accounts
 */
router.get('/team/members', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const result = await query(
      `
        SELECT id, email, first_name, last_name, role, is_active, last_login_at, created_at
        FROM users
        WHERE organization_id = $1
          AND (is_visible IS NULL OR is_visible = true)
        ORDER BY created_at ASC
      `,
      [orgId]
    );
    res.json({ success: true, members: result.rows });
  } catch (err) {
    console.error('API team members error:', err);
    res.status(500).json({ success: false, message: req.t('team.messages.loadFailed') });
  }
});

/**
 * GET /api/team/invites - List pending invites (admin only)
 */
router.get('/team/invites', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const orgId = req.organizationId;
    const result = await query(
      `
        SELECT id, email, role, expires_at, accepted_at, revoked_at, last_sent_at, created_at
        FROM user_invites
        WHERE organization_id = $1
          AND accepted_at IS NULL
          AND revoked_at IS NULL
        ORDER BY created_at DESC
      `,
      [orgId]
    );
    res.json({ success: true, invites: result.rows });
  } catch (err) {
    console.error('API team invites error:', err);
    res.status(500).json({ success: false, message: req.t('team.messages.loadFailed') });
  }
});

/**
 * POST /api/team/invites - Create or update invite and send email (admin only)
 */
router.post('/team/invites', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const orgId = req.organizationId;
    const invitedBy = req.user?.id;
    const emailRaw = req.body?.email;
    const roleRaw = req.body?.role;

    const email = typeof emailRaw === 'string' ? emailRaw.toLowerCase().trim() : '';
    const role = TEAM_ROLES.includes(roleRaw) ? roleRaw : 'member';

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: req.t('team.messages.invalidEmail') });
    }
    
    // Block super admin email from being invited as a regular maker
    if (isPlatformAdminEmail(email)) {
      return res.status(403).json({ 
        success: false, 
        message: 'This email address is reserved for system administration and cannot be added as a team member.' 
      });
    }

    // Prevent inviting existing active visible user (hidden super admin accounts are ignored)
    const existing = await query(
      `SELECT id, is_active FROM users WHERE organization_id = $1 AND email = $2 AND (is_visible IS NULL OR is_visible = true)`,
      [orgId, email]
    );
    if (existing.rows.length > 0 && existing.rows[0].is_active) {
      return res.status(409).json({ success: false, message: req.t('team.messages.alreadyMember') });
    }

    // One email address belongs to one organization (as with signup); login
    // would otherwise not know which organization to open. This looks across
    // organizations, so it runs on a client without the request's RLS context.
    const lookupClient = await getClient();
    let otherOrg;
    try {
      otherOrg = await lookupClient.query(
        'SELECT 1 FROM users WHERE LOWER(email) = $1 AND organization_id <> $2 LIMIT 1',
        [email, orgId]
      );
    } finally {
      lookupClient.release();
    }
    if (otherOrg.rows.length > 0) {
      return res.status(409).json({ success: false, code: 'EMAIL_IN_OTHER_ORG', message: req.t('team.messages.emailInOtherOrg') });
    }
    
    // Check tier limit for team members (makers)
    const limitCheck = await checkLimit(orgId, RESOURCE_TYPES.MAKERS);
    if (!limitCheck.allowed) {
      return res.status(403).json({
        success: false,
        code: 'LIMIT_EXCEEDED',
        error: req.t('subscription.limits.makersExceeded'),
        limitType: 'makers',
        current: limitCheck.current,
        limit: limitCheck.limit,
        tier: limitCheck.tier,
        tierDisplayName: limitCheck.tierDisplayName
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresInDays = 7;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const upsert = await query(
      `
        INSERT INTO user_invites (organization_id, email, role, invited_by, token_hash, expires_at, last_sent_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (organization_id, email)
        DO UPDATE SET
          role = EXCLUDED.role,
          invited_by = EXCLUDED.invited_by,
          token_hash = EXCLUDED.token_hash,
          expires_at = EXCLUDED.expires_at,
          accepted_at = NULL,
          revoked_at = NULL,
          last_sent_at = NOW(),
          updated_at = NOW()
        RETURNING id
      `,
      [orgId, email, role, invitedBy, tokenHash, expiresAt]
    );

    const orgResult = await query(`SELECT name, settings FROM organizations WHERE id = $1`, [orgId]);
    const companyName = orgResult.rows[0]?.name || 'Gryffi';
    const orgSettings = orgResult.rows[0]?.settings || {};
    const supported = ['en', 'nl', 'de', 'fr', 'es'];
    const mode = orgSettings.default_language_mode || 'fixed';
    const fixed = orgSettings.default_language;
    const emailLng = (mode === 'fixed' && supported.includes(fixed))
      ? fixed
      : (supported.includes(req.language) ? req.language : 'en');

    const baseUrl = getAppBaseUrl();
    const inviteLink = `${baseUrl}/invite?token=${token}`;

    const roleName = role === 'admin'
      ? req.t('team.roles.admin.name', { lng: emailLng })
      : role === 'manager'
        ? req.t('team.roles.manager.name', { lng: emailLng })
        : role === 'viewer'
          ? req.t('team.roles.viewer.name', { lng: emailLng })
          : req.t('team.roles.member.name', { lng: emailLng });

    const inviterName = req.user?.fullName || req.user?.email || '';
    const subject = req.t('emails.teamInvite.subject', { lng: emailLng, companyName });
    const intro = inviterName
      ? req.t('emails.teamInvite.introWithInviter', { lng: emailLng, inviterName, companyName })
      : req.t('emails.teamInvite.intro', { lng: emailLng, companyName });
    const body = [
      intro,
      '',
      req.t('emails.teamInvite.roleLine', { lng: emailLng, roleName }),
      '',
      req.t('emails.teamInvite.instructions', { lng: emailLng, expiresInDays }),
      '',
      req.t('emails.teamInvite.ignore', { lng: emailLng })
    ].join('\n');

    const sendResult = await sendEmail({
      to: email,
      subject,
      templateType: 'journey_custom',
      variables: {
        company_name: companyName,
        user_email: email,
        custom_link: inviteLink,
        custom_link_text: req.t('emails.teamInvite.cta', { lng: emailLng })
      },
      customBody: body,
      language: emailLng,
      orgId: orgId, // For custom theme support
      // Route unsubscribe to the admin who sent this invite.
      unsubscribeEmail: req.user?.email || null
    });

    await query(
      `UPDATE user_invites SET email_provider_id = $1 WHERE id = $2 AND organization_id = $3`,
      [sendResult?.emailId || null, upsert.rows[0].id, orgId]
    );

    res.json({ success: true, message: req.t('team.messages.inviteSent') });
  } catch (err) {
    console.error('API team invite create error:', err);
    res.status(500).json({ success: false, message: req.t('team.messages.inviteFailed') });
  }
});

/**
 * POST /api/team/invites/:id/resend - Resend invite (admin only)
 */
router.post('/team/invites/:id/resend', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const orgId = req.organizationId;
    const inviteId = req.params.id;

    const inv = await query(
      `SELECT id, email, role FROM user_invites WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [inviteId, orgId]
    );
    if (inv.rows.length === 0) {
      return res.status(404).json({ success: false, message: req.t('team.messages.inviteNotFound') });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresInDays = 7;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    await query(
      `UPDATE user_invites SET token_hash = $1, expires_at = $2, last_sent_at = NOW(), updated_at = NOW() WHERE id = $3 AND organization_id = $4`,
      [tokenHash, expiresAt, inviteId, orgId]
    );

    const orgResult = await query(`SELECT name, settings FROM organizations WHERE id = $1`, [orgId]);
    const companyName = orgResult.rows[0]?.name || 'Gryffi';
    const orgSettings = orgResult.rows[0]?.settings || {};
    const supported = ['en', 'nl', 'de', 'fr', 'es'];
    const mode = orgSettings.default_language_mode || 'fixed';
    const fixed = orgSettings.default_language;
    const emailLng = (mode === 'fixed' && supported.includes(fixed))
      ? fixed
      : (supported.includes(req.language) ? req.language : 'en');

    const baseUrl = getAppBaseUrl();
    const inviteLink = `${baseUrl}/invite?token=${token}`;

    const role = inv.rows[0].role;
    const roleName = role === 'admin'
      ? req.t('team.roles.admin.name', { lng: emailLng })
      : role === 'manager'
        ? req.t('team.roles.manager.name', { lng: emailLng })
        : role === 'viewer'
          ? req.t('team.roles.viewer.name', { lng: emailLng })
          : req.t('team.roles.member.name', { lng: emailLng });

    const inviterName = req.user?.fullName || req.user?.email || '';
    const subject = req.t('emails.teamInvite.subject', { lng: emailLng, companyName });
    const intro = inviterName
      ? req.t('emails.teamInvite.introWithInviter', { lng: emailLng, inviterName, companyName })
      : req.t('emails.teamInvite.intro', { lng: emailLng, companyName });
    const body = [
      intro,
      '',
      req.t('emails.teamInvite.roleLine', { lng: emailLng, roleName }),
      '',
      req.t('emails.teamInvite.instructions', { lng: emailLng, expiresInDays }),
      '',
      req.t('emails.teamInvite.ignore', { lng: emailLng })
    ].join('\n');

    const sendResult = await sendEmail({
      to: inv.rows[0].email,
      subject,
      templateType: 'journey_custom',
      variables: {
        company_name: companyName,
        user_email: inv.rows[0].email,
        custom_link: inviteLink,
        custom_link_text: req.t('emails.teamInvite.cta', { lng: emailLng })
      },
      customBody: body,
      language: emailLng,
      orgId: orgId, // For custom theme support
      // Route unsubscribe to the admin who triggered this resend.
      unsubscribeEmail: req.user?.email || null
    });

    await query(
      `UPDATE user_invites SET email_provider_id = $1 WHERE id = $2 AND organization_id = $3`,
      [sendResult?.emailId || null, inviteId, orgId]
    );

    res.json({ success: true, message: req.t('team.messages.inviteResent') });
  } catch (err) {
    console.error('API team invite resend error:', err);
    res.status(500).json({ success: false, message: req.t('team.messages.inviteFailed') });
  }
});

/**
 * DELETE /api/team/invites/:id - Revoke invite (admin only)
 */
router.delete('/team/invites/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const orgId = req.organizationId;
    const inviteId = req.params.id;
    const result = await query(
      `UPDATE user_invites SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL`,
      [inviteId, orgId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: req.t('team.messages.inviteNotFound') });
    }
    res.json({ success: true, message: req.t('team.messages.inviteRevoked') });
  } catch (err) {
    console.error('API team invite revoke error:', err);
    res.status(500).json({ success: false, message: req.t('team.messages.inviteFailed') });
  }
});

/**
 * PATCH /api/team/members/:id - Update member role / active (admin only)
 */
router.patch('/team/members/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  try {
    const orgId = req.organizationId;
    const targetId = req.params.id;
    const isSelf = targetId === req.user?.id;

    const roleRaw = req.body?.role;
    const isActiveRaw = req.body?.isActive;

    const nextRole = roleRaw ? (TEAM_ROLES.includes(roleRaw) ? roleRaw : null) : null;
    const nextActive = typeof isActiveRaw === 'boolean' ? isActiveRaw : null;

    // An admin may change their own role (e.g. hand over adminship), but not
    // deactivate their own account through this route.
    if (isSelf && nextActive !== null) {
      return res.status(400).json({ success: false, message: req.t('team.messages.cannotEditSelf') });
    }

    if (!nextRole && nextActive === null) {
      return res.status(400).json({ success: false, message: req.t('team.messages.updateFailed') });
    }

    // If we are deactivating or demoting an admin, ensure another active admin remains
    const current = await query(
      // Hidden (super admin) accounts cannot be changed through team management
      `SELECT id, role, is_active FROM users WHERE id = $1 AND organization_id = $2 AND (is_visible IS NULL OR is_visible = true)`,
      [targetId, orgId]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ success: false, message: req.t('team.messages.memberNotFound') });
    }

    const wasAdmin = current.rows[0].role === 'admin' && current.rows[0].is_active;
    const removingAdmin = wasAdmin && ((nextRole && nextRole !== 'admin') || (nextActive === false));

    if (removingAdmin) {
      const admins = await query(
        // Only visible admins count: the hidden super admin is not part of the customer's team
        `SELECT COUNT(*)::int AS count FROM users WHERE organization_id = $1 AND role = 'admin' AND is_active = true AND id <> $2 AND (is_visible IS NULL OR is_visible = true)`,
        [orgId, targetId]
      );
      if ((admins.rows[0]?.count || 0) < 1) {
        // Structured error code so the frontend can show an explanatory
        // dialog instead of a generic toast. An organization must always
        // keep at least one active admin.
        return res.status(409).json({
          success: false,
          code: 'LAST_ADMIN',
          message: isSelf
            ? req.t('team.messages.lastAdminSelf')
            : req.t('team.messages.needAnotherAdmin')
        });
      }
    }

    const updated = await query(
      `
        UPDATE users
        SET role = COALESCE($1, role),
            is_active = COALESCE($2, is_active),
            updated_at = NOW()
        WHERE id = $3 AND organization_id = $4
        RETURNING id, email, first_name, last_name, role, is_active
      `,
      [nextRole, nextActive, targetId, orgId]
    );

    // Keep the session in sync when an admin changed their own role, so the
    // new (lower) permissions apply immediately on the next request.
    if (isSelf && nextRole && req.session?.user) {
      req.session.user.role = nextRole;
    }

    res.json({
      success: true,
      message: req.t('team.messages.memberUpdated'),
      member: updated.rows[0],
      selfRoleChanged: isSelf && !!nextRole
    });
  } catch (err) {
    console.error('API team member update error:', err);
    res.status(500).json({ success: false, message: req.t('team.messages.updateFailed') });
  }
});

/**
 * DELETE /api/team/members/:id - Permanently delete a maker account (GDPR Art. 17)
 * - Admin can delete any other maker
 * - Any maker can delete their own account (self-delete)
 * - Last admin cannot be deleted
 */
router.delete('/team/members/:id', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const targetId = req.params.id;
    const isSelf = targetId === req.user?.id;

    if (!isSelf && !isAdmin(req)) {
      return res.status(403).json({ success: false, message: req.t('team.messages.noPermission') });
    }

    const target = await query(
      `SELECT id, role, is_active, email, first_name, last_name FROM users WHERE id = $1 AND organization_id = $2 AND (is_visible IS NULL OR is_visible = true)`,
      [targetId, orgId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ success: false, message: req.t('team.messages.memberNotFound') });
    }

    if (target.rows[0].role === 'admin' && target.rows[0].is_active) {
      const admins = await query(
        // Only visible admins count: the hidden super admin is not part of the customer's team
        `SELECT COUNT(*)::int AS count FROM users WHERE organization_id = $1 AND role = 'admin' AND is_active = true AND id <> $2 AND (is_visible IS NULL OR is_visible = true)`,
        [orgId, targetId]
      );
      if ((admins.rows[0]?.count || 0) < 1) {
        return res.status(400).json({ success: false, message: req.t('team.messages.cannotDeleteLastAdmin') });
      }
    }

    await query(`DELETE FROM users WHERE id = $1 AND organization_id = $2`, [targetId, orgId]);

    if (isSelf) {
      return req.session.destroy((err) => {
        if (err) console.error('Session destroy after self-delete error:', err);
        res.json({ success: true, message: req.t('team.messages.memberDeleted'), selfDeleted: true });
      });
    }

    res.json({ success: true, message: req.t('team.messages.memberDeleted') });
  } catch (err) {
    console.error('API team member delete error:', err);
    res.status(500).json({ success: false, message: req.t('team.messages.deleteFailed') });
  }
});

// ===== LANGUAGE ROUTES =====
// Note: Language routes are now defined at the top of this file (before requireApiAuth)
// to allow language changes on the login page

// Get current language and available languages (duplicate for backwards compatibility)
router.get('/language/info', (req, res) => {
  const supportedLanguages = ['en', 'nl', 'de', 'fr', 'es'];
  const languageNames = {
    en: 'English',
    nl: 'Nederlands',
    de: 'Deutsch',
    fr: 'Français',
    es: 'Español'
  };
  
  res.json({
    success: true,
    current: req.language,
    supported: supportedLanguages,
    names: languageNames
  });
});

// ============================================
// ORGANIZATION
// ============================================

/**
 * PATCH /api/organization - Update organization settings (admin only)
 * Supports:
 * - name
 * - country (ISO 3166-1 alpha-2 code)
 * - settings.default_language_mode: 'auto' | 'fixed'
 * - settings.default_language: 'en' | 'nl' | 'de' | 'fr' | 'es'
 */
router.patch('/organization', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: req.t('team.messages.adminOnly') });
    }

    const orgId = req.organizationId;
    const body = req.body || {};
    const supportedLanguages = ['en', 'nl', 'de', 'fr', 'es'];

    const name = body.name !== undefined ? String(body.name || '').trim() : undefined;
    const country = body.country !== undefined ? String(body.country || '').trim().toUpperCase() : undefined;
    const defaultLanguageMode =
      body.default_language_mode !== undefined
        ? String(body.default_language_mode || '').trim()
        : body.defaultLanguageMode !== undefined
          ? String(body.defaultLanguageMode || '').trim()
          : undefined;
    const defaultLanguage =
      body.default_language !== undefined
        ? String(body.default_language || '').trim()
        : body.defaultLanguage !== undefined
          ? String(body.defaultLanguage || '').trim()
          : undefined;

    if (name !== undefined) {
      if (!name) {
        return res.status(400).json({ success: false, message: req.t('team.organization.validationEmpty') });
      }
      if (name.length > 120) {
        return res.status(400).json({ success: false, message: req.t('team.organization.validationTooLong') });
      }
    }

    // Validate country code if provided
    if (country !== undefined && country !== '' && !isValidCountryCode(country)) {
      return res.status(400).json({ success: false, message: req.t('settings.organization.country.validationInvalid') });
    }

    // Load current settings so we can safely merge
    const currentOrg = await query('SELECT id, name, settings, country FROM organizations WHERE id = $1', [orgId]);
    if (currentOrg.rows.length === 0) {
      return res.status(404).json({ success: false, message: req.t('team.messages.noPermission') });
    }

    const currentSettings =
      currentOrg.rows[0].settings && typeof currentOrg.rows[0].settings === 'object'
        ? { ...currentOrg.rows[0].settings }
        : {};

    if (defaultLanguageMode !== undefined) {
      if (!['auto', 'fixed'].includes(defaultLanguageMode)) {
        return res.status(400).json({ success: false, message: req.t('team.organization.language.validationMode') });
      }
      currentSettings.default_language_mode = defaultLanguageMode;
      if (defaultLanguageMode === 'auto') {
        delete currentSettings.default_language;
      }
    }

    if (defaultLanguage !== undefined) {
      if (!supportedLanguages.includes(defaultLanguage)) {
        return res.status(400).json({ success: false, message: req.t('team.organization.language.validationLanguage') });
      }
      currentSettings.default_language = defaultLanguage;
      if (!currentSettings.default_language_mode) currentSettings.default_language_mode = 'fixed';
    }

    // If mode is fixed, ensure language exists; default to English
    if (currentSettings.default_language_mode === 'fixed' && !currentSettings.default_language) {
      currentSettings.default_language = 'en';
    }

    const result = await query(
      `
        UPDATE organizations
        SET name = COALESCE($1, name),
            settings = $2::jsonb,
            country = COALESCE($3, country),
            updated_at = NOW()
        WHERE id = $4
        RETURNING id, name, settings, country
      `,
      [name !== undefined ? name : null, JSON.stringify(currentSettings), country !== undefined ? (country || null) : null, orgId]
    );

    // Keep session in sync so the UI updates without re-login
    if (req.session?.organization) {
      req.session.organization.name = result.rows[0].name;
      req.session.organization.settings = result.rows[0].settings;
      req.session.organization.country = result.rows[0].country;
    }

    return res.json({
      success: true,
      organization: { id: result.rows[0].id, name: result.rows[0].name, settings: result.rows[0].settings, country: result.rows[0].country },
      message: req.t('team.organization.saved')
    });
  } catch (err) {
    console.error('API update organization error:', err);
    return res.status(500).json({ success: false, message: req.t('team.organization.saveFailed') });
  }
});

// ============================================
// GDPR DATA EXPORT (Admin Only)
// ============================================

/**
 * GET /api/organization/export - Export all organization data as a ZIP file (admin only)
 * Contains:
 *   organization.json   - org settings, team members, journeys, steps, guides, polls, rewards, etc.
 *   end-users.csv       - all end users
 *   media/              - all uploaded media files
 *   knowledge/          - all uploaded knowledge source files
 */
router.get('/organization/export', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, message: req.t('team.messages.adminOnly') });
    }

    const orgId = req.organizationId;

    const org = await query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    if (org.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }
    const orgData = org.rows[0];
    const orgSensitiveFields = [
      'api_key_hash',
      'google_access_token', 'google_refresh_token',
      'microsoft_access_token', 'microsoft_refresh_token',
    ];
    for (const f of orgSensitiveFields) delete orgData[f];

    const [
      usersRes, journeysRes, stepsRes, pathsRes, guidesRes,
      mediaRes, pollsRes, pollResponsesRes, rewardsRes, rewardCodesRes,
      endUsersRes, endUserGroupsRes, groupMembersRes,
      invitationsRes, knowledgeSourcesRes,
      floorplansRes, themesRes,
      publicParticipantsRes, publicPollResponsesRes,
      publicFormSubmissionsRes, privateFormSubmissionsRes,
      publicRewardClaimsRes
    ] = await Promise.all([
      query('SELECT id, email, first_name, last_name, role, is_active, terms_agreed_at, marketing_consent_at, created_at, updated_at FROM users WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM journeys WHERE organization_id = $1', [orgId]),
      query('SELECT s.* FROM steps s JOIN journeys j ON s.journey_id = j.id WHERE j.organization_id = $1', [orgId]),
      query('SELECT p.* FROM paths p JOIN journeys j ON p.journey_id = j.id WHERE j.organization_id = $1', [orgId]),
      query('SELECT * FROM guides WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM media WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM polls WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM poll_responses WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM rewards WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM reward_codes WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM end_users WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM end_user_groups WHERE organization_id = $1', [orgId]),
      query(`SELECT egm.* FROM end_user_group_members egm 
             JOIN end_user_groups eg ON egm.group_id = eg.id 
             WHERE eg.organization_id = $1`, [orgId]),
      query('SELECT * FROM invitations WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM knowledge_sources WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM floorplans WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM themes WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM public_participants WHERE organization_id = $1', [orgId]),
      query('SELECT * FROM public_poll_responses WHERE journey_id IN (SELECT id FROM journeys WHERE organization_id = $1)', [orgId]),
      query('SELECT * FROM public_form_submissions WHERE journey_id IN (SELECT id FROM journeys WHERE organization_id = $1)', [orgId]),
      query('SELECT * FROM private_form_submissions WHERE journey_id IN (SELECT id FROM journeys WHERE organization_id = $1)', [orgId]),
      query('SELECT * FROM public_reward_claims WHERE journey_id IN (SELECT id FROM journeys WHERE organization_id = $1)', [orgId]),
    ]);

    // Strip sensitive fields (tokens, hashes) from export
    const stripSensitive = (rows, fields) => rows.map(r => {
      const clean = { ...r };
      for (const f of fields) delete clean[f];
      return clean;
    });

    const exportData = {
      exported_at: new Date().toISOString(),
      organization: orgData,
      team_members: usersRes.rows,
      journeys: journeysRes.rows,
      steps: stepsRes.rows,
      paths: pathsRes.rows,
      guides: guidesRes.rows,
      media: mediaRes.rows,
      polls: pollsRes.rows,
      poll_responses: pollResponsesRes.rows,
      rewards: rewardsRes.rows,
      reward_codes: rewardCodesRes.rows,
      end_user_groups: endUserGroupsRes.rows,
      group_memberships: groupMembersRes.rows,
      invitations: stripSensitive(invitationsRes.rows, ['token']),
      knowledge_sources: knowledgeSourcesRes.rows,
      floorplans: floorplansRes.rows,
      themes: themesRes.rows,
      public_participants: publicParticipantsRes.rows,
      public_poll_responses: publicPollResponsesRes.rows,
      public_form_submissions: publicFormSubmissionsRes.rows,
      private_form_submissions: privateFormSubmissionsRes.rows,
      public_reward_claims: publicRewardClaimsRes.rows,
    };

    // Build end-users CSV
    const endUsers = endUsersRes.rows;
    const csvHeaders = ['id', 'email', 'first_name', 'last_name', 'source', 'external_id', 'is_active', 'created_at', 'updated_at'];
    const csvEscape = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };
    const csvLines = [csvHeaders.join(',')];
    for (const eu of endUsers) {
      csvLines.push(csvHeaders.map(h => csvEscape(eu[h])).join(','));
    }
    const csvContent = csvLines.join('\n');

    const slug = orgData.slug || 'organization';
    const filename = `gryffi-export-${slug}-${new Date().toISOString().slice(0, 10)}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('[Export] Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Export failed' });
      }
    });
    archive.pipe(res);

    // Build team-members (makers) CSV
    const makers = usersRes.rows;
    const makerHeaders = ['id', 'email', 'first_name', 'last_name', 'role', 'is_active', 'terms_agreed_at', 'marketing_consent_at', 'created_at', 'updated_at'];
    const makerCsvLines = [makerHeaders.join(',')];
    for (const m of makers) {
      makerCsvLines.push(makerHeaders.map(h => csvEscape(m[h])).join(','));
    }
    const makerCsvContent = makerCsvLines.join('\n');

    archive.append(JSON.stringify(exportData, null, 2), { name: 'organization.json' });
    archive.append(makerCsvContent, { name: 'team-members.csv' });
    archive.append(csvContent, { name: 'end-users.csv' });

    // Add uploaded media files
    const mediaDir = path.join(__dirname, '../../uploads/organizations', orgId);
    if (fs.existsSync(mediaDir)) {
      archive.directory(mediaDir, 'media');
    }

    // Add form submission files (uploads from form steps)
    const formFilesDir = path.join(__dirname, '../../uploads/form-submissions', orgId);
    if (fs.existsSync(formFilesDir)) {
      archive.directory(formFilesDir, 'form-submission-files');
    }

    // Add knowledge source files
    for (const src of knowledgeSourcesRes.rows) {
      if (src.source_type === 'file' && src.original_filename) {
        const ext = src.original_filename.split('.').pop();
        const filePath = path.join(__dirname, '../../uploads/knowledge', `${src.id}.${ext}`);
        if (fs.existsSync(filePath)) {
          archive.file(filePath, { name: `knowledge/${src.original_filename}` });
        }
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('[Export] Error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Export failed. Please try again.' });
    }
  }
});

// ============================================
// END USERS (Journey Participants) - Admin Only
// ============================================

const END_USER_SOURCES = ['manual', 'csv', 'microsoft', 'google'];

/**
 * GET /api/end-users - List all end users in org (admin only)
 * Supports pagination for scalability
 */
router.get('/end-users', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim() || '';
    const source = req.query.source || '';
    
    // Build query with optional filters
    let whereClause = 'WHERE eu.organization_id = $1';
    const params = [orgId];
    let paramIndex = 2;
    
    if (search) {
      whereClause += ` AND (
        LOWER(eu.email) LIKE LOWER($${paramIndex}) OR
        LOWER(eu.first_name) LIKE LOWER($${paramIndex}) OR
        LOWER(eu.last_name) LIKE LOWER($${paramIndex}) OR
        LOWER(eu.first_name || ' ' || eu.last_name) LIKE LOWER($${paramIndex})
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    if (source && END_USER_SOURCES.includes(source)) {
      whereClause += ` AND eu.source = $${paramIndex}`;
      params.push(source);
      paramIndex++;
    }
    
    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) as total FROM end_users eu ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);
    
    // Get users with pagination and their groups
    const result = await query(
      `SELECT eu.id, eu.email, eu.first_name, eu.last_name, eu.source, eu.external_id, eu.is_active, eu.created_at, eu.updated_at,
              COALESCE(
                (SELECT json_agg(json_build_object('id', g.id, 'name', g.name))
                 FROM end_user_group_members gm
                 JOIN end_user_groups g ON gm.group_id = g.id
                 WHERE gm.end_user_id = eu.id),
                '[]'
              ) as groups
       FROM end_users eu
       ${whereClause}
       ORDER BY eu.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );
    
    res.json({
      success: true,
      endUsers: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('API end-users list error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.endUsers.loadFailed') });
  }
});

/**
 * POST /api/end-users - Create a new end user (admin only)
 */
router.post('/end-users', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const { email, first_name, last_name } = req.body;
    
    // Block super admin email from being added as end user
    if (isPlatformAdminEmail(email)) {
      return res.status(403).json({ 
        success: false, 
        message: 'This email address is reserved for system administration and cannot be added as an end user.' 
      });
    }
    
    // Check end user limit
    const usageData = await getOrganizationUsageWithLimits(orgId);
    if (usageData && usageData.usage.endUsers.isAtLimit) {
      return res.status(403).json({ 
        success: false, 
        code: 'LIMIT_EXCEEDED',
        limitType: 'endUsers',
        message: req.t('subscription.limits.endUsersExceeded')
      });
    }
    
    // Validate required fields
    const emailTrimmed = email?.trim().toLowerCase();
    const firstNameTrimmed = first_name?.trim();
    const lastNameTrimmed = last_name?.trim();
    
    if (!emailTrimmed || !emailTrimmed.includes('@')) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.endUsers.validation.invalidEmail') 
      });
    }
    
    if (!firstNameTrimmed) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.endUsers.validation.firstNameRequired') 
      });
    }
    
    if (!lastNameTrimmed) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.endUsers.validation.lastNameRequired') 
      });
    }
    
    // Check if email already exists in this org
    const existing = await query(
      `SELECT id FROM end_users WHERE organization_id = $1 AND email = $2`,
      [orgId, emailTrimmed]
    );
    
    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        success: false, 
        message: req.t('systemSettings.endUsers.validation.emailExists') 
      });
    }
    
    // Create the end user
    const result = await query(
      `INSERT INTO end_users (organization_id, email, first_name, last_name, source)
       VALUES ($1, $2, $3, $4, 'manual')
       RETURNING id, email, first_name, last_name, source, is_active, created_at`,
      [orgId, emailTrimmed, firstNameTrimmed, lastNameTrimmed]
    );
    
    res.json({
      success: true,
      endUser: result.rows[0],
      message: req.t('systemSettings.endUsers.created')
    });
  } catch (err) {
    console.error('API end-user create error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.endUsers.createFailed') });
  }
});

/**
 * PUT /api/end-users/:id - Update an end user (admin only)
 * Only manual and csv users can be edited
 */
router.put('/end-users/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const userId = req.params.id;
    const { email, first_name, last_name, is_active } = req.body;
    
    // Check if user exists and belongs to org
    const existingResult = await query(
      `SELECT id, source FROM end_users WHERE id = $1 AND organization_id = $2`,
      [userId, orgId]
    );
    
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: req.t('systemSettings.endUsers.notFound') 
      });
    }
    
    const existingUser = existingResult.rows[0];
    
    // Check if user is editable (only manual and csv sources)
    if (!['manual', 'csv'].includes(existingUser.source)) {
      return res.status(403).json({ 
        success: false, 
        message: req.t('systemSettings.endUsers.cannotEditSynced') 
      });
    }
    
    // Validate and prepare updates
    const emailTrimmed = email?.trim().toLowerCase();
    const firstNameTrimmed = first_name?.trim();
    const lastNameTrimmed = last_name?.trim();
    
    if (emailTrimmed && !emailTrimmed.includes('@')) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.endUsers.validation.invalidEmail') 
      });
    }
    
    // Check if new email conflicts with another user
    if (emailTrimmed) {
      const emailConflict = await query(
        `SELECT id FROM end_users WHERE organization_id = $1 AND email = $2 AND id != $3`,
        [orgId, emailTrimmed, userId]
      );
      
      if (emailConflict.rows.length > 0) {
        return res.status(409).json({ 
          success: false, 
          message: req.t('systemSettings.endUsers.validation.emailExists') 
        });
      }
    }
    
    // Update the user
    const result = await query(
      `UPDATE end_users 
       SET email = COALESCE($1, email),
           first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name),
           is_active = COALESCE($4, is_active),
           updated_at = NOW()
       WHERE id = $5 AND organization_id = $6
       RETURNING id, email, first_name, last_name, source, is_active, created_at, updated_at`,
      [emailTrimmed || null, firstNameTrimmed || null, lastNameTrimmed || null, 
       is_active !== undefined ? is_active : null, userId, orgId]
    );
    
    res.json({
      success: true,
      endUser: result.rows[0],
      message: req.t('systemSettings.endUsers.updated')
    });
  } catch (err) {
    console.error('API end-user update error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.endUsers.updateFailed') });
  }
});

/**
 * DELETE /api/end-users/:id - Delete an end user (admin only)
 * All users can be deleted, but synced users (google/microsoft) show a warning
 */
router.delete('/end-users/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const userId = req.params.id;
    
    // Check if user exists and belongs to org
    const existingResult = await query(
      `SELECT id, source, first_name, last_name FROM end_users WHERE id = $1 AND organization_id = $2`,
      [userId, orgId]
    );
    
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: req.t('systemSettings.endUsers.notFound') 
      });
    }
    
    // Delete the user (all sources allowed now)
    await query(
      `DELETE FROM end_users WHERE id = $1 AND organization_id = $2`,
      [userId, orgId]
    );
    
    res.json({
      success: true,
      message: req.t('systemSettings.endUsers.deleted')
    });
  } catch (err) {
    console.error('API end-user delete error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.endUsers.deleteFailed') });
  }
});

/**
 * GET /api/end-users/stats - Get statistics about end users (admin only)
 */
router.get('/end-users/stats', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    
    const result = await query(
      `SELECT 
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE source = 'manual') as manual,
         COUNT(*) FILTER (WHERE source = 'csv') as csv,
         COUNT(*) FILTER (WHERE source = 'microsoft') as microsoft,
         COUNT(*) FILTER (WHERE source = 'google') as google,
         COUNT(*) FILTER (WHERE is_active = true) as active,
         COUNT(*) FILTER (WHERE is_active = false) as inactive
       FROM end_users
       WHERE organization_id = $1`,
      [orgId]
    );
    
    res.json({
      success: true,
      stats: result.rows[0]
    });
  } catch (err) {
    console.error('API end-users stats error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.endUsers.loadFailed') });
  }
});

/**
 * DELETE /api/end-users/source/:source - Bulk delete end users by source (admin only)
 * Used to clean up users from a specific source (e.g., google, microsoft, csv)
 */
router.delete('/end-users/source/:source', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const source = req.params.source.toLowerCase();
    
    // Validate source
    const validSources = ['google', 'microsoft', 'csv', 'api'];
    if (!validSources.includes(source)) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.endUsers.invalidSource') 
      });
    }
    
    // Count users to be deleted
    const countResult = await query(
      `SELECT COUNT(*) as count FROM end_users WHERE organization_id = $1 AND source = $2`,
      [orgId, source]
    );
    const count = parseInt(countResult.rows[0]?.count || 0);
    
    if (count === 0) {
      return res.json({
        success: true,
        deleted: 0,
        message: req.t('systemSettings.endUsers.noUsersToDelete')
      });
    }
    
    // Delete all users from this source
    await query(
      `DELETE FROM end_users WHERE organization_id = $1 AND source = $2`,
      [orgId, source]
    );
    
    res.json({
      success: true,
      deleted: count,
      message: req.t('systemSettings.endUsers.bulkDeleted', { count, source: source.charAt(0).toUpperCase() + source.slice(1) })
    });
  } catch (err) {
    console.error('API end-users bulk delete error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.endUsers.deleteFailed') });
  }
});

// ============================================
// END USER GROUPS
// ============================================

/**
 * DELETE /api/groups/source/:source - Bulk delete groups by source (admin only)
 * Used to clean up groups from a specific source (e.g., google, microsoft)
 */
router.delete('/groups/source/:source', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const source = req.params.source.toLowerCase();
    
    // Validate source
    const validSources = ['google', 'microsoft'];
    if (!validSources.includes(source)) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.groups.invalidSource') 
      });
    }
    
    // Count groups to be deleted
    const countResult = await query(
      `SELECT COUNT(*) as count FROM end_user_groups WHERE organization_id = $1 AND source = $2`,
      [orgId, source]
    );
    const count = parseInt(countResult.rows[0]?.count || 0);
    
    if (count === 0) {
      return res.json({
        success: true,
        deleted: 0,
        message: req.t('systemSettings.groups.noGroupsToDelete')
      });
    }
    
    // Delete group members first (foreign key constraint)
    await query(
      `DELETE FROM end_user_group_members 
       WHERE group_id IN (SELECT id FROM end_user_groups WHERE organization_id = $1 AND source = $2)`,
      [orgId, source]
    );
    
    // Delete groups
    const deleteResult = await query(
      `DELETE FROM end_user_groups WHERE organization_id = $1 AND source = $2 RETURNING id`,
      [orgId, source]
    );
    
    const deleted = deleteResult.rows.length;
    
    console.log(`[API] Deleted ${deleted} ${source} groups for org ${orgId}`);
    
    res.json({
      success: true,
      deleted,
      message: req.t('systemSettings.groups.groupsDeleted', { count: deleted })
    });
    
  } catch (err) {
    console.error('API delete groups by source error:', err);
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.groups.deleteFailed')
    });
  }
});

/**
 * GET /api/groups - List all groups in org (admin only)
 */
router.get('/groups', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    
    // Get all groups with member count
    const result = await query(
      `SELECT g.id, g.name, g.description, g.source, g.external_id, g.created_at, g.updated_at,
              COUNT(gm.end_user_id) as member_count
       FROM end_user_groups g
       LEFT JOIN end_user_group_members gm ON g.id = gm.group_id
       WHERE g.organization_id = $1
       GROUP BY g.id
       ORDER BY g.name ASC`,
      [orgId]
    );
    
    res.json({
      success: true,
      groups: result.rows
    });
  } catch (err) {
    console.error('API groups list error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.groups.loadFailed') });
  }
});

/**
 * GET /api/groups/:id - Get group details with members (admin only)
 */
router.get('/groups/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    
    // Get group info
    const groupResult = await query(
      `SELECT id, name, description, source, external_id, created_at, updated_at
       FROM end_user_groups
       WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: req.t('systemSettings.groups.notFound') 
      });
    }
    
    // Get members
    const membersResult = await query(
      `SELECT eu.id, eu.email, eu.first_name, eu.last_name, eu.source as user_source, gm.added_at
       FROM end_user_group_members gm
       JOIN end_users eu ON gm.end_user_id = eu.id
       WHERE gm.group_id = $1
       ORDER BY eu.first_name, eu.last_name`,
      [groupId]
    );
    
    res.json({
      success: true,
      group: {
        ...groupResult.rows[0],
        members: membersResult.rows
      }
    });
  } catch (err) {
    console.error('API group detail error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.groups.loadFailed') });
  }
});

/**
 * POST /api/groups - Create a new group (admin only)
 */
router.post('/groups', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const { name, description } = req.body;
    
    const nameTrimmed = name?.trim();
    
    if (!nameTrimmed) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.groups.validation.nameRequired') 
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
        message: req.t('systemSettings.groups.validation.nameExists') 
      });
    }
    
    // Create the group
    const result = await query(
      `INSERT INTO end_user_groups (organization_id, name, description, source)
       VALUES ($1, $2, $3, 'manual')
       RETURNING id, name, description, source, created_at`,
      [orgId, nameTrimmed, description?.trim() || null]
    );
    
    res.json({
      success: true,
      group: { ...result.rows[0], member_count: 0 },
      message: req.t('systemSettings.groups.created')
    });
  } catch (err) {
    console.error('API group create error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.groups.createFailed') });
  }
});

/**
 * PUT /api/groups/:id - Update a group (admin only)
 */
router.put('/groups/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    const { name, description } = req.body;
    
    // Check if group exists
    const existing = await query(
      `SELECT id, source FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: req.t('systemSettings.groups.notFound') 
      });
    }
    
    // Synced groups can only have description edited, not name
    const isSynced = ['microsoft', 'google'].includes(existing.rows[0].source);
    
    const nameTrimmed = name?.trim();
    if (!isSynced && nameTrimmed) {
      // Check if new name conflicts with another group
      const nameConflict = await query(
        `SELECT id FROM end_user_groups WHERE organization_id = $1 AND LOWER(name) = LOWER($2) AND id != $3`,
        [orgId, nameTrimmed, groupId]
      );
      
      if (nameConflict.rows.length > 0) {
        return res.status(409).json({ 
          success: false, 
          message: req.t('systemSettings.groups.validation.nameExists') 
        });
      }
    }
    
    // Update the group
    const result = await query(
      `UPDATE end_user_groups 
       SET name = CASE WHEN $4 = true THEN name ELSE COALESCE($1, name) END,
           description = COALESCE($2, description),
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, description, source, created_at, updated_at`,
      [nameTrimmed, description?.trim(), groupId, isSynced]
    );
    
    res.json({
      success: true,
      group: result.rows[0],
      message: req.t('systemSettings.groups.updated')
    });
  } catch (err) {
    console.error('API group update error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.groups.updateFailed') });
  }
});

/**
 * DELETE /api/groups/:id - Delete a group (admin only)
 */
router.delete('/groups/:id', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    
    // Check if group exists
    const existing = await query(
      `SELECT id, name FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: req.t('systemSettings.groups.notFound') 
      });
    }
    
    // Delete the group (members are cascaded)
    await query(
      `DELETE FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    res.json({
      success: true,
      message: req.t('systemSettings.groups.deleted')
    });
  } catch (err) {
    console.error('API group delete error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.groups.deleteFailed') });
  }
});

/**
 * POST /api/groups/:id/members - Add members to a group (admin only)
 */
router.post('/groups/:id/members', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    const { userIds } = req.body;
    
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.groups.validation.noUsersSelected') 
      });
    }
    
    // Verify group exists
    const groupResult = await query(
      `SELECT id FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: req.t('systemSettings.groups.notFound') 
      });
    }
    
    // Verify all users exist and belong to org
    const usersResult = await query(
      `SELECT id FROM end_users WHERE id = ANY($1) AND organization_id = $2`,
      [userIds, orgId]
    );
    
    const validUserIds = usersResult.rows.map(r => r.id);
    
    // Add members (ignore conflicts for already existing members)
    let added = 0;
    for (const userId of validUserIds) {
      try {
        await query(
          `INSERT INTO end_user_group_members (group_id, end_user_id)
           VALUES ($1, $2)
           ON CONFLICT (group_id, end_user_id) DO NOTHING`,
          [groupId, userId]
        );
        added++;
      } catch (_err) {
        // Ignore individual insert errors
      }
    }
    
    res.json({
      success: true,
      added,
      message: req.t('systemSettings.groups.membersAdded', { count: added })
    });
  } catch (err) {
    console.error('API group add members error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.groups.memberAddFailed') });
  }
});

/**
 * DELETE /api/groups/:id/members/:userId - Remove a member from a group (admin only)
 */
router.delete('/groups/:id/members/:userId', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    const userId = req.params.userId;
    
    // Verify group belongs to org
    const groupResult = await query(
      `SELECT id FROM end_user_groups WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId]
    );
    
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: req.t('systemSettings.groups.notFound') 
      });
    }
    
    // Remove member
    await query(
      `DELETE FROM end_user_group_members WHERE group_id = $1 AND end_user_id = $2`,
      [groupId, userId]
    );
    
    res.json({
      success: true,
      message: req.t('systemSettings.groups.memberRemoved')
    });
  } catch (err) {
    console.error('API group remove member error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.groups.memberRemoveFailed') });
  }
});

/**
 * GET /api/groups/:id/non-members - Get users NOT in this group (for adding)
 */
router.get('/groups/:id/non-members', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const groupId = req.params.id;
    const search = req.query.search?.trim() || '';
    
    // Get users not in this group
    let whereClause = `WHERE eu.organization_id = $1 AND eu.is_active = true 
                       AND eu.id NOT IN (SELECT end_user_id FROM end_user_group_members WHERE group_id = $2)`;
    const params = [orgId, groupId];
    
    if (search) {
      whereClause += ` AND (eu.first_name ILIKE $3 OR eu.last_name ILIKE $3 OR eu.email ILIKE $3)`;
      params.push(`%${search}%`);
    }
    
    const result = await query(
      `SELECT eu.id, eu.email, eu.first_name, eu.last_name
       FROM end_users eu
       ${whereClause}
       ORDER BY eu.first_name, eu.last_name
       LIMIT 50`,
      params
    );
    
    res.json({
      success: true,
      users: result.rows
    });
  } catch (err) {
    console.error('API group non-members error:', err);
    res.status(500).json({ success: false, message: req.t('systemSettings.groups.loadFailed') });
  }
});

// ============================================
// END USERS - CSV/Excel Import
// ============================================

/**
 * Helper: Check if a row looks like a header row
 */
function isHeaderRow(row) {
  if (!row || row.length < 3) return false;
  
  // Words may be joined by spaces or underscores (first_name, email_address)
  const headerPatterns = [
    /^(first[\s_]*name|voornaam|vorname|prénom|nombre)$/i,
    /^(last[\s_]*name|achternaam|nachname|nom|apellido)$/i,
    /^(e-?mail|e-?mail[\s_]*address?|e-?mailadres|adresse[\s_]*e-?mail|correo)$/i
  ];
  
  // Check if first 3 cells match common header patterns
  const matchCount = row.slice(0, 3).filter((cell, idx) => {
    const cellStr = String(cell || '').trim();
    return headerPatterns[idx]?.test(cellStr);
  }).length;
  
  // Also check for generic headers
  const genericHeaders = ['name', 'naam', 'first', 'last', 'email', 'mail', 'column', 'kolom', 'a', 'b', 'c'];
  const hasGenericHeader = row.slice(0, 3).some(cell => {
    const cellStr = String(cell || '').trim().toLowerCase();
    return genericHeaders.includes(cellStr);
  });
  
  return matchCount >= 2 || hasGenericHeader;
}

/**
 * Helper: Validate email format
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Helper: Parse spreadsheet and validate data
 */
function parseAndValidateSpreadsheet(buffer, _filename) {
  const result = {
    success: false,
    users: [],
    errors: [],
    warnings: [],
    skippedHeader: false,
    totalRows: 0
  };
  
  try {
    // Parse the workbook
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    
    if (!workbook.SheetNames.length) {
      result.errors.push({ type: 'NO_SHEETS', message: 'The file contains no sheets' });
      return result;
    }
    
    // Get first sheet
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    // Convert to array of arrays
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    
    if (!data || data.length === 0) {
      result.errors.push({ type: 'EMPTY_FILE', message: 'The file is empty' });
      return result;
    }
    
    result.totalRows = data.length;
    
    // Check if first row is a header
    let startRow = 0;
    if (isHeaderRow(data[0])) {
      startRow = 1;
      result.skippedHeader = true;
    }
    
    // Process each row
    const seenEmails = new Set();
    
    for (let i = startRow; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 1; // 1-based for user display
      
      // Skip completely empty rows
      if (!row || row.every(cell => !cell || String(cell).trim() === '')) {
        continue;
      }
      
      const firstName = String(row[0] || '').trim();
      const lastName = String(row[1] || '').trim();
      const email = String(row[2] || '').trim().toLowerCase();
      
      // Check for extra columns with data
      const extraData = row.slice(3).filter(cell => cell && String(cell).trim() !== '');
      if (extraData.length > 0) {
        result.warnings.push({
          row: rowNum,
          type: 'EXTRA_COLUMNS',
          message: `Row ${rowNum} has data in columns beyond C (only A, B, C are used)`
        });
      }
      
      // Validation
      const rowErrors = [];
      
      if (!firstName) {
        rowErrors.push('First name is empty');
      }
      
      if (!lastName) {
        rowErrors.push('Last name is empty');
      }
      
      if (!email) {
        rowErrors.push('Email is empty');
      } else if (!isValidEmail(email)) {
        rowErrors.push(`Invalid email format: "${email}"`);
      } else if (seenEmails.has(email)) {
        rowErrors.push(`Duplicate email in file: "${email}"`);
      }
      
      if (rowErrors.length > 0) {
        result.errors.push({
          row: rowNum,
          type: 'VALIDATION_ERROR',
          message: `Row ${rowNum}: ${rowErrors.join(', ')}`,
          details: rowErrors
        });
      } else {
        seenEmails.add(email);
        result.users.push({
          first_name: firstName,
          last_name: lastName,
          email: email
        });
      }
    }
    
    if (result.users.length === 0 && result.errors.length === 0) {
      result.errors.push({ type: 'NO_DATA', message: 'No valid data rows found in the file' });
    }
    
    result.success = result.errors.length === 0 && result.users.length > 0;
    
  } catch (err) {
    console.error('Spreadsheet parse error:', err);
    result.errors.push({ 
      type: 'PARSE_ERROR', 
      message: 'Could not read the file. Make sure it is a valid CSV or Excel file.' 
    });
  }
  
  return result;
}

/**
 * POST /api/end-users/import/validate - Validate spreadsheet and return preview (admin only)
 * Does NOT save the file - just parses and validates
 */
router.post('/end-users/import/validate', spreadsheetUpload.single('file'), async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        errorType: 'NO_FILE',
        message: req.t('systemSettings.import.errors.noFile')
      });
    }
    
    const orgId = req.organizationId;
    
    // Parse and validate the spreadsheet
    const parseResult = parseAndValidateSpreadsheet(req.file.buffer, req.file.originalname);
    
    if (!parseResult.success) {
      // Translate error messages
      const translatedErrors = parseResult.errors.map(err => ({
        ...err,
        message: translateImportError(req, err)
      }));
      
      return res.json({
        success: false,
        errorType: parseResult.errors[0]?.type || 'UNKNOWN',
        errors: translatedErrors,
        warnings: parseResult.warnings,
        totalRows: parseResult.totalRows,
        skippedHeader: parseResult.skippedHeader
      });
    }
    
    // Check for existing emails in database
    const emails = parseResult.users.map(u => u.email);
    const existingResult = await query(
      `SELECT email FROM end_users WHERE organization_id = $1 AND email = ANY($2)`,
      [orgId, emails]
    );
    
    const existingEmails = new Set(existingResult.rows.map(r => r.email));
    const newUsers = parseResult.users.filter(u => !existingEmails.has(u.email));
    const duplicateUsers = parseResult.users.filter(u => existingEmails.has(u.email));
    
    res.json({
      success: true,
      preview: {
        totalInFile: parseResult.users.length,
        newUsers: newUsers.length,
        duplicates: duplicateUsers.length,
        skippedHeader: parseResult.skippedHeader,
        sampleUsers: newUsers.slice(0, 5), // Show first 5 as preview
        duplicateEmails: duplicateUsers.map(u => u.email).slice(0, 5)
      },
      warnings: parseResult.warnings,
      // Send the validated data back so client can submit for import
      validatedUsers: newUsers
    });
    
  } catch (err) {
    console.error('API import validate error:', err);
    
    // Handle multer errors
    if (err.message === 'INVALID_FILE_TYPE') {
      return res.status(400).json({ 
        success: false, 
        errorType: 'INVALID_FILE_TYPE',
        message: req.t('systemSettings.import.errors.invalidFileType')
      });
    }
    
    res.status(500).json({ 
      success: false, 
      errorType: 'SERVER_ERROR',
      message: req.t('systemSettings.import.errors.serverError')
    });
  }
});

/**
 * Helper: Translate import error messages
 */
function translateImportError(req, error) {
  switch (error.type) {
    case 'NO_SHEETS':
      return req.t('systemSettings.import.errors.noSheets');
    case 'EMPTY_FILE':
      return req.t('systemSettings.import.errors.emptyFile');
    case 'NO_DATA':
      return req.t('systemSettings.import.errors.noData');
    case 'PARSE_ERROR':
      return req.t('systemSettings.import.errors.parseError');
    case 'VALIDATION_ERROR':
      return req.t('systemSettings.import.errors.validationError', { row: error.row, details: error.details?.join(', ') || '' });
    default:
      return error.message;
  }
}

/**
 * POST /api/end-users/import - Import validated users (admin only)
 * Receives the validated user array from client after confirmation
 */
router.post('/end-users/import', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const { users } = req.body;
    
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.import.errors.noUsersToImport')
      });
    }
    
    // Check end user limit and calculate how many we can import
    const usageData = await getOrganizationUsageWithLimits(orgId);
    let maxToImport = users.length;
    let limitReached = false;
    
    if (usageData && !usageData.usage.endUsers.isUnlimited) {
      const remaining = usageData.usage.endUsers.remaining;
      if (remaining <= 0) {
        return res.status(403).json({ 
          success: false, 
          code: 'LIMIT_EXCEEDED',
          limitType: 'endUsers',
          message: req.t('subscription.limits.endUsersExceeded')
        });
      }
      if (remaining < users.length) {
        maxToImport = remaining;
        limitReached = true;
      }
    }
    
    // Validate each user again before insert
    const validUsers = users.filter(u => 
      u.first_name && 
      u.last_name && 
      u.email && 
      isValidEmail(u.email)
    ).slice(0, maxToImport); // Only take up to the limit
    
    if (validUsers.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.import.errors.noValidUsers')
      });
    }
    
    // Insert users in batches
    let imported = 0;
    let skipped = 0;
    
    for (const user of validUsers) {
      try {
        const emailTrimmed = user.email.toLowerCase().trim();
        
        // Skip super admin email
        if (isPlatformAdminEmail(emailTrimmed)) {
          console.log('Skipping reserved email:', emailTrimmed);
          skipped++;
          continue;
        }
        
        await query(
          `INSERT INTO end_users (organization_id, email, first_name, last_name, source)
           VALUES ($1, $2, $3, $4, 'csv')
           ON CONFLICT (organization_id, email) DO NOTHING`,
          [orgId, emailTrimmed, user.first_name.trim(), user.last_name.trim()]
        );
        imported++;
      } catch (err) {
        console.error('Failed to import user:', user.email, err);
        skipped++;
      }
    }
    
    const notImportedDueToLimit = users.length - validUsers.length;
    
    res.json({
      success: true,
      imported,
      skipped,
      limitReached,
      notImportedDueToLimit,
      message: limitReached 
        ? req.t('systemSettings.import.successWithLimit', { count: imported, skipped: notImportedDueToLimit })
        : req.t('systemSettings.import.success', { count: imported })
    });
    
  } catch (err) {
    console.error('API import error:', err);
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.import.errors.importFailed')
    });
  }
});

// ============================================
// GOOGLE WORKSPACE INTEGRATION
// ============================================

import {
  isGoogleConfigured,
  getAuthorizationUrl,
  refreshAccessToken,
  fetchAllWorkspaceUsers,
  fetchAllWorkspaceGroups,
  fetchAllGroupMembers as fetchAllGoogleGroupMembers,
  getUser as getGoogleUser,
  transformGoogleUser,
  transformGoogleGroup
} from '../services/google.js';

/**
 * GET /api/google/status - Check Google integration status
 */
router.get('/google/status', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const configured = await isGoogleConfigured();
    
    // Check if organization has connected Google account
    const result = await query(
      `SELECT google_refresh_token IS NOT NULL AS google_refresh_token, google_connected_email, 
              google_connected_at, google_domain, google_last_sync, google_sync_config
       FROM organizations WHERE id = $1`,
      [orgId]
    );
    
    const org = result.rows[0];
    const connected = !!(org?.google_refresh_token);
    
    // Parse sync config
    const defaultSyncConfig = { syncMode: 'all', syncGroups: true, selectedGroupIds: [], autoSyncEnabled: true };
    const syncConfig = org?.google_sync_config || defaultSyncConfig;
    
    // Always get count of Google-synced users (even if disconnected)
    const countResult = await query(
      `SELECT COUNT(*) as count FROM end_users WHERE organization_id = $1 AND source = 'google'`,
      [orgId]
    );
    const googleUserCount = parseInt(countResult.rows[0]?.count || 0);
    
    // Get count of Google-synced groups
    const groupCountResult = await query(
      `SELECT COUNT(*) as count FROM end_user_groups WHERE organization_id = $1 AND source = 'google'`,
      [orgId]
    );
    const googleGroupCount = parseInt(groupCountResult.rows[0]?.count || 0);
    
    res.json({
      success: true,
      configured,
      connected,
      connectedEmail: org?.google_connected_email || null,
      connectedAt: org?.google_connected_at || null,
      domain: org?.google_domain || null,
      lastSync: org?.google_last_sync || null,
      userCount: googleUserCount,
      groupCount: googleGroupCount,
      orphanedGroupCount: !connected ? googleGroupCount : 0,
      syncConfig
    });
    
  } catch (err) {
    console.error('API google status error:', err);
    res.status(500).json({ success: false, message: 'Failed to check Google status' });
  }
});

/**
 * GET /api/google/connect - Start Google OAuth flow
 */
router.get('/google/connect', async (req, res) => {
  console.log('[Google Connect] Request received');
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    console.log('[Google Connect] Checking if Google is configured...');
    if (!(await isGoogleConfigured())) {
      console.log('[Google Connect] NOT CONFIGURED!');
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.google.notConfigured') 
      });
    }
    
    const orgId = req.organizationId;
    const userId = req.userId;
    console.log('[Google Connect] Org:', orgId, 'User:', userId);
    
    if (!(await isFeatureEnabled(orgId, 'sync'))) {
      return res.status(403).json({ 
        success: false, 
        code: 'SYNC_NOT_IN_PLAN',
        message: req.t('subscription.limits.syncLocked') 
      });
    }
    
    // Create an HMAC-signed state token that includes org ID for callback
    // verification. Signing prevents an attacker from forging a state with a
    // victim's orgId (OAuth CSRF / org-takeover).
    const stateData = {
      orgId,
      userId,
      timestamp: Date.now()
    };
    const state = signOAuthState(stateData);
    
    // Store state in session for verification (defense in depth)
    req.session.googleOAuthState = state;
    
    const authUrl = await getAuthorizationUrl(state);
    
    res.json({
      success: true,
      authUrl
    });
    
  } catch (err) {
    console.error('API google connect error:', err);
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.google.connectFailed') 
    });
  }
});

/**
 * GET /api/google/disconnect - Disconnect Google account
 */
router.get('/google/disconnect', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    
    // Clear Google tokens from organization
    await query(
      `UPDATE organizations SET 
        google_access_token = NULL,
        google_refresh_token = NULL,
        google_connected_email = NULL,
        google_connected_at = NULL,
        google_domain = NULL
       WHERE id = $1`,
      [orgId]
    );
    
    res.json({
      success: true,
      message: req.t('systemSettings.google.disconnected')
    });
    
  } catch (err) {
    console.error('API google disconnect error:', err);
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.google.disconnectFailed') 
    });
  }
});

/**
 * GET /api/google/groups - Get available groups from Google Workspace
 */
router.get('/google/groups', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    
    // Get stored tokens
    const orgResult = await query(
      `SELECT google_access_token, google_refresh_token, google_domain
       FROM organizations WHERE id = $1`,
      [orgId]
    );
    
    const org = orgResult.rows[0];
    
    if (!org?.google_refresh_token) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.google.notConnected') 
      });
    }
    
    // Refresh token
    let accessToken = decryptToken(org.google_access_token);
    try {
      const tokenResponse = await refreshAccessToken(decryptToken(org.google_refresh_token));
      accessToken = tokenResponse.access_token;
      
      await query(
        `UPDATE organizations SET google_access_token = $1 WHERE id = $2`,
        [encryptToken(accessToken), orgId]
      );
    } catch (refreshErr) {
      console.error('[Google Groups] Token refresh failed:', refreshErr);
    }
    
    // Fetch groups from Google Workspace
    const googleGroups = await fetchAllWorkspaceGroups(accessToken, org.google_domain);
    
    // Transform groups for frontend
    const groups = googleGroups.map(g => ({
      id: g.id,
      name: g.name || g.email?.split('@')[0] || 'Unnamed Group',
      email: g.email,
      description: g.description || '',
      memberCount: parseInt(g.directMembersCount) || 0
    }));
    
    res.json({
      success: true,
      groups
    });
    
  } catch (err) {
    console.error('API google groups error:', err);
    
    if (err.message === 'INSUFFICIENT_PERMISSIONS') {
      return res.status(403).json({ 
        success: false, 
        message: req.t('systemSettings.google.insufficientPermissions') 
      });
    }
    if (err.message === 'TOKEN_EXPIRED') {
      return res.status(401).json({ 
        success: false, 
        message: req.t('systemSettings.google.tokenExpired') 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: req.t('errors.failedToLoad') 
    });
  }
});

/**
 * PUT /api/google/config - Update Google sync configuration
 */
router.put('/google/config', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const { syncMode, selectedGroupIds, syncGroups, autoSyncEnabled, groupsToSync, importGroupMembersAsUsers } = req.body;
    
    // Validate sync mode
    if (syncMode && !['all', 'groups'].includes(syncMode)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid sync mode' 
      });
    }
    
    // Build config object
    const syncConfig = {
      syncMode: syncMode || 'all',
      selectedGroupIds: selectedGroupIds || [],
      syncGroups: syncGroups !== false,
      autoSyncEnabled: autoSyncEnabled !== false,
      groupsToSync: groupsToSync || [],
      importGroupMembersAsUsers: importGroupMembersAsUsers === true
    };
    
    // Update organization
    await query(
      `UPDATE organizations SET google_sync_config = $1 WHERE id = $2`,
      [JSON.stringify(syncConfig), orgId]
    );
    
    res.json({
      success: true,
      message: req.t('systemSettings.google.configSaved'),
      syncConfig
    });
    
  } catch (err) {
    console.error('API google config error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to save configuration' 
    });
  }
});

/**
 * Sync users and groups from Google Workspace (shared logic)
 * @param {string} orgId - Organization ID
 * @param {Object} options - Sync options
 * @returns {Promise<Object>} Sync result
 */
async function syncGoogleUsers(orgId, options = {}) {
  const { isAutoSync: _isAutoSync = false, t: _t = (key) => key } = options;
  // Set when part of the directory could not be read: then nobody is deleted
  let fetchIncomplete = false;
  
  // Get stored tokens and sync config
  const orgResult = await query(
    `SELECT google_access_token, google_refresh_token, google_domain, google_sync_config
     FROM organizations WHERE id = $1`,
    [orgId]
  );
  
  const org = orgResult.rows[0];
  
  if (!org?.google_refresh_token) {
    throw new Error('NOT_CONNECTED');
  }
  
  if (!(await isFeatureEnabled(orgId, 'sync'))) {
    throw new Error('SYNC_NOT_IN_PLAN');
  }
  
  // Parse sync config
  const defaultSyncConfig = { syncMode: 'all', syncGroups: true, selectedGroupIds: [], autoSyncEnabled: true };
  const syncConfig = org.google_sync_config || defaultSyncConfig;
  
  let accessToken = decryptToken(org.google_access_token);
  
  // Refresh token
  try {
    const tokenResponse = await refreshAccessToken(decryptToken(org.google_refresh_token));
    accessToken = tokenResponse.access_token;
    
    await query(
      `UPDATE organizations SET google_access_token = $1 WHERE id = $2`,
      [encryptToken(accessToken), orgId]
    );
  } catch (refreshErr) {
    console.error('[Google Sync] Token refresh failed:', refreshErr);
    // Try with existing token
  }
  
  let usersToSync = [];
  let groupsToSync = [];
  
  // Fetch all groups once if we need them
  let allGroups = [];
  if (syncConfig.syncMode === 'groups' || syncConfig.syncGroups) {
    allGroups = await fetchAllWorkspaceGroups(accessToken, org.google_domain);
  }
  
  // Determine which users to sync based on syncMode
  if (syncConfig.syncMode === 'groups' && syncConfig.selectedGroupIds?.length > 0) {
    // Sync only users from selected groups
    console.log(`[Google Sync] Syncing users from ${syncConfig.selectedGroupIds.length} selected groups`);
    
    // Get selected groups for user sync
    const selectedGroups = allGroups.filter(g => syncConfig.selectedGroupIds.includes(g.id));
    
    // Collect unique users from all selected groups
    const userEmailMap = new Map(); // email -> user data
    
    for (const group of selectedGroups) {
      try {
        const members = await fetchAllGoogleGroupMembers(accessToken, group.email);
        
        for (const member of members) {
          if (!userEmailMap.has(member.email?.toLowerCase())) {
            // Get full user details
            const userDetails = await getGoogleUser(accessToken, member.email);
            if (userDetails && !userDetails.suspended) {
              userEmailMap.set(userDetails.primaryEmail.toLowerCase(), userDetails);
            }
          }
        }
      } catch (groupErr) {
        fetchIncomplete = true;
        console.error(`[Google Sync] Failed to get members for group ${group.email}:`, groupErr);
      }
    }
    
    usersToSync = Array.from(userEmailMap.values());
    console.log(`[Google Sync] Found ${usersToSync.length} unique users from selected groups`);
  } else {
    // Sync all users
    console.log('[Google Sync] Syncing all users');
    const allUsers = await fetchAllWorkspaceUsers(accessToken, org.google_domain);
    usersToSync = allUsers.filter(u => !u.suspended);
  }
  
  // Determine which groups to sync (if group sync is enabled)
  if (syncConfig.syncGroups) {
    if (syncConfig.groupsToSync?.length > 0) {
      // Only sync selected groups
      groupsToSync = allGroups.filter(g => syncConfig.groupsToSync.includes(g.id));
      console.log(`[Google Sync] Will sync ${groupsToSync.length} selected groups`);
    } else {
      // Sync all groups
      groupsToSync = allGroups;
      console.log(`[Google Sync] Will sync all ${groupsToSync.length} groups`);
    }
    
    // If importGroupMembersAsUsers is enabled, add members of groups to sync as users
    if (syncConfig.importGroupMembersAsUsers && groupsToSync.length > 0) {
      console.log('[Google Sync] Also importing members of synced groups as users');
      const userEmailMap = new Map(usersToSync.map(u => [u.primaryEmail.toLowerCase(), u]));
      
      for (const group of groupsToSync) {
        try {
          const members = await fetchAllGoogleGroupMembers(accessToken, group.email);
          
          for (const member of members) {
            if (member.email && !userEmailMap.has(member.email.toLowerCase())) {
              const userDetails = await getGoogleUser(accessToken, member.email);
              if (userDetails && !userDetails.suspended) {
                userEmailMap.set(userDetails.primaryEmail.toLowerCase(), userDetails);
              }
            }
          }
        } catch (groupErr) {
          fetchIncomplete = true;
          console.error(`[Google Sync] Failed to get members for group ${group.email}:`, groupErr);
        }
      }
      
      usersToSync = Array.from(userEmailMap.values());
      console.log(`[Google Sync] Total users after including group members: ${usersToSync.length}`);
    }
  }
  
  // Get current Google users in our system
  const currentUsersResult = await query(
    `SELECT id, email FROM end_users WHERE organization_id = $1 AND source = 'google'`,
    [orgId]
  );
  const currentUsers = currentUsersResult.rows;
  const currentEmailSet = new Set(currentUsers.map(u => u.email.toLowerCase()));
  
  // Build set of active Google emails
  const googleEmailSet = new Set();
  usersToSync.forEach(u => {
    googleEmailSet.add(u.primaryEmail.toLowerCase());
  });
  
  // Find users to remove
  const usersToRemove = currentUsers.filter(u => !googleEmailSet.has(u.email.toLowerCase()));
  
  // PROTECTION: If more than 10% of users would be deleted, abort deletions
  const deletePercentage = currentUsers.length > 0 
    ? (usersToRemove.length / currentUsers.length) * 100 
    : 0;
  
  let deleted = 0;
  let deleteSkipped = false;
  
  if (usersToRemove.length > 0 && fetchIncomplete) {
    console.warn(`[Google Sync] Directory only partly read - skipping ${usersToRemove.length} deletions`);
    deleteSkipped = true;
  } else if (usersToRemove.length > 0 && deletePercentage > 50) {
    console.warn(`[Google Sync] PROTECTION: Would delete ${usersToRemove.length} users (${deletePercentage.toFixed(1)}%) - skipping deletions for safety`);
    deleteSkipped = true;
  } else if (usersToRemove.length > 0) {
    for (const user of usersToRemove) {
      try {
        await query(
          `DELETE FROM end_users WHERE id = $1 AND organization_id = $2 AND source = 'google'`,
          [user.id, orgId]
        );
        deleted++;
        console.log(`[Google Sync] Removed user: ${user.email} (no longer in Google Workspace)`);
      } catch (err) {
        console.error(`[Google Sync] Failed to delete user ${user.email}:`, err);
      }
    }
  }
  
  // Add/update users from Google
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let limitSkipped = 0;
  
  // New end users stop at the tier limit; alphabetical, so each run picks the same people
  const allowance = await getSyncEndUserAllowance(orgId);
  let remainingNew = allowance.remaining;
  usersToSync.sort((a, b) => a.primaryEmail.toLowerCase().localeCompare(b.primaryEmail.toLowerCase()));
  
  for (const googleUser of usersToSync) {
    const userData = transformGoogleUser(googleUser);
    const emailLower = userData.email.toLowerCase();
    const isExisting = currentEmailSet.has(emailLower);
    const isNewEndUser = !allowance.existingEmails.has(emailLower);
    
    // Skip super admin email
    if (isPlatformAdminEmail(emailLower)) {
      console.log('Google sync: Skipping reserved email:', emailLower);
      continue;
    }
    
    if (isNewEndUser && remainingNew <= 0) {
      limitSkipped++;
      continue;
    }
    
    try {
      await query(
        `INSERT INTO end_users (organization_id, email, first_name, last_name, source, external_id)
         VALUES ($1, $2, $3, $4, 'google', $5)
         ON CONFLICT (organization_id, email) DO UPDATE SET
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           external_id = EXCLUDED.external_id,
           source = 'google',
           updated_at = NOW()`,
        [orgId, emailLower, userData.first_name, userData.last_name, userData.external_id]
      );
      
      if (isNewEndUser) remainingNew--;
      if (isExisting) {
        updated++;
      } else {
        added++;
      }
    } catch (err) {
      console.error('[Google Sync] Failed to sync user:', userData.email, err);
      skipped++;
    }
  }
  
  // Sync groups if enabled
  let groupsAdded = 0;
  let groupsUpdated = 0;
  
  if (syncConfig.syncGroups && groupsToSync.length > 0) {
    console.log(`[Google Sync] Syncing ${groupsToSync.length} groups`);
    
    // Get current Google groups
    const currentGroupsResult = await query(
      `SELECT id, external_id FROM end_user_groups WHERE organization_id = $1 AND source = 'google'`,
      [orgId]
    );
    const currentGroupExternalIds = new Set(currentGroupsResult.rows.map(g => g.external_id));
    
    for (const googleGroup of groupsToSync) {
      const groupData = transformGoogleGroup(googleGroup);
      const isExistingGroup = currentGroupExternalIds.has(googleGroup.id);
      
      try {
        // Upsert group
        const groupResult = await query(
          `INSERT INTO end_user_groups (organization_id, name, description, source, external_id)
           VALUES ($1, $2, $3, 'google', $4)
           ON CONFLICT (organization_id, name) DO UPDATE SET
             description = EXCLUDED.description,
             external_id = EXCLUDED.external_id,
             source = 'google',
             updated_at = NOW()
           WHERE end_user_groups.source = 'google'
           RETURNING id`,
          [orgId, groupData.name, groupData.description, groupData.external_id]
        );
        
        if (groupResult.rows.length === 0) {
          // A manual group with this name exists: leave it (and its members) alone
          console.warn(`[Sync] Skipped directory group "${groupData.name}": name is used by a manual group`);
          continue;
        }
        const groupId = groupResult.rows[0].id;
        
        if (isExistingGroup) {
          groupsUpdated++;
        } else {
          groupsAdded++;
        }
        
        // Sync group members
        const members = await fetchAllGoogleGroupMembers(accessToken, googleGroup.email);
        
        // Clear existing memberships for this group
        await query(
          `DELETE FROM end_user_group_members WHERE group_id = $1`,
          [groupId]
        );
        
        // Add current members
        for (const member of members) {
          if (member.email) {
            // Find the end_user by email
            const userResult = await query(
              `SELECT id FROM end_users WHERE organization_id = $1 AND email = $2`,
              [orgId, member.email.toLowerCase()]
            );
            
            if (userResult.rows.length > 0) {
              await query(
                `INSERT INTO end_user_group_members (group_id, end_user_id)
                 VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [groupId, userResult.rows[0].id]
              );
            }
          }
        }
      } catch (err) {
        console.error(`[Google Sync] Failed to sync group ${groupData.name}:`, err);
      }
    }
  }
  
  // Update last sync time
  await query(
    `UPDATE organizations SET google_last_sync = NOW() WHERE id = $1`,
    [orgId]
  );
  
  const result = {
    success: true,
    added,
    updated,
    deleted,
    skipped,
    limitSkipped,
    endUserLimit: allowance.limit,
    deleteSkipped,
    groupsAdded,
    groupsUpdated,
    total: usersToSync.length
  };
  
  console.log(`[Google Sync] Org ${orgId}: Users - Added ${added}, Updated ${updated}, Deleted ${deleted}, Skipped ${skipped}, Over limit ${limitSkipped}. Groups - Added ${groupsAdded}, Updated ${groupsUpdated}${deleteSkipped ? ' (user deletions skipped for safety)' : ''}`);
  
  return result;
}

/**
 * POST /api/google/sync - Sync users from Google Workspace
 */
router.post('/google/sync', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    
    const result = await syncGoogleUsers(orgId, { t: req.t });
    
    let message = req.t('systemSettings.google.syncSuccess', { count: result.added + result.updated });
    
    if (result.deleted > 0) {
      message += ` ${req.t('systemSettings.google.syncDeleted', { count: result.deleted })}`;
    }
    
    if (result.deleteSkipped) {
      message += ` ${req.t('systemSettings.google.syncDeleteSkipped')}`;
    }
    
    if (result.limitSkipped > 0) {
      message += ` ${req.t('subscription.limits.syncEndUsersSkipped', { count: result.limitSkipped, limit: result.endUserLimit })}`;
    }
    
    res.json({
      ...result,
      message
    });
    
  } catch (err) {
    console.error('API google sync error:', err);
    
    if (err.message === 'SYNC_NOT_IN_PLAN') {
      return res.status(403).json({ 
        success: false, 
        code: 'SYNC_NOT_IN_PLAN',
        message: req.t('subscription.limits.syncLocked') 
      });
    }
    if (err.message === 'NOT_CONNECTED') {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.google.notConnected') 
      });
    }
    if (err.message === 'INSUFFICIENT_PERMISSIONS') {
      return res.status(403).json({ 
        success: false, 
        message: req.t('systemSettings.google.insufficientPermissions') 
      });
    }
    if (err.message === 'TOKEN_EXPIRED') {
      return res.status(401).json({ 
        success: false, 
        message: req.t('systemSettings.google.tokenExpired') 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.google.syncFailed') 
    });
  }
});

// Export for background sync
export { syncGoogleUsers };

// ============================================
// MICROSOFT 365 INTEGRATION
// ============================================

import {
  isMicrosoftConfigured,
  getAdminConsentUrl,
  getClientCredentialsToken,
  fetchAllUsers,
  fetchAllGroups,
  fetchAllGroupMembers,
  transformMicrosoftUser,
  transformMicrosoftGroup
} from '../services/microsoft.js';

/**
 * GET /api/microsoft/status - Check Microsoft integration status
 */
router.get('/microsoft/status', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const configured = await isMicrosoftConfigured();
    
    // Check if organization has connected Microsoft account
    const result = await query(
      `SELECT microsoft_connected_email, 
              microsoft_connected_at, microsoft_tenant_id, microsoft_tenant_name, 
              microsoft_last_sync, microsoft_sync_config
       FROM organizations WHERE id = $1`,
      [orgId]
    );
    
    const org = result.rows[0];
    const connected = !!(org?.microsoft_tenant_id);
    
    // Get count of Microsoft-synced users and groups
    const userCountResult = await query(
      `SELECT COUNT(*) as count FROM end_users WHERE organization_id = $1 AND source = 'microsoft'`,
      [orgId]
    );
    const microsoftUserCount = parseInt(userCountResult.rows[0]?.count || 0);
    
    const groupCountResult = await query(
      `SELECT COUNT(*) as count FROM end_user_groups WHERE organization_id = $1 AND source = 'microsoft'`,
      [orgId]
    );
    const microsoftGroupCount = parseInt(groupCountResult.rows[0]?.count || 0);
    
    res.json({
      success: true,
      configured,
      connected,
      connectedEmail: org?.microsoft_connected_email || null,
      connectedAt: org?.microsoft_connected_at || null,
      tenantId: org?.microsoft_tenant_id || null,
      tenantName: org?.microsoft_tenant_name || null,
      lastSync: org?.microsoft_last_sync || null,
      syncConfig: org?.microsoft_sync_config || { syncMode: 'all', syncGroups: true, selectedGroupIds: [], autoSyncEnabled: true },
      userCount: microsoftUserCount,
      groupCount: microsoftGroupCount,
      orphanedGroupCount: !connected ? microsoftGroupCount : 0
    });
    
  } catch (err) {
    console.error('API microsoft status error:', err);
    res.status(500).json({ success: false, message: 'Failed to check Microsoft status' });
  }
});

/**
 * GET /api/microsoft/connect - Start Microsoft OAuth Admin Consent flow
 */
router.get('/microsoft/connect', async (req, res) => {
  console.log('[Microsoft Connect] Request received');
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    console.log('[Microsoft Connect] Checking if Microsoft is configured...');
    if (!(await isMicrosoftConfigured())) {
      console.log('[Microsoft Connect] NOT CONFIGURED!');
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.microsoft.notConfigured') 
      });
    }
    
    const orgId = req.organizationId;
    const userId = req.userId;
    console.log('[Microsoft Connect] Org:', orgId, 'User:', userId);
    
    if (!(await isFeatureEnabled(orgId, 'sync'))) {
      return res.status(403).json({ 
        success: false, 
        code: 'SYNC_NOT_IN_PLAN',
        message: req.t('subscription.limits.syncLocked') 
      });
    }
    
    // Create an HMAC-signed state token that includes org ID for callback
    // verification. Signing prevents an attacker from forging a state with a
    // victim's orgId (OAuth CSRF / org-takeover).
    const stateData = {
      orgId,
      userId,
      timestamp: Date.now(),
      type: 'microsoft'
    };
    const state = signOAuthState(stateData);
    
    // Store state in session for verification (defense in depth)
    req.session.microsoftOAuthState = state;
    
    const authUrl = await getAdminConsentUrl(state);
    
    res.json({
      success: true,
      authUrl
    });
    
  } catch (err) {
    console.error('API microsoft connect error:', err);
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.microsoft.connectFailed') 
    });
  }
});

/**
 * GET /api/microsoft/disconnect - Disconnect Microsoft account
 */
router.get('/microsoft/disconnect', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    
    // Clear Microsoft tokens and config from organization
    await query(
      `UPDATE organizations SET 
        microsoft_access_token = NULL,
        microsoft_refresh_token = NULL,
        microsoft_connected_email = NULL,
        microsoft_connected_at = NULL,
        microsoft_tenant_id = NULL,
        microsoft_tenant_name = NULL,
        microsoft_sync_config = '{"syncMode": "all", "syncGroups": true, "selectedGroupIds": [], "autoSyncEnabled": true}'::jsonb
       WHERE id = $1`,
      [orgId]
    );
    
    res.json({
      success: true,
      message: req.t('systemSettings.microsoft.disconnected')
    });
    
  } catch (err) {
    console.error('API microsoft disconnect error:', err);
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.microsoft.disconnectFailed') 
    });
  }
});

/**
 * GET /api/microsoft/groups - List available Microsoft groups for sync configuration
 */
router.get('/microsoft/groups', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    
    // Get stored tokens
    const orgResult = await query(
      `SELECT microsoft_tenant_id
       FROM organizations WHERE id = $1`,
      [orgId]
    );
    
    const org = orgResult.rows[0];
    
    if (!org?.microsoft_tenant_id) {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.microsoft.notConnected') 
      });
    }
    
    // Get fresh token
    const tokenResponse = await getClientCredentialsToken(org.microsoft_tenant_id);
    const accessToken = tokenResponse.access_token;
    
    // Update stored token
    await query(
      `UPDATE organizations SET microsoft_access_token = $1 WHERE id = $2`,
      [encryptToken(accessToken), orgId]
    );
    
    // Fetch groups from Microsoft
    const groups = await fetchAllGroups(accessToken);
    
    // Transform to simple format for UI
    const groupList = groups.map(g => ({
      id: g.id,
      name: g.displayName,
      description: g.description || '',
      mail: g.mail
    }));
    
    res.json({
      success: true,
      groups: groupList
    });
    
  } catch (err) {
    console.error('API microsoft groups error:', err);
    
    if (err.message === 'INSUFFICIENT_PERMISSIONS') {
      return res.status(403).json({ 
        success: false, 
        message: req.t('systemSettings.microsoft.insufficientPermissions') 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.microsoft.groupsFailed') 
    });
  }
});

/**
 * PUT /api/microsoft/config - Update sync configuration
 */
router.put('/microsoft/config', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    const { syncMode, syncGroups, selectedGroupIds, autoSyncEnabled, groupsToSync, importGroupMembersAsUsers } = req.body;
    
    // Validate syncMode
    if (!['all', 'groups'].includes(syncMode)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid sync mode' 
      });
    }
    
    // Build config object
    const syncConfig = {
      syncMode: syncMode || 'all',
      syncGroups: syncGroups !== false,
      selectedGroupIds: Array.isArray(selectedGroupIds) ? selectedGroupIds : [],
      autoSyncEnabled: autoSyncEnabled !== false,
      groupsToSync: Array.isArray(groupsToSync) ? groupsToSync : [],
      importGroupMembersAsUsers: importGroupMembersAsUsers === true
    };
    
    await query(
      `UPDATE organizations SET microsoft_sync_config = $1 WHERE id = $2`,
      [JSON.stringify(syncConfig), orgId]
    );
    
    res.json({
      success: true,
      syncConfig,
      message: req.t('systemSettings.microsoft.configSaved')
    });
    
  } catch (err) {
    console.error('API microsoft config error:', err);
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.microsoft.configFailed') 
    });
  }
});

/**
 * Sync users and groups from Microsoft 365 (shared logic)
 * @param {string} orgId - Organization ID
 * @param {Object} options - Sync options
 * @returns {Promise<Object>} Sync result
 */
async function syncMicrosoftUsers(orgId) {
  // Set when part of the directory could not be read: then nobody is deleted
  let fetchIncomplete = false;
  
  // Get stored config and tokens
  const orgResult = await query(
    `SELECT microsoft_tenant_id, microsoft_sync_config
     FROM organizations WHERE id = $1`,
    [orgId]
  );
  
  const org = orgResult.rows[0];
  
  if (!org?.microsoft_tenant_id) {
    throw new Error('NOT_CONNECTED');
  }
  
  if (!(await isFeatureEnabled(orgId, 'sync'))) {
    throw new Error('SYNC_NOT_IN_PLAN');
  }
  
  const syncConfig = org.microsoft_sync_config || { syncMode: 'all', syncGroups: true, selectedGroupIds: [], autoSyncEnabled: true };
  
  // Get fresh token using client credentials
  let accessToken;
  try {
    const tokenResponse = await getClientCredentialsToken(org.microsoft_tenant_id);
    accessToken = tokenResponse.access_token;
    
    await query(
      `UPDATE organizations SET microsoft_access_token = $1 WHERE id = $2`,
      [encryptToken(accessToken), orgId]
    );
  } catch (tokenErr) {
    console.error('[Microsoft Sync] Token error:', tokenErr);
    throw new Error('TOKEN_ERROR');
  }
  
  let usersToSync = [];
  let groupsToSync = [];
  
  // Fetch all groups if needed
  let allGroups = [];
  if (syncConfig.syncMode === 'groups' || syncConfig.syncGroups) {
    allGroups = await fetchAllGroups(accessToken);
  }
  
  // Determine which users to sync based on config
  if (syncConfig.syncMode === 'all') {
    // Fetch all users
    usersToSync = await fetchAllUsers(accessToken);
  } else if (syncConfig.syncMode === 'groups' && syncConfig.selectedGroupIds?.length > 0) {
    // Fetch users from selected groups only
    const userSet = new Map(); // Use map to deduplicate by ID
    
    for (const groupId of syncConfig.selectedGroupIds) {
      try {
        const members = await fetchAllGroupMembers(accessToken, groupId);
        members.forEach(user => {
          if (!userSet.has(user.id)) {
            userSet.set(user.id, user);
          }
        });
      } catch (err) {
        fetchIncomplete = true;
        console.error(`[Microsoft Sync] Failed to fetch members for group ${groupId}:`, err.message);
      }
    }
    
    usersToSync = Array.from(userSet.values());
  }
  
  // Determine which groups to sync (if group sync is enabled)
  if (syncConfig.syncGroups) {
    if (syncConfig.groupsToSync?.length > 0) {
      // Only sync selected groups
      groupsToSync = allGroups.filter(g => syncConfig.groupsToSync.includes(g.id));
      console.log(`[Microsoft Sync] Will sync ${groupsToSync.length} selected groups`);
    } else {
      // Sync all groups
      groupsToSync = allGroups;
      console.log(`[Microsoft Sync] Will sync all ${groupsToSync.length} groups`);
    }
    
    // If importGroupMembersAsUsers is enabled, add members of groups to sync as users
    if (syncConfig.importGroupMembersAsUsers && groupsToSync.length > 0) {
      console.log('[Microsoft Sync] Also importing members of synced groups as users');
      const userSet = new Map(usersToSync.map(u => [u.id, u]));
      
      for (const group of groupsToSync) {
        try {
          const members = await fetchAllGroupMembers(accessToken, group.id);
          members.forEach(user => {
            if (!userSet.has(user.id)) {
              userSet.set(user.id, user);
            }
          });
        } catch (err) {
          fetchIncomplete = true;
          console.error(`[Microsoft Sync] Failed to fetch members for group ${group.id}:`, err.message);
        }
      }
      
      usersToSync = Array.from(userSet.values());
      console.log(`[Microsoft Sync] Total users after including group members: ${usersToSync.length}`);
    }
  }
  
  // Get current Microsoft users in our system
  const currentUsersResult = await query(
    `SELECT id, email, external_id FROM end_users WHERE organization_id = $1 AND source = 'microsoft'`,
    [orgId]
  );
  const currentUsers = currentUsersResult.rows;
  const currentExternalIdSet = new Set(currentUsers.map(u => u.external_id));
  
  // Build set of Microsoft user IDs we're syncing
  const syncExternalIdSet = new Set();
  const activeUsers = usersToSync.filter(u => u.accountEnabled !== false);
  activeUsers.forEach(u => {
    syncExternalIdSet.add(u.id);
  });
  
  // Find users to remove (in our system but not in sync set)
  const usersToRemove = currentUsers.filter(u => u.external_id && !syncExternalIdSet.has(u.external_id));
  
  // PROTECTION: If more than 10% of users would be deleted, abort deletions
  const deletePercentage = currentUsers.length > 0 
    ? (usersToRemove.length / currentUsers.length) * 100 
    : 0;
  
  let deleted = 0;
  let deleteSkipped = false;
  
  if (usersToRemove.length > 0 && fetchIncomplete) {
    console.warn(`[Microsoft Sync] Directory only partly read - skipping ${usersToRemove.length} deletions`);
    deleteSkipped = true;
  } else if (usersToRemove.length > 0 && deletePercentage > 50) {
    console.warn(`[Microsoft Sync] PROTECTION: Would delete ${usersToRemove.length} users (${deletePercentage.toFixed(1)}%) - skipping deletions for safety`);
    deleteSkipped = true;
  } else if (usersToRemove.length > 0) {
    for (const user of usersToRemove) {
      try {
        await query(
          `DELETE FROM end_users WHERE id = $1 AND organization_id = $2 AND source = 'microsoft'`,
          [user.id, orgId]
        );
        deleted++;
        console.log(`[Microsoft Sync] Removed user: ${user.email} (no longer in sync scope)`);
      } catch (err) {
        console.error(`[Microsoft Sync] Failed to delete user ${user.email}:`, err);
      }
    }
  }
  
  // Add/update users
  let addedUsers = 0;
  let updatedUsers = 0;
  let skippedUsers = 0;
  let limitSkipped = 0;
  
  // New end users stop at the tier limit; alphabetical, so each run picks the same people
  const allowance = await getSyncEndUserAllowance(orgId);
  let remainingNew = allowance.remaining;
  const sortedUsers = activeUsers
    .map(msUser => ({ msUser, userData: transformMicrosoftUser(msUser) }))
    .sort((a, b) => (a.userData.email || '').toLowerCase().localeCompare((b.userData.email || '').toLowerCase()));
  
  for (const { msUser, userData } of sortedUsers) {
    // Skip users without valid email
    if (!userData.email || !userData.email.includes('@')) {
      skippedUsers++;
      continue;
    }
    
    const emailLower = userData.email.toLowerCase();
    const isExisting = currentExternalIdSet.has(msUser.id);
    const isNewEndUser = !allowance.existingEmails.has(emailLower);
    
    // Skip super admin email
    if (isPlatformAdminEmail(emailLower)) {
      console.log('[Microsoft Sync] Skipping reserved email:', emailLower);
      continue;
    }
    
    if (isNewEndUser && remainingNew <= 0) {
      limitSkipped++;
      continue;
    }
    
    try {
      await query(
        `INSERT INTO end_users (organization_id, email, first_name, last_name, source, external_id, is_active)
         VALUES ($1, $2, $3, $4, 'microsoft', $5, $6)
         ON CONFLICT (organization_id, email) DO UPDATE SET
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           external_id = EXCLUDED.external_id,
           source = 'microsoft',
           is_active = EXCLUDED.is_active,
           updated_at = NOW()`,
        [orgId, emailLower, userData.first_name, userData.last_name, userData.external_id, userData.is_active]
      );
      
      if (isNewEndUser) remainingNew--;
      if (isExisting) {
        updatedUsers++;
      } else {
        addedUsers++;
      }
    } catch (err) {
      console.error('[Microsoft Sync] Failed to sync user:', userData.email, err);
      skippedUsers++;
    }
  }
  
  // Sync groups
  let addedGroups = 0;
  let updatedGroups = 0;
  let deletedGroups = 0;
  
  if (syncConfig.syncGroups && groupsToSync.length > 0) {
    // Get current Microsoft groups in our system
    const currentGroupsResult = await query(
      `SELECT id, name, external_id FROM end_user_groups WHERE organization_id = $1 AND source = 'microsoft'`,
      [orgId]
    );
    const currentGroups = currentGroupsResult.rows;
    const currentGroupExternalIdSet = new Set(currentGroups.map(g => g.external_id));
    const syncGroupExternalIdSet = new Set(groupsToSync.map(g => g.id));
    
    // Remove groups no longer in sync scope
    const groupsToRemove = currentGroups.filter(g => g.external_id && !syncGroupExternalIdSet.has(g.external_id));
    for (const group of groupsToRemove) {
      try {
        await query(`DELETE FROM end_user_groups WHERE id = $1`, [group.id]);
        deletedGroups++;
      } catch (err) {
        console.error(`[Microsoft Sync] Failed to delete group ${group.name}:`, err);
      }
    }
    
    // Add/update groups and their members
    for (const msGroup of groupsToSync) {
      const groupData = transformMicrosoftGroup(msGroup);
      const isExistingGroup = currentGroupExternalIdSet.has(msGroup.id);
      
      try {
        // Upsert group
        const groupResult = await query(
          `INSERT INTO end_user_groups (organization_id, name, description, source, external_id)
           VALUES ($1, $2, $3, 'microsoft', $4)
           ON CONFLICT (organization_id, name) DO UPDATE SET
             description = EXCLUDED.description,
             external_id = EXCLUDED.external_id,
             source = 'microsoft',
             updated_at = NOW()
           WHERE end_user_groups.source = 'microsoft'
           RETURNING id`,
          [orgId, groupData.name, groupData.description, groupData.external_id]
        );
        
        if (groupResult.rows.length === 0) {
          // A manual group with this name exists: leave it (and its members) alone
          console.warn(`[Sync] Skipped directory group "${groupData.name}": name is used by a manual group`);
          continue;
        }
        const gryffiGroupId = groupResult.rows[0].id;
        
        if (isExistingGroup) {
          updatedGroups++;
        } else {
          addedGroups++;
        }
        
        // Fetch and sync group members
        try {
          const members = await fetchAllGroupMembers(accessToken, msGroup.id);
          
          // Clear existing memberships for this group
          await query(
            `DELETE FROM end_user_group_members WHERE group_id = $1`,
            [gryffiGroupId]
          );
          
          // Add current members
          for (const member of members) {
            // Find the corresponding end_user by external_id
            const userResult = await query(
              `SELECT id FROM end_users WHERE organization_id = $1 AND external_id = $2`,
              [orgId, member.id]
            );
            
            if (userResult.rows.length > 0) {
              await query(
                `INSERT INTO end_user_group_members (group_id, end_user_id)
                 VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [gryffiGroupId, userResult.rows[0].id]
              );
            }
          }
        } catch (memberErr) {
          console.error(`[Microsoft Sync] Failed to sync members for group ${groupData.name}:`, memberErr.message);
        }
        
      } catch (err) {
        console.error('[Microsoft Sync] Failed to sync group:', groupData.name, err);
      }
    }
  }
  
  // Update last sync time
  await query(
    `UPDATE organizations SET microsoft_last_sync = NOW() WHERE id = $1`,
    [orgId]
  );
  
  const result = {
    success: true,
    users: {
      added: addedUsers,
      updated: updatedUsers,
      deleted,
      skipped: skippedUsers,
      limitSkipped,
      endUserLimit: allowance.limit,
      deleteSkipped,
      total: activeUsers.length
    },
    groups: {
      added: addedGroups,
      updated: updatedGroups,
      deleted: deletedGroups,
      total: groupsToSync.length
    }
  };
  
  console.log(`[Microsoft Sync] Org ${orgId}: Users +${addedUsers} ~${updatedUsers} -${deleted}${limitSkipped ? ` (${limitSkipped} over limit)` : ''}, Groups +${addedGroups} ~${updatedGroups} -${deletedGroups}`);
  
  return result;
}

/**
 * POST /api/microsoft/sync - Sync users and groups from Microsoft 365
 */
router.post('/microsoft/sync', async (req, res) => {
  if (!requireTeamAdmin(req, res)) return;
  
  try {
    const orgId = req.organizationId;
    
    const result = await syncMicrosoftUsers(orgId, { t: req.t });
    
    const syncCount = result.users.added + result.users.updated;
    let message = req.t('systemSettings.microsoft.syncSuccess', { count: syncCount });
    
    if (result.users.deleted > 0) {
      message += ` ${req.t('systemSettings.microsoft.syncDeleted', { count: result.users.deleted })}`;
    }
    
    if (result.users.deleteSkipped) {
      message += ` ${req.t('systemSettings.microsoft.syncDeleteSkipped')}`;
    }
    
    if (result.groups.added + result.groups.updated > 0) {
      message += ` ${req.t('systemSettings.microsoft.groupsSynced', { count: result.groups.added + result.groups.updated })}`;
    }
    
    if (result.users.limitSkipped > 0) {
      message += ` ${req.t('subscription.limits.syncEndUsersSkipped', { count: result.users.limitSkipped, limit: result.users.endUserLimit })}`;
    }
    
    res.json({
      ...result,
      message
    });
    
  } catch (err) {
    console.error('API microsoft sync error:', err);
    
    if (err.message === 'SYNC_NOT_IN_PLAN') {
      return res.status(403).json({ 
        success: false, 
        code: 'SYNC_NOT_IN_PLAN',
        message: req.t('subscription.limits.syncLocked') 
      });
    }
    if (err.message === 'NOT_CONNECTED') {
      return res.status(400).json({ 
        success: false, 
        message: req.t('systemSettings.microsoft.notConnected') 
      });
    }
    if (err.message === 'INSUFFICIENT_PERMISSIONS') {
      return res.status(403).json({ 
        success: false, 
        message: req.t('systemSettings.microsoft.insufficientPermissions') 
      });
    }
    if (err.message === 'TOKEN_ERROR' || err.message === 'TOKEN_EXPIRED') {
      return res.status(401).json({ 
        success: false, 
        message: req.t('systemSettings.microsoft.tokenExpired') 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: req.t('systemSettings.microsoft.syncFailed') 
    });
  }
});

// Export for background sync
export { syncMicrosoftUsers };

// ============================================
// INVITATIONS (Magic Links for End Users)
// ============================================

/**
 * POST /api/invitations - Create new invitations
 * Sends magic link emails to selected end users
 */
router.post('/invitations', async (req, res) => {
  // Only non-viewers can create invitations
  if (req.user?.role === 'viewer') {
    return res.status(403).json({ success: false, error: 'Permission denied' });
  }

  try {
    const orgId = req.organizationId;
    const userId = req.user?.id;
    const { journey_id, validity_days, max_completions, end_user_ids = [], group_ids = [], send_reminder } = req.body;

    // Validate input - need at least one user or group selected
    if (!journey_id || ((!Array.isArray(end_user_ids) || end_user_ids.length === 0) && (!Array.isArray(group_ids) || group_ids.length === 0))) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    // Collect all user IDs (individual users + group members)
    const allUserIds = [...(end_user_ids || [])];
    
    // If groups are selected, fetch their members
    if (Array.isArray(group_ids) && group_ids.length > 0) {
      const groupMembersResult = await query(
        `SELECT DISTINCT gm.end_user_id
         FROM end_user_group_members gm
         JOIN end_user_groups g ON gm.group_id = g.id
         WHERE g.id = ANY($1) AND g.organization_id = $2`,
        [group_ids, orgId]
      );
      
      // Add group members to the user list (avoiding duplicates)
      const groupUserIds = groupMembersResult.rows.map(r => r.end_user_id);
      groupUserIds.forEach(id => {
        if (!allUserIds.includes(id)) {
          allUserIds.push(id);
        }
      });
    }
    
    // Use the combined user list for invitation creation
    const end_user_ids_final = allUserIds;

    // Check journey exists and is published (include settings for language override)
    const journeyResult = await query(
      `SELECT id, title, status, settings FROM journeys 
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [journey_id, orgId]
    );

    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }

    const journey = journeyResult.rows[0];
    if (journey.status !== 'published') {
      return res.status(400).json({ success: false, error: 'Journey must be published' });
    }

    // Calculate expiration date
    const validityDays = parseInt(validity_days) || 14;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + validityDays);

    // Handle max_completions: 0 means unlimited (stored as NULL), otherwise use the value or default to 1
    const parsedMaxCompletions = parseInt(max_completions);
    const maxCompletions = parsedMaxCompletions === 0 ? null : (parsedMaxCompletions || 1);
    
    // Calculate reminder date (halfway through validity period)
    const sendReminderFlag = !!send_reminder;
    let reminderAt = null;
    if (sendReminderFlag) {
      const halfDays = Math.floor(validityDays / 2);
      reminderAt = new Date();
      reminderAt.setDate(reminderAt.getDate() + halfDays);
    }

    // Get organization info for email (including language from settings)
    const orgResult = await query(`SELECT name, settings->>'default_language' as default_language FROM organizations WHERE id = $1`, [orgId]);
    const companyName = orgResult.rows[0]?.name || 'Gryffi';
    const orgLanguage = orgResult.rows[0]?.default_language || 'en';

    // Use journey language override if set, otherwise fall back to org language
    const journeySettings = typeof journey.settings === 'string' ? JSON.parse(journey.settings) : (journey.settings || {});
    const emailLanguage = (journeySettings.language_override && journeySettings.language_code)
      ? journeySettings.language_code
      : orgLanguage;

    // Create invitations for each end user
    const results = [];
    for (const endUserId of end_user_ids_final) {
      try {
        // Check end user exists
        const endUserResult = await query(
          `SELECT id, email, first_name, last_name FROM end_users 
           WHERE id = $1 AND organization_id = $2 AND is_active = true`,
          [endUserId, orgId]
        );

        if (endUserResult.rows.length === 0) {
          results.push({ endUserId, success: false, error: 'User not found' });
          continue;
        }

        const endUser = endUserResult.rows[0];

        // Check for existing active invitation
        const existingResult = await query(
          `SELECT id FROM invitations 
           WHERE end_user_id = $1 AND journey_id = $2 AND status IN ('pending', 'active')`,
          [endUserId, journey_id]
        );

        if (existingResult.rows.length > 0) {
          results.push({ endUserId, success: false, error: 'Already has active invitation' });
          continue;
        }

        // Generate secure token (URL-safe base64)
        const tokenBytes = crypto.randomBytes(32);
        const token = tokenBytes.toString('base64url');

        // Create invitation
        const invResult = await query(
          `INSERT INTO invitations 
           (organization_id, token, journey_id, end_user_id, expires_at, max_completions, created_by, send_reminder, reminder_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [orgId, token, journey_id, endUserId, expiresAt, maxCompletions, userId, sendReminderFlag, reminderAt]
        );

        const magicLink = `${getAppBaseUrl()}/e/${token}`;

        // Send invitation email
        try {
          // Get localized validity text
          const validityTextMap = {
            en: { 7: '1 week', 14: '2 weeks', 30: '1 month', 90: '3 months' },
            nl: { 7: '1 week', 14: '2 weken', 30: '1 maand', 90: '3 maanden' },
            de: { 7: '1 Woche', 14: '2 Wochen', 30: '1 Monat', 90: '3 Monate' },
            fr: { 7: '1 semaine', 14: '2 semaines', 30: '1 mois', 90: '3 mois' },
            es: { 7: '1 semana', 14: '2 semanas', 30: '1 mes', 90: '3 meses' },
            it: { 7: '1 settimana', 14: '2 settimane', 30: '1 mese', 90: '3 mesi' },
            pt: { 7: '1 semana', 14: '2 semanas', 30: '1 mês', 90: '3 meses' },
            da: { 7: '1 uge', 14: '2 uger', 30: '1 måned', 90: '3 måneder' },
            no: { 7: '1 uke', 14: '2 uker', 30: '1 måned', 90: '3 måneder' },
            fi: { 7: '1 viikko', 14: '2 viikkoa', 30: '1 kuukausi', 90: '3 kuukautta' },
            sv: { 7: '1 vecka', 14: '2 veckor', 30: '1 månad', 90: '3 månader' },
            pl: { 7: '1 tydzień', 14: '2 tygodnie', 30: '1 miesiąc', 90: '3 miesiące' },
            ro: { 7: '1 săptămână', 14: '2 săptămâni', 30: '1 lună', 90: '3 luni' },
            tr: { 7: '1 hafta', 14: '2 hafta', 30: '1 ay', 90: '3 ay' }
          };
          const validityText = validityTextMap[emailLanguage]?.[validityDays] || 
                              validityTextMap.en[validityDays] || 
                              `${validityDays} days`;

          await sendInvitationEmail({
            to: endUser.email,
            firstName: endUser.first_name,
            journeyTitle: journey.title,
            companyName: companyName,
            magicLink: magicLink,
            validityText: validityText,
            language: emailLanguage,
            orgId: orgId,
            // Route the unsubscribe to the maker who sent the invite so the
            // recipient can ask the human directly to stop being invited.
            unsubscribeEmail: req.user?.email || null
          });

          results.push({ endUserId, success: true, invitationId: invResult.rows[0].id });
        } catch (emailErr) {
          console.error('Failed to send invitation email:', emailErr);
          // Still count as success since invitation was created
          results.push({ endUserId, success: true, invitationId: invResult.rows[0].id, emailError: true });
        }

      } catch (err) {
        console.error('Failed to create invitation for user:', endUserId, err);
        results.push({ endUserId, success: false, error: err.message });
      }
    }

    const sentCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    
    // Collect unique error messages
    const errorMessages = [...new Set(results.filter(r => !r.success).map(r => r.error))];
    
    // Return appropriate response based on results
    if (sentCount === 0 && failedCount > 0) {
      // All invitations failed
      return res.status(400).json({
        success: false,
        error: errorMessages.join(', '),
        sent_count: 0,
        failed_count: failedCount,
        total_requested: end_user_ids_final.length,
        results
      });
    }
    
    res.json({
      success: true,
      sent_count: sentCount,
      failed_count: failedCount,
      total_requested: end_user_ids_final.length,
      results,
      // Include warning if some failed
      warning: failedCount > 0 ? errorMessages.join(', ') : null
    });

  } catch (err) {
    console.error('API create invitations error:', err);
    res.status(500).json({ success: false, error: 'Failed to create invitations' });
  }
});

/**
 * DELETE /api/invitations/:id - Revoke an invitation
 */
router.delete('/invitations/:id', async (req, res) => {
  // Only non-viewers can revoke invitations
  if (req.user?.role === 'viewer') {
    return res.status(403).json({ success: false, error: 'Permission denied' });
  }

  try {
    const orgId = req.organizationId;
    const invId = req.params.id;

    // Update invitation status to revoked
    const result = await query(
      `UPDATE invitations 
       SET status = 'revoked'
       WHERE id = $1 AND organization_id = $2 AND status IN ('pending', 'active')
       RETURNING id`,
      [invId, orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invitation not found or already processed' });
    }

    res.json({ success: true });

  } catch (err) {
    console.error('API revoke invitation error:', err);
    res.status(500).json({ success: false, error: 'Failed to revoke invitation' });
  }
});

/**
 * GET /api/invitations - List invitations (for the current organization)
 * Supports pagination with limit/offset and returns total count
 * Filter parameter uses "effective status":
 *   - completed: completions_count > 0
 *   - active: status = 'active' AND completions_count = 0
 *   - pending/expired/revoked: direct status match
 */
router.get('/invitations', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { filter, journey_id, limit = 50, offset = 0 } = req.query;

    let whereClause = 'WHERE i.organization_id = $1';
    const params = [orgId];
    let paramIndex = 2;

    // Apply effective status filter
    if (filter && filter !== 'all') {
      if (filter === 'completed') {
        // Completed = has at least one completion
        whereClause += ` AND i.completions_count > 0`;
      } else if (filter === 'active') {
        // Active = status is active AND no completions yet
        whereClause += ` AND i.status = 'active' AND i.completions_count = 0`;
      } else {
        // Other statuses (pending, expired, revoked) = direct match
        whereClause += ` AND i.status = $${paramIndex}`;
        params.push(filter);
        paramIndex++;
      }
    }

    if (journey_id) {
      whereClause += ` AND i.journey_id = $${paramIndex}`;
      params.push(journey_id);
      paramIndex++;
    }

    // Get total count for pagination (using same filter)
    const countResult = await query(
      `SELECT COUNT(*) as total
      FROM invitations i
      JOIN end_users eu ON i.end_user_id = eu.id
      JOIN journeys j ON i.journey_id = j.id
      ${whereClause}`,
      params.slice(0, paramIndex - 1)
    );
    const total = parseInt(countResult.rows[0]?.total) || 0;

    params.push(parseInt(limit), parseInt(offset));

    const result = await query(
      `SELECT 
        i.id, i.organization_id, i.journey_id, i.end_user_id, i.expires_at, i.max_completions, i.completions_count, i.status,
        i.first_accessed_at, i.last_accessed_at, i.completed_at, i.created_at, i.created_by, i.send_reminder, i.reminder_at, i.reminder_sent_at,
        eu.first_name as end_user_first_name,
        eu.last_name as end_user_last_name,
        eu.email as end_user_email,
        j.title as journey_title,
        u.first_name || ' ' || u.last_name as created_by_name
      FROM invitations i
      JOIN end_users eu ON i.end_user_id = eu.id
      JOIN journeys j ON i.journey_id = j.id
      LEFT JOIN users u ON i.created_by = u.id
      ${whereClause}
      ORDER BY i.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params
    );

    res.json({
      success: true,
      invitations: result.rows,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        pages: Math.ceil(total / parseInt(limit)),
        currentPage: Math.floor(parseInt(offset) / parseInt(limit)) + 1
      }
    });

  } catch (err) {
    console.error('API list invitations error:', err);
    res.status(500).json({ success: false, error: 'Failed to load invitations' });
  }
});

// ============================================
// POLL API
// ============================================

/**
 * GET /api/polls/:stepId - Get poll data and results for a step
 */
router.get('/polls/:stepId', async (req, res) => {
  try {
    const { stepId } = req.params;
    const orgId = req.organizationId;
    
    // Verify step belongs to organization
    const stepCheck = await query(`
      SELECT s.id, s.basic_props, j.organization_id
      FROM steps s
      JOIN journeys j ON s.journey_id = j.id
      WHERE s.id = $1 AND j.organization_id = $2 AND s.type = 'poll'
    `, [stepId, orgId]);
    
    if (stepCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Poll not found' });
    }
    
    // Get or create poll record
    const pollResult = await query(
      'SELECT id FROM polls WHERE step_id = $1',
      [stepId]
    );
    
    let pollId;
    if (pollResult.rows.length === 0) {
      // Create poll record
      const newPoll = await query(
        'INSERT INTO polls (organization_id, step_id) VALUES ($1, $2) RETURNING id',
        [orgId, stepId]
      );
      pollId = newPoll.rows[0].id;
    } else {
      pollId = pollResult.rows[0].id;
    }
    
    // Get poll responses aggregated by option
    const responsesResult = await query(`
      SELECT 
        unnest(selected_options) as option_index,
        COUNT(*) as vote_count
      FROM poll_responses
      WHERE poll_id = $1
      GROUP BY option_index
      ORDER BY option_index
    `, [pollId]);
    
    // Get total respondents
    const totalResult = await query(
      'SELECT COUNT(*) as total FROM poll_responses WHERE poll_id = $1',
      [pollId]
    );
    
    const votes = {};
    responsesResult.rows.forEach(row => {
      votes[row.option_index] = parseInt(row.vote_count);
    });
    
    res.json({
      success: true,
      pollId,
      votes,
      totalRespondents: parseInt(totalResult.rows[0].total)
    });
    
  } catch (err) {
    console.error('API get poll error:', err);
    res.status(500).json({ success: false, error: 'Failed to load poll data' });
  }
});

/**
 * POST /api/polls/:stepId/reset - Reset all poll responses (admin only)
 * Note: The vote route is now defined before requireApiAuth for public access
 */
router.post('/polls/:stepId/reset', async (req, res) => {
  try {
    const { stepId } = req.params;
    const user = req.session?.user;
    
    // Only admins and managers can reset polls
    if (!user || !['admin', 'manager'].includes(user.role)) {
      return res.status(403).json({ success: false, error: 'Permission denied' });
    }
    
    // Verify the poll belongs to user's organization
    const pollResult = await query(`
      SELECT p.id, p.organization_id
      FROM polls p
      JOIN steps s ON p.step_id = s.id
      JOIN journeys j ON s.journey_id = j.id
      WHERE p.step_id = $1 AND j.organization_id = $2
    `, [stepId, req.organizationId]);
    
    if (pollResult.rows.length === 0) {
      // Check if step exists but no poll record yet (no votes cast yet)
      const stepCheck = await query(`
        SELECT s.id
        FROM steps s
        JOIN journeys j ON s.journey_id = j.id
        WHERE s.id = $1 AND s.type = 'poll' AND j.organization_id = $2
      `, [stepId, req.organizationId]);
      
      if (stepCheck.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Poll not found' });
      }
      
      // Poll exists but has no responses yet
      return res.json({ success: true, deletedCount: 0 });
    }
    
    const pollId = pollResult.rows[0].id;
    
    // Delete all responses for this poll
    const deleteResult = await query(
      'DELETE FROM poll_responses WHERE poll_id = $1',
      [pollId]
    );
    
    res.json({
      success: true,
      deletedCount: deleteResult.rowCount
    });
    
  } catch (err) {
    console.error('API poll reset error:', err);
    res.status(500).json({ success: false, error: 'Failed to reset poll' });
  }
});

/**
 * GET /api/analytics/polls - Get all poll results for analytics
 */
router.get('/analytics/polls', async (req, res) => {
  try {
    const orgId = req.organizationId;
    
    // Get all polls with step/journey info and vote breakdown in two queries (avoids N+1)
    const pollsResult = await query(`
      SELECT 
        p.id as poll_id,
        p.step_id,
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
      ORDER BY j.title, s.title
    `, [orgId]);
    
    // Batch fetch vote breakdowns for all polls at once
    const pollIds = pollsResult.rows.map(p => p.poll_id);
    const votesByPoll = {};
    if (pollIds.length > 0) {
      const allVotes = await query(`
        SELECT 
          poll_id,
          unnest(selected_options) as option_index,
          COUNT(*) as vote_count
        FROM poll_responses
        WHERE poll_id = ANY($1)
        GROUP BY poll_id, option_index
        ORDER BY poll_id, option_index
      `, [pollIds]);
      
      for (const row of allVotes.rows) {
        if (!votesByPoll[row.poll_id]) votesByPoll[row.poll_id] = {};
        votesByPoll[row.poll_id][row.option_index] = parseInt(row.vote_count);
      }
    }
    
    const polls = pollsResult.rows.map(poll => ({
      ...poll,
      votes: votesByPoll[poll.poll_id] || {},
      basic_props: typeof poll.basic_props === 'string' ? JSON.parse(poll.basic_props) : poll.basic_props
    }));
    
    res.json({
      success: true,
      polls
    });
    
  } catch (err) {
    console.error('API analytics polls error:', err);
    res.status(500).json({ success: false, error: 'Failed to load poll analytics' });
  }
});

/**
 * DELETE /api/analytics/polls/archived - Delete multiple archived polls permanently
 */
router.delete('/analytics/polls/archived', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { pollIds } = req.body;
    
    if (!pollIds || !Array.isArray(pollIds) || pollIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No poll IDs provided' });
    }
    
    // Verify all polls belong to this organization and are archived
    const pollsCheck = await query(`
      SELECT id FROM polls 
      WHERE id = ANY($1::uuid[]) 
        AND organization_id = $2 
        AND is_archived = true
    `, [pollIds, orgId]);
    
    if (pollsCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No archived polls found' });
    }
    
    const validPollIds = pollsCheck.rows.map(p => p.id);
    
    // Delete poll responses first (cascade should handle this but being explicit)
    await query(`DELETE FROM poll_responses WHERE poll_id = ANY($1::uuid[])`, [validPollIds]);
    
    // Delete the archived polls
    await query(`DELETE FROM polls WHERE id = ANY($1::uuid[])`, [validPollIds]);
    
    res.json({ 
      success: true, 
      deletedCount: validPollIds.length 
    });
    
  } catch (err) {
    console.error('API delete archived polls error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete archived polls' });
  }
});

/**
 * DELETE /api/analytics/polls/archived/:pollId - Delete single archived poll permanently
 */
router.delete('/analytics/polls/archived/:pollId', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { pollId } = req.params;
    
    // Verify poll belongs to this organization and is archived
    const pollCheck = await query(`
      SELECT id FROM polls 
      WHERE id = $1 AND organization_id = $2 AND is_archived = true
    `, [pollId, orgId]);
    
    if (pollCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Archived poll not found' });
    }
    
    // Delete poll responses first
    await query(`DELETE FROM poll_responses WHERE poll_id = $1`, [pollId]);
    
    // Delete the archived poll
    await query(`DELETE FROM polls WHERE id = $1`, [pollId]);
    
    res.json({ success: true });
    
  } catch (err) {
    console.error('API delete archived poll error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete archived poll' });
  }
});

// ============================================
// REPORTS API
// ============================================

/**
 * GET /api/reports/journey/:journeyId - Journey Performance Report data
 * Returns completion funnel, timing stats, poll results for a specific journey
 */
router.get('/reports/journey/:journeyId', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const journeyId = req.params.journeyId;
    
    // Verify journey belongs to organization
    const journeyResult = await query(`
      SELECT j.id, j.title, j.status, j.created_at, j.published_at,
             (SELECT COUNT(*) FROM steps WHERE journey_id = j.id) as step_count
      FROM journeys j
      WHERE j.id = $1 AND j.organization_id = $2 AND j.deleted_at IS NULL
    `, [journeyId, orgId]);
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const journey = journeyResult.rows[0];
    
    // Get invitation statistics
    const invitationStats = await query(`
      SELECT 
        COUNT(*) as total_invitations,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'active' AND completions_count = 0) as active,
        COUNT(*) FILTER (WHERE completions_count > 0) as completed,
        COUNT(*) FILTER (WHERE status = 'expired') as expired,
        AVG(EXTRACT(EPOCH FROM (completed_at - first_accessed_at)) / 3600) FILTER (WHERE completed_at IS NOT NULL) as avg_hours_to_complete
      FROM invitations
      WHERE journey_id = $1 AND organization_id = $2
    `, [journeyId, orgId]);
    
    // Get step-by-step funnel data using journey_events (consistent with analytics funnel).
    // This correctly counts end steps that are auto-completed (reward, content, space, etc.)
    const funnelResult = await query(`
      SELECT 
        s.id as step_id,
        s.title as step_title,
        s.position_x,
        s.position_y,
        s.is_start,
        s.is_end,
        s.type,
        COUNT(DISTINCT CASE WHEN je.event_type = 'step_entered' THEN COALESCE(je.end_user_id::text, je.session_id) END) as reached_count,
        COUNT(DISTINCT CASE WHEN je.event_type = 'step_completed' THEN COALESCE(je.end_user_id::text, je.session_id) END) as completed_count
      FROM steps s
      LEFT JOIN journey_events je ON je.step_id = s.id
        AND je.journey_id = $1
        AND je.organization_id = $2
      WHERE s.journey_id = $1
      GROUP BY s.id, s.title, s.position_x, s.position_y, s.is_start, s.is_end, s.type
      ORDER BY s.is_start DESC, s.position_y ASC, s.position_x ASC
    `, [journeyId, orgId]);
    
    // Get poll results for this journey
    const pollsResult = await query(`
      SELECT 
        p.id as poll_id,
        s.title as step_title,
        s.basic_props,
        s.position_y,
        (SELECT COUNT(*) FROM poll_responses WHERE poll_id = p.id) as total_votes
      FROM polls p
      JOIN steps s ON p.step_id = s.id
      WHERE s.journey_id = $1 AND p.organization_id = $2
      ORDER BY s.position_y ASC, s.position_x ASC
    `, [journeyId, orgId]);
    
    // Batch fetch vote breakdowns for all polls in this journey (avoids N+1)
    const journeyPollIds = pollsResult.rows.map(p => p.poll_id);
    const journeyVotesByPoll = {};
    if (journeyPollIds.length > 0) {
      const allVotes = await query(`
        SELECT 
          poll_id,
          unnest(selected_options) as option_index,
          COUNT(*) as vote_count
        FROM poll_responses
        WHERE poll_id = ANY($1)
        GROUP BY poll_id, option_index
        ORDER BY poll_id, option_index
      `, [journeyPollIds]);
      
      for (const row of allVotes.rows) {
        if (!journeyVotesByPoll[row.poll_id]) journeyVotesByPoll[row.poll_id] = {};
        journeyVotesByPoll[row.poll_id][row.option_index] = parseInt(row.vote_count);
      }
    }
    
    const polls = pollsResult.rows.map(poll => ({
      ...poll,
      votes: journeyVotesByPoll[poll.poll_id] || {},
      basic_props: typeof poll.basic_props === 'string' ? JSON.parse(poll.basic_props) : poll.basic_props
    }));
    
    // Get participant list with status
    const participantsResult = await query(`
      SELECT 
        eu.email,
        eu.first_name,
        eu.last_name,
        i.status,
        i.completions_count,
        i.first_accessed_at,
        i.completed_at,
        i.created_at as invited_at
      FROM invitations i
      JOIN end_users eu ON i.end_user_id = eu.id
      WHERE i.journey_id = $1 AND i.organization_id = $2
      ORDER BY i.created_at DESC
      LIMIT 100
    `, [journeyId, orgId]);
    
    const stats = invitationStats.rows[0];
    const totalInvitations = parseInt(stats.total_invitations) || 0;
    const completed = parseInt(stats.completed) || 0;
    
    res.json({
      success: true,
      report: {
        journey: {
          id: journey.id,
          title: journey.title,
          status: journey.status,
          createdAt: journey.created_at,
          publishedAt: journey.published_at,
          stepCount: parseInt(journey.step_count)
        },
        statistics: {
          totalInvitations,
          pending: parseInt(stats.pending) || 0,
          active: parseInt(stats.active) || 0,
          completed,
          expired: parseInt(stats.expired) || 0,
          completionRate: totalInvitations > 0 ? Math.round((completed / totalInvitations) * 100) : 0,
          avgHoursToComplete: stats.avg_hours_to_complete ? parseFloat(stats.avg_hours_to_complete) : null
        },
        funnel: funnelResult.rows.map((step, idx) => {
          const reached = parseInt(step.reached_count) || 0;
          const completed = parseInt(step.completed_count) || 0;
          return {
            stepId: step.step_id,
            title: step.step_title,
            position: idx + 1,
            type: step.type,
            isEnd: step.is_end || false,
            reachedCount: reached,
            reachedPercent: totalInvitations > 0 ? Math.round((reached / totalInvitations) * 100) : 0,
            completedCount: completed,
            completedPercent: reached > 0 ? Math.round((completed / reached) * 100) : 0
          };
        }),
        polls,
        participants: participantsResult.rows
      },
      generatedAt: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('API journey report error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate journey report' });
  }
});

/**
 * GET /api/reports/overview - Periodiek overzichtsrapport data
 * Query params: period (7, 30, 90, 365 days)
 */
router.get('/reports/overview', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const period = parseInt(req.query.period) || 30; // Default 30 days
    
    // Use milliseconds calculation for reliable date math across month boundaries
    const periodMs = period * 24 * 60 * 60 * 1000;
    const periodStart = new Date(Date.now() - periodMs);
    const previousPeriodStart = new Date(Date.now() - periodMs * 2);
    
    // Current period stats
    const currentStats = await query(`
      SELECT 
        COUNT(*) as total_invitations,
        COUNT(*) FILTER (WHERE completions_count > 0) as completed,
        COUNT(*) FILTER (WHERE first_accessed_at IS NOT NULL) as engaged,
        AVG(EXTRACT(EPOCH FROM (completed_at - first_accessed_at)) / 86400) FILTER (WHERE completed_at IS NOT NULL) as avg_days_to_complete
      FROM invitations
      WHERE organization_id = $1 AND created_at >= $2
    `, [orgId, periodStart.toISOString()]);
    
    // Previous period stats (for comparison)
    const previousStats = await query(`
      SELECT 
        COUNT(*) as total_invitations,
        COUNT(*) FILTER (WHERE completions_count > 0) as completed,
        COUNT(*) FILTER (WHERE first_accessed_at IS NOT NULL) as engaged
      FROM invitations
      WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3
    `, [orgId, previousPeriodStart.toISOString(), periodStart.toISOString()]);
    
    // Activity over time (grouped by day/week depending on period)
    const groupBy = period <= 30 ? 'day' : 'week';
    const activityResult = await query(`
      SELECT 
        date_trunc($3, created_at) as period_date,
        COUNT(*) as invitations_sent,
        COUNT(*) FILTER (WHERE completions_count > 0) as completed
      FROM invitations
      WHERE organization_id = $1 AND created_at >= $2
      GROUP BY date_trunc($3, created_at)
      ORDER BY period_date ASC
    `, [orgId, periodStart.toISOString(), groupBy]);
    
    // Top journeys by engagement
    const topJourneysResult = await query(`
      SELECT 
        j.id,
        j.title,
        COUNT(i.id) as invitation_count,
        COUNT(i.id) FILTER (WHERE i.completions_count > 0) as completed_count
      FROM journeys j
      LEFT JOIN invitations i ON j.id = i.journey_id AND i.created_at >= $2
      WHERE j.organization_id = $1 AND j.deleted_at IS NULL
      GROUP BY j.id, j.title
      HAVING COUNT(i.id) > 0
      ORDER BY COUNT(i.id) DESC
      LIMIT 5
    `, [orgId, periodStart.toISOString()]);
    
    // End user growth
    const endUserStats = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE created_at >= $2) as new_users,
        COUNT(*) as total_users
      FROM end_users
      WHERE organization_id = $1
    `, [orgId, periodStart.toISOString()]);
    
    // Poll engagement
    const pollStats = await query(`
      SELECT COUNT(*) as total_responses
      FROM poll_responses pr
      JOIN polls p ON pr.poll_id = p.id
      WHERE p.organization_id = $1 AND pr.created_at >= $2
    `, [orgId, periodStart.toISOString()]);
    
    const current = currentStats.rows[0];
    const previous = previousStats.rows[0];
    
    const currentTotal = parseInt(current.total_invitations) || 0;
    const previousTotal = parseInt(previous.total_invitations) || 0;
    const currentCompleted = parseInt(current.completed) || 0;
    const previousCompleted = parseInt(previous.completed) || 0;
    
    // Calculate trends
    const calcTrend = (curr, prev) => {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 100);
    };
    
    res.json({
      success: true,
      report: {
        period: {
          days: period,
          startDate: periodStart.toISOString(),
          endDate: new Date().toISOString()
        },
        kpis: {
          invitations: {
            current: currentTotal,
            previous: previousTotal,
            trend: calcTrend(currentTotal, previousTotal)
          },
          completed: {
            current: currentCompleted,
            previous: previousCompleted,
            trend: calcTrend(currentCompleted, previousCompleted)
          },
          completionRate: {
            current: currentTotal > 0 ? Math.round((currentCompleted / currentTotal) * 100) : 0,
            previous: previousTotal > 0 ? Math.round((previousCompleted / previousTotal) * 100) : 0,
            trend: null // Calculate separately
          },
          avgDaysToComplete: {
            current: current.avg_days_to_complete ? parseFloat(current.avg_days_to_complete) : null
          },
          engaged: {
            current: parseInt(current.engaged) || 0
          }
        },
        activity: activityResult.rows.map(row => ({
          date: row.period_date,
          invitations: parseInt(row.invitations_sent) || 0,
          completed: parseInt(row.completed) || 0
        })),
        topJourneys: topJourneysResult.rows.map(j => ({
          id: j.id,
          title: j.title,
          invitations: parseInt(j.invitation_count) || 0,
          completed: parseInt(j.completed_count) || 0,
          completionRate: parseInt(j.invitation_count) > 0 
            ? Math.round((parseInt(j.completed_count) / parseInt(j.invitation_count)) * 100) 
            : 0
        })),
        endUsers: {
          total: parseInt(endUserStats.rows[0].total_users) || 0,
          newInPeriod: parseInt(endUserStats.rows[0].new_users) || 0
        },
        pollResponses: parseInt(pollStats.rows[0].total_responses) || 0
      },
      generatedAt: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('API overview report error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate overview report' });
  }
});

/**
 * GET /api/reports/journeys - Get list of journeys for report selection
 */
router.get('/reports/journeys', async (req, res) => {
  try {
    const orgId = req.organizationId;
    
    const journeysResult = await query(`
      SELECT 
        j.id,
        j.title,
        j.status,
        j.published_at,
        (SELECT COUNT(*) FROM invitations WHERE journey_id = j.id) as invitation_count,
        (SELECT COUNT(*) FROM invitations WHERE journey_id = j.id AND completions_count > 0) as completed_count
      FROM journeys j
      WHERE j.organization_id = $1 AND j.deleted_at IS NULL
      ORDER BY j.updated_at DESC
    `, [orgId]);
    
    res.json({
      success: true,
      journeys: journeysResult.rows.map(j => ({
        id: j.id,
        title: j.title,
        status: j.status,
        publishedAt: j.published_at,
        invitationCount: parseInt(j.invitation_count) || 0,
        completedCount: parseInt(j.completed_count) || 0
      }))
    });
    
  } catch (err) {
    console.error('API reports journeys error:', err);
    res.status(500).json({ success: false, error: 'Failed to load journeys' });
  }
});

/**
 * GET /api/rewards - Get all rewards for organization with claim stats
 */
router.get('/rewards', async (req, res) => {
  try {
    const orgId = req.organizationId;
    
    // Get all rewards with their journey and step info
    const rewardsResult = await query(`
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
        r.created_at,
        j.title as journey_title,
        s.title as step_title,
        (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id) as total_codes,
        (SELECT COUNT(*) FROM reward_codes WHERE reward_id = r.id AND is_claimed = true) as claimed_count
      FROM rewards r
      JOIN journeys j ON r.journey_id = j.id
      JOIN steps s ON r.step_id = s.id
      WHERE r.organization_id = $1
      ORDER BY r.created_at DESC
    `, [orgId]);
    
    res.json({
      success: true,
      rewards: rewardsResult.rows.map(r => ({
        id: r.id,
        stepId: r.step_id,
        journeyId: r.journey_id,
        title: r.title,
        description: r.description,
        redemptionLocation: r.redemption_location,
        termsConditions: r.terms_conditions,
        validUntil: r.valid_until,
        isRandomCodes: r.is_random_codes,
        maxRecipients: r.max_recipients,
        createdAt: r.created_at,
        journeyTitle: r.journey_title,
        stepTitle: r.step_title,
        totalCodes: parseInt(r.total_codes) || 0,
        claimedCount: parseInt(r.claimed_count) || 0
      }))
    });
    
  } catch (err) {
    console.error('API rewards error:', err);
    res.status(500).json({ success: false, error: 'Failed to load rewards' });
  }
});

/**
 * GET /api/rewards/step/:stepId/status - Get reward claim status for a specific step (used by builder)
 */
router.get('/rewards/step/:stepId/status', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { stepId } = req.params;
    
    // Get reward for this step
    const rewardResult = await query(`
      SELECT 
        r.id,
        r.is_random_codes,
        r.max_recipients,
        r.code_prefix
      FROM rewards r
      WHERE r.step_id = $1 AND r.organization_id = $2
    `, [stepId, orgId]);
    
    if (rewardResult.rows.length === 0) {
      // No reward configured yet - all fields editable
      return res.json({
        success: true,
        hasReward: false,
        claimedCount: 0,
        totalCodes: 0,
        codes: []
      });
    }
    
    const reward = rewardResult.rows[0];
    
    // Get codes with claim status
    const codesResult = await query(`
      SELECT 
        rc.id,
        rc.code,
        rc.is_claimed,
        rc.claimed_at,
        eu.first_name,
        eu.last_name,
        eu.email
      FROM reward_codes rc
      LEFT JOIN end_users eu ON rc.claimed_by_end_user_id = eu.id
      WHERE rc.reward_id = $1
      ORDER BY rc.is_claimed DESC, rc.claimed_at DESC NULLS LAST, rc.created_at ASC
    `, [reward.id]);
    
    const claimedCount = codesResult.rows.filter(c => c.is_claimed).length;
    
    res.json({
      success: true,
      hasReward: true,
      rewardId: reward.id,
      isRandomCodes: reward.is_random_codes,
      maxRecipients: reward.max_recipients,
      codePrefix: reward.code_prefix,
      claimedCount: claimedCount,
      totalCodes: codesResult.rows.length,
      codes: codesResult.rows.map(c => ({
        id: c.id,
        code: c.code,
        isClaimed: c.is_claimed,
        claimedAt: c.claimed_at,
        claimerName: c.first_name ? `${c.first_name} ${c.last_name || ''}`.trim() : null,
        claimerEmail: c.email
      }))
    });
    
  } catch (err) {
    console.error('API reward step status error:', err);
    res.status(500).json({ success: false, error: 'Failed to load reward status' });
  }
});

/**
 * GET /api/rewards/:rewardId/codes - Get all codes for a specific reward
 */
router.get('/rewards/:rewardId/codes', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { rewardId } = req.params;
    
    // Verify reward belongs to organization
    const rewardCheck = await query(`
      SELECT r.*, j.title as journey_title, s.title as step_title
      FROM rewards r
      JOIN journeys j ON r.journey_id = j.id
      JOIN steps s ON r.step_id = s.id
      WHERE r.id = $1 AND r.organization_id = $2
    `, [rewardId, orgId]);
    
    if (rewardCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Reward not found' });
    }
    
    const reward = rewardCheck.rows[0];
    
    // Get all codes with claimer info (from both end_users and public_participants)
    const codesResult = await query(`
      SELECT 
        rc.id,
        rc.code,
        rc.is_claimed,
        rc.claimed_at,
        rc.claim_position,
        rc.email_sent_at,
        rc.created_at,
        eu.first_name as eu_first_name,
        eu.last_name as eu_last_name,
        eu.email as eu_email,
        pp.first_name as pp_first_name,
        pp.last_name as pp_last_name,
        pp.email as pp_email
      FROM reward_codes rc
      LEFT JOIN end_users eu ON rc.claimed_by_end_user_id = eu.id
      LEFT JOIN public_participants pp ON rc.claimed_by_public_participant_id = pp.id
      WHERE rc.reward_id = $1
      ORDER BY 
        CASE WHEN rc.is_claimed THEN rc.claim_position ELSE 999999 END,
        rc.created_at ASC
    `, [rewardId]);
    
    res.json({
      success: true,
      reward: {
        id: reward.id,
        title: reward.title,
        description: reward.description,
        redemptionLocation: reward.redemption_location,
        termsConditions: reward.terms_conditions,
        validUntil: reward.valid_until,
        isRandomCodes: reward.is_random_codes,
        maxRecipients: reward.max_recipients,
        journeyTitle: reward.journey_title,
        stepTitle: reward.step_title
      },
      codes: codesResult.rows.map(c => {
        // Combine end_user and public_participant info
        const firstName = c.eu_first_name || c.pp_first_name || '';
        const lastName = c.eu_last_name || c.pp_last_name || '';
        const email = c.eu_email || c.pp_email || null;
        const isPublic = !!c.pp_email && !c.eu_email;
        
        return {
          id: c.id,
          code: c.code,
          isClaimed: c.is_claimed,
          claimedAt: c.claimed_at,
          claimPosition: c.claim_position,
          emailSentAt: c.email_sent_at,
          createdAt: c.created_at,
          claimer: c.is_claimed ? {
            name: `${firstName} ${lastName}`.trim() || 'Unknown',
            email: email,
            isPublic: isPublic
          } : null
        };
      })
    });
    
  } catch (err) {
    console.error('API reward codes error:', err);
    res.status(500).json({ success: false, error: 'Failed to load reward codes' });
  }
});

// ============================================
// SUBSCRIPTION & USAGE
// ============================================

/**
 * GET /api/subscription - Get organization's subscription and usage info
 */
router.get('/subscription', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const usageData = await getOrganizationUsageWithLimits(orgId);
    
    if (!usageData) {
      return res.status(404).json({ success: false, error: 'Organization not found' });
    }
    
    res.json({
      success: true,
      ...usageData
    });
  } catch (err) {
    console.error('API subscription error:', err);
    res.status(500).json({ success: false, error: 'Failed to load subscription data' });
  }
});

/**
 * GET /api/subscription/tiers - Get all available subscription tiers
 */
router.get('/subscription/tiers', async (req, res) => {
  try {
    const tiers = await getAllTiers();
    res.json({ success: true, tiers });
  } catch (err) {
    console.error('API tiers error:', err);
    res.status(500).json({ success: false, error: 'Failed to load tiers' });
  }
});

/**
 * GET /api/subscription/usage - Get detailed usage statistics
 */
router.get('/subscription/usage', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const usage = await getOrganizationUsage(orgId);
    
    res.json({
      success: true,
      usage
    });
  } catch (err) {
    console.error('API usage error:', err);
    res.status(500).json({ success: false, error: 'Failed to load usage data' });
  }
});

/**
 * GET /api/subscription/notifications - Get pending limit notifications
 */
router.get('/subscription/notifications', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const notifications = await getPendingNotifications(orgId);
    
    res.json({
      success: true,
      notifications
    });
  } catch (err) {
    console.error('API notifications error:', err);
    res.status(500).json({ success: false, error: 'Failed to load notifications' });
  }
});

/**
 * POST /api/subscription/notifications/:id/acknowledge - Acknowledge a notification
 */
router.post('/subscription/notifications/:id/acknowledge', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    
    await acknowledgeNotification(id, userId);
    
    res.json({ success: true });
  } catch (err) {
    console.error('API acknowledge notification error:', err);
    res.status(500).json({ success: false, error: 'Failed to acknowledge notification' });
  }
});

/**
 * POST /api/subscription/check-limit - Check if a resource can be created
 */
router.post('/subscription/check-limit', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { resourceType, increment } = req.body;
    
    const result = await checkLimit(orgId, resourceType, increment || 1);
    
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('API check limit error:', err);
    res.status(500).json({ success: false, error: 'Failed to check limit' });
  }
});

/**
 * GET /api/subscription/feature/:featureName - Check if a feature is enabled
 */
router.get('/subscription/feature/:featureName', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { featureName } = req.params;
    
    const enabled = await isFeatureEnabled(orgId, featureName);
    
    res.json({
      success: true,
      feature: featureName,
      enabled
    });
  } catch (err) {
    console.error('API feature check error:', err);
    res.status(500).json({ success: false, error: 'Failed to check feature' });
  }
});

// ============================================
// PUBLIC API KEY MANAGEMENT (Admin only)
// ============================================

/**
 * GET /api/api-key/status - Get API key status (Admin only)
 * Returns whether an API key exists and when it was created/last used
 */
router.get('/api-key/status', async (req, res) => {
  try {
    // Check admin role
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: req.t ? req.t('team.messages.noPermission') : 'Permission denied'
      });
    }
    
    const orgId = req.organizationId;
    
    // Check if organization has API access
    const accessResult = await query(`
      SELECT st.api_access 
      FROM organizations o
      JOIN subscription_tiers st ON o.subscription_tier_id = st.id
      WHERE o.id = $1
    `, [orgId]);
    
    const hasApiAccess = accessResult.rows[0]?.api_access || false;
    
    // Get API key status
    const result = await query(`
      SELECT 
        api_key_hash IS NOT NULL as has_api_key,
        api_key_created_at,
        api_key_last_used_at
      FROM organizations
      WHERE id = $1
    `, [orgId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Organization not found' });
    }
    
    const org = result.rows[0];
    
    res.json({
      success: true,
      has_api_key: org.has_api_key || false,
      api_key_created_at: org.api_key_created_at,
      api_key_last_used_at: org.api_key_last_used_at,
      api_access_enabled: hasApiAccess
    });
    
  } catch (err) {
    console.error('API key status error:', err);
    res.status(500).json({ success: false, error: 'Failed to get API key status' });
  }
});

/**
 * POST /api/api-key/generate - Generate a new API key (Admin only)
 * This will revoke any existing key
 * Returns the raw key ONLY ONCE - it cannot be retrieved later
 */
router.post('/api-key/generate', async (req, res) => {
  try {
    // Check admin role
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: req.t ? req.t('team.messages.noPermission') : 'Permission denied'
      });
    }
    
    const orgId = req.organizationId;
    
    // Check if organization has API access
    const accessResult = await query(`
      SELECT st.api_access, st.name as tier_name
      FROM organizations o
      JOIN subscription_tiers st ON o.subscription_tier_id = st.id
      WHERE o.id = $1
    `, [orgId]);
    
    const hasApiAccess = accessResult.rows[0]?.api_access || false;
    
    if (!hasApiAccess) {
      return res.status(403).json({
        success: false,
        error: req.t ? req.t('api.accessNotEnabled') : 'API access is not available on your current plan',
        tier: accessResult.rows[0]?.tier_name
      });
    }
    
    // Generate a secure API key
    // Format: grf_<64 hex characters> = 32 bytes of randomness
    const randomBytes = crypto.randomBytes(32);
    const rawApiKey = 'grf_' + randomBytes.toString('hex');
    
    // Hash the API key for storage
    const saltRounds = 10;
    const apiKeyHash = await bcrypt.hash(rawApiKey, saltRounds);
    
    // Store the hash
    await query(`
      UPDATE organizations 
      SET api_key_hash = $1, 
          api_key_created_at = NOW(),
          api_key_last_used_at = NULL
      WHERE id = $2
    `, [apiKeyHash, orgId]);
    
    res.json({
      success: true,
      message: req.t ? req.t('api.keyGenerated') : 'API key generated successfully',
      api_key: rawApiKey,
      warning: req.t ? req.t('api.keyWarning') : 'This is your API key. Store it securely - it cannot be retrieved again.'
    });
    
  } catch (err) {
    console.error('API key generation error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate API key' });
  }
});

/**
 * DELETE /api/api-key - Revoke the API key (Admin only)
 */
router.delete('/api-key', async (req, res) => {
  try {
    // Check admin role
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: req.t ? req.t('team.messages.noPermission') : 'Permission denied'
      });
    }
    
    const orgId = req.organizationId;
    
    // Check if there's an API key to revoke
    const checkResult = await query(`
      SELECT api_key_hash IS NOT NULL as has_key FROM organizations WHERE id = $1
    `, [orgId]);
    
    if (!checkResult.rows[0]?.has_key) {
      return res.status(404).json({
        success: false,
        error: req.t ? req.t('api.noKeyToRevoke') : 'No API key to revoke'
      });
    }
    
    // Revoke the key
    await query(`
      UPDATE organizations 
      SET api_key_hash = NULL, 
          api_key_created_at = NULL,
          api_key_last_used_at = NULL
      WHERE id = $1
    `, [orgId]);
    
    res.json({
      success: true,
      message: req.t ? req.t('api.keyRevoked') : 'API key revoked successfully'
    });
    
  } catch (err) {
    console.error('API key revocation error:', err);
    res.status(500).json({ success: false, error: 'Failed to revoke API key' });
  }
});

// ============================================
// FLOORPLANS - Building/venue maps library
// ============================================

/**
 * GET /api/floorplans - Get all floorplans for the organization
 */
router.get('/floorplans', async (req, res) => {
  try {
    const orgId = req.organizationId;
    
    const result = await query(`
      SELECT * FROM floorplans 
      WHERE organization_id = $1 
      ORDER BY created_at DESC
    `, [orgId]);
    
    res.json({
      success: true,
      floorplans: result.rows
    });
  } catch (err) {
    console.error('Floorplans list error:', err);
    res.status(500).json({ success: false, error: 'Failed to get floorplans' });
  }
});

/**
 * GET /api/floorplans/:id - Get a single floorplan
 */
router.get('/floorplans/:id', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const floorplanId = req.params.id;
    
    const result = await query(`
      SELECT * FROM floorplans 
      WHERE id = $1 AND organization_id = $2
    `, [floorplanId, orgId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Floorplan not found' });
    }
    
    res.json({
      success: true,
      floorplan: result.rows[0]
    });
  } catch (err) {
    console.error('Floorplan get error:', err);
    res.status(500).json({ success: false, error: 'Failed to get floorplan' });
  }
});

/**
 * POST /api/floorplans - Upload a new floorplan
 * Uses memory upload first to check for NSFW content before saving to disk
 */
router.post('/floorplans', memoryUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: req.t('errors.no_file_uploaded', 'No file uploaded') });
    }
    
    const orgId = req.organizationId;
    const { name, description } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: req.t('errors.floorplan_name_required', 'Floorplan name is required') });
    }
    
    const file = req.file;

    // Derive the format from the file content: the client chooses mimetype and filename
    const imageType = await detectImageType(file.buffer);
    if (!imageType) {
      return res.status(400).json({ success: false, error: req.t('errors.invalid_image_type', 'This file is not a supported image. Upload a JPG, PNG, GIF or WebP file.'), code: 'INVALID_IMAGE_TYPE' });
    }
    
    // NSFW Check
    // NSFW check. Fails closed: an image that could not be checked is not stored
    const nsfwCheck = await isImageAllowed(file.buffer, `upload${imageType.ext}`);
    if (!nsfwCheck.allowed) {
      return rejectImage(req, res, nsfwCheck.reason);
    }
    
    // NSFW check passed - save to disk
    const ext = imageType.ext;
    const filename = `${crypto.randomUUID()}${ext}`;
    const uploadDir = path.join(__dirname, '../../uploads/organizations', orgId, 'media');
    const filePath = path.join(uploadDir, filename);
    
    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    // Write file to disk
    fs.writeFileSync(filePath, file.buffer);
    
    const url = `/uploads/organizations/${orgId}/media/${filename}`;
    
    // Get image dimensions
    let width = null;
    let height = null;
    
    try {
      const sizeOf = (await import('image-size')).default;
      const dimensions = sizeOf(filePath);
      width = dimensions.width;
      height = dimensions.height;
    } catch (dimErr) {
      console.log('Could not read image dimensions:', dimErr.message);
    }
    
    // Insert into database
    const result = await query(`
      INSERT INTO floorplans (organization_id, name, description, image_url, width, height)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [orgId, name.trim(), description || null, url, width, height]);
    
    res.json({
      success: true,
      floorplan: result.rows[0]
    });
  } catch (err) {
    console.error('Floorplan upload error:', err);
    res.status(500).json({ success: false, error: req.t('errors.upload_failed', 'Failed to upload floorplan') });
  }
});

/**
 * PUT /api/floorplans/:id - Update floorplan details
 */
router.put('/floorplans/:id', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const floorplanId = req.params.id;
    const { name, description } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Floorplan name is required' });
    }
    
    const result = await query(`
      UPDATE floorplans 
      SET name = $1, description = $2, updated_at = NOW()
      WHERE id = $3 AND organization_id = $4
      RETURNING *
    `, [name.trim(), description || null, floorplanId, orgId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Floorplan not found' });
    }
    
    res.json({
      success: true,
      floorplan: result.rows[0]
    });
  } catch (err) {
    console.error('Floorplan update error:', err);
    res.status(500).json({ success: false, error: 'Failed to update floorplan' });
  }
});

/**
 * DELETE /api/floorplans/:id - Delete a floorplan
 */
router.delete('/floorplans/:id', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const floorplanId = req.params.id;
    
    // Get floorplan info first
    const floorplanResult = await query(`
      SELECT * FROM floorplans WHERE id = $1 AND organization_id = $2
    `, [floorplanId, orgId]);
    
    if (floorplanResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Floorplan not found' });
    }
    
    const floorplan = floorplanResult.rows[0];
    
    // Delete file from disk (supports both old and new URL structures)
    const filePath = getMediaFilePath(floorplan.image_url);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // Delete from database
    await query('DELETE FROM floorplans WHERE id = $1', [floorplanId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Floorplan delete error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete floorplan' });
  }
});

// ============================================
// THEMES - Custom journey styling
// ============================================

// Default theme tokens
// Theme tokens end up in a CSS block of the player, so only known keys with
// strictly formatted values are stored; anything else falls back to defaults.
const THEME_COLOR_KEYS = new Set([
  'primary', 'accent', 'background', 'textPrimary', 'textSecondary', 'cardBackground', 'cardBorder',
  'buttonText', 'progressBar', 'chatBubbleGuide', 'chatBubbleUser', 'headerBackground'
]);
const THEME_SHADOWS = new Set(['none', 'light', 'medium', 'strong']);

function sanitizeThemeTokens(tokens) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  const clean = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (THEME_COLOR_KEYS.has(key) && typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value)) {
      clean[key] = value;
    } else if (key === 'borderRadius' && /^\d{1,2}$/.test(String(value)) && Number(value) <= 64) {
      clean[key] = String(value);
    } else if (key === 'shadowStrength' && THEME_SHADOWS.has(value)) {
      clean[key] = value;
    }
  }
  return clean;
}

const defaultThemeTokens = {
  primary: "#0b4b34",
  accent: "#78c503",
  background: "#ecf2eb",
  textPrimary: "#1f2937",
  textSecondary: "#6b7280",
  cardBackground: "#ffffff",
  cardBorder: "#e5e7eb",
  buttonText: "#ffffff",
  headerBackground: "#0b4b34",
  progressBar: "#78c503",
  chatBubbleUser: "#0b4b34",
  chatBubbleGuide: "#f3f4f6",
  borderRadius: "12",
  shadowStrength: "medium"
};

// Preset themes
const presetThemes = [
  {
    key: 'gryffi_default',
    name: 'Gryffi Default',
    tokens: { ...defaultThemeTokens }
  },
  {
    key: 'corporate_blue',
    name: 'Corporate Blue',
    tokens: {
      ...defaultThemeTokens,
      primary: "#1e40af",
      accent: "#3b82f6",
      background: "#f0f5ff",
      headerBackground: "#1e40af",
      progressBar: "#3b82f6",
      chatBubbleUser: "#1e40af"
    }
  },
  {
    key: 'warm_orange',
    name: 'Warm Orange',
    tokens: {
      ...defaultThemeTokens,
      primary: "#c2410c",
      accent: "#f97316",
      background: "#fff7ed",
      headerBackground: "#c2410c",
      progressBar: "#f97316",
      chatBubbleUser: "#c2410c"
    }
  },
  {
    key: 'elegant_purple',
    name: 'Elegant Purple',
    tokens: {
      ...defaultThemeTokens,
      primary: "#6b21a8",
      accent: "#a855f7",
      background: "#faf5ff",
      headerBackground: "#6b21a8",
      progressBar: "#a855f7",
      chatBubbleUser: "#6b21a8"
    }
  }
];

/**
 * GET /api/themes - Get all themes for the organization
 */
router.get('/themes', async (req, res) => {
  try {
    const orgId = req.organizationId;
    
    // Get organization's active theme
    const orgResult = await query(`
      SELECT active_theme_id FROM organizations WHERE id = $1
    `, [orgId]);
    const activeThemeId = orgResult.rows[0]?.active_theme_id;
    
    // Get all custom themes for this organization
    const result = await query(`
      SELECT * FROM themes 
      WHERE organization_id = $1 
      ORDER BY created_at DESC
    `, [orgId]);
    
    res.json({
      success: true,
      themes: result.rows,
      activeThemeId: activeThemeId,
      presets: presetThemes,
      defaultTokens: defaultThemeTokens
    });
  } catch (err) {
    console.error('Themes list error:', err);
    res.status(500).json({ success: false, error: 'Failed to get themes' });
  }
});

/**
 * GET /api/themes/:id - Get a single theme
 */
router.get('/themes/:id', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const themeId = req.params.id;
    
    const result = await query(`
      SELECT * FROM themes 
      WHERE id = $1 AND organization_id = $2
    `, [themeId, orgId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    res.json({
      success: true,
      theme: result.rows[0]
    });
  } catch (err) {
    console.error('Theme get error:', err);
    res.status(500).json({ success: false, error: 'Failed to get theme' });
  }
});

/**
 * POST /api/themes - Create a new theme
 * Uses memory upload first to check for NSFW content before saving to disk
 */
router.post('/themes', memoryUpload.single('logo'), async (req, res) => {
  try {
    const orgId = req.organizationId;
    const { name, description, tokens, preset_key } = req.body;
    if (!(await isFeatureEnabled(orgId, 'custom_branding'))) {
      return res.status(403).json({ success: false, code: 'FEATURE_NOT_IN_PLAN', error: req.t('subscription.limits.upgradeRequired') });
    }
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Theme name is required' });
    }
    
    // Parse tokens if it's a string
    let parsedTokens = tokens;
    if (typeof tokens === 'string') {
      try {
        parsedTokens = JSON.parse(tokens);
      } catch (_e) {
        parsedTokens = defaultThemeTokens;
      }
    }
    parsedTokens = sanitizeThemeTokens(parsedTokens);
    
    // Handle logo upload and generate white version
    let logoUrl = null;
    let logoLightUrl = null;
    
    if (req.file) {
      const file = req.file;

      // Derive the format from the file content: the client chooses mimetype and filename
      const imageType = await detectImageType(file.buffer);
      if (!imageType) {
        return res.status(400).json({ success: false, error: req.t('errors.invalid_image_type', 'This file is not a supported image. Upload a JPG, PNG, GIF or WebP file.'), code: 'INVALID_IMAGE_TYPE' });
      }
      
      // NSFW Check for logo
      // NSFW check. Fails closed: an image that could not be checked is not stored
      const nsfwCheck = await isImageAllowed(file.buffer, `upload${imageType.ext}`);
      if (!nsfwCheck.allowed) {
        return rejectImage(req, res, nsfwCheck.reason);
      }
      
      // NSFW check passed - save to disk
      const ext = imageType.ext;
      const filename = `${crypto.randomUUID()}${ext}`;
      const uploadDir = path.join(__dirname, '../../uploads/organizations', orgId, 'media');
      const filePath = path.join(uploadDir, filename);
      
      // Ensure directory exists
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      
      // Write file to disk
      fs.writeFileSync(filePath, file.buffer);
      
      logoUrl = `/uploads/organizations/${orgId}/media/${filename}`;
      
      // Generate white/light version of the logo for dark backgrounds
      const lightFilename = `${path.basename(filename, ext)}-light.png`;
      const lightPath = path.join(uploadDir, lightFilename);
      
      const success = await generateWhiteLogo(filePath, lightPath);
      if (success) {
        logoLightUrl = `/uploads/organizations/${orgId}/media/${lightFilename}`;
      }
    }
    
    const result = await query(`
      INSERT INTO themes (organization_id, name, description, tokens, logo_url, logo_light_url, preset_key, is_preset)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      orgId, 
      name.trim(), 
      description || null, 
      JSON.stringify(parsedTokens || defaultThemeTokens),
      logoUrl,
      logoLightUrl,
      preset_key || null,
      false
    ]);
    
    res.json({
      success: true,
      theme: result.rows[0]
    });
  } catch (err) {
    console.error('Theme create error:', err);
    res.status(500).json({ success: false, error: 'Failed to create theme' });
  }
});

/**
 * PUT /api/themes/:id - Update a theme
 * Uses memory upload first to check for NSFW content before saving to disk
 */
router.put('/themes/:id', memoryUpload.single('logo'), async (req, res) => {
  try {
    const orgId = req.organizationId;
    const themeId = req.params.id;
    const { name, description, tokens } = req.body;
    if (!(await isFeatureEnabled(orgId, 'custom_branding'))) {
      return res.status(403).json({ success: false, code: 'FEATURE_NOT_IN_PLAN', error: req.t('subscription.limits.upgradeRequired') });
    }
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Theme name is required' });
    }
    
    // Parse tokens if it's a string
    let parsedTokens = tokens;
    if (typeof tokens === 'string') {
      try {
        parsedTokens = JSON.parse(tokens);
      } catch (_e) {
        return res.status(400).json({ success: false, error: 'Invalid tokens format' });
      }
    }
    parsedTokens = sanitizeThemeTokens(parsedTokens);
    if (!parsedTokens) {
      return res.status(400).json({ success: false, error: 'Invalid tokens format' });
    }
    
    // Get current theme to check for existing logos
    const currentTheme = await query(`
      SELECT logo_url, logo_light_url FROM themes WHERE id = $1 AND organization_id = $2
    `, [themeId, orgId]);
    
    if (currentTheme.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    // Handle logo upload and generate white version
    let logoUrl = currentTheme.rows[0].logo_url;
    let logoLightUrl = currentTheme.rows[0].logo_light_url;
    
    if (req.file) {
      const file = req.file;

      // Derive the format from the file content: the client chooses mimetype and filename
      const imageType = await detectImageType(file.buffer);
      if (!imageType) {
        return res.status(400).json({ success: false, error: req.t('errors.invalid_image_type', 'This file is not a supported image. Upload a JPG, PNG, GIF or WebP file.'), code: 'INVALID_IMAGE_TYPE' });
      }
      
      // NSFW Check for logo
      // NSFW check. Fails closed: an image that could not be checked is not stored
      const nsfwCheck = await isImageAllowed(file.buffer, `upload${imageType.ext}`);
      if (!nsfwCheck.allowed) {
        return rejectImage(req, res, nsfwCheck.reason);
      }
      
      // NSFW check passed - delete old logos and save new one
      if (logoUrl) {
        const oldFilePath = getMediaFilePath(logoUrl);
        if (oldFilePath && fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      }
      if (logoLightUrl) {
        const lightPath = getMediaFilePath(logoLightUrl);
        if (lightPath && fs.existsSync(lightPath)) {
          fs.unlinkSync(lightPath);
        }
      }
      
      // Save to disk
      const ext = imageType.ext;
      const filename = `${crypto.randomUUID()}${ext}`;
      const uploadDir = path.join(__dirname, '../../uploads/organizations', orgId, 'media');
      const filePath = path.join(uploadDir, filename);
      
      // Ensure directory exists
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      
      // Write file to disk
      fs.writeFileSync(filePath, file.buffer);
      
      logoUrl = `/uploads/organizations/${orgId}/media/${filename}`;
      
      // Generate white/light version of the logo for dark backgrounds
      const lightFilename = `${path.basename(filename, ext)}-light.png`;
      const lightPath = path.join(uploadDir, lightFilename);
      
      const success = await generateWhiteLogo(filePath, lightPath);
      if (success) {
        logoLightUrl = `/uploads/organizations/${orgId}/media/${lightFilename}`;
      } else {
        logoLightUrl = null;
      }
    }
    
    const result = await query(`
      UPDATE themes 
      SET name = $1, description = $2, tokens = $3, logo_url = $4, logo_light_url = $5, updated_at = NOW()
      WHERE id = $6 AND organization_id = $7
      RETURNING *
    `, [name.trim(), description || null, JSON.stringify(parsedTokens), logoUrl, logoLightUrl, themeId, orgId]);
    
    res.json({
      success: true,
      theme: result.rows[0]
    });
  } catch (err) {
    console.error('Theme update error:', err);
    res.status(500).json({ success: false, error: 'Failed to update theme' });
  }
});

/**
 * DELETE /api/themes/:id - Delete a theme
 */
router.delete('/themes/:id', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const themeId = req.params.id;
    
    // Get theme info first
    const themeResult = await query(`
      SELECT * FROM themes WHERE id = $1 AND organization_id = $2
    `, [themeId, orgId]);
    
    if (themeResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    const theme = themeResult.rows[0];
    
    // Check if this is the active theme
    const orgResult = await query(`
      SELECT active_theme_id FROM organizations WHERE id = $1
    `, [orgId]);
    
    if (orgResult.rows[0]?.active_theme_id === themeId) {
      // Unset active theme
      await query(`
        UPDATE organizations SET active_theme_id = NULL WHERE id = $1
      `, [orgId]);
    }
    
    // Delete logo files if exist (supports both old and new URL structures)
    if (theme.logo_url) {
      const filePath = getMediaFilePath(theme.logo_url);
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    if (theme.logo_light_url) {
      const lightPath = getMediaFilePath(theme.logo_light_url);
      if (lightPath && fs.existsSync(lightPath)) {
        fs.unlinkSync(lightPath);
      }
    }
    
    // Delete from database
    await query('DELETE FROM themes WHERE id = $1', [themeId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Theme delete error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete theme' });
  }
});

/**
 * POST /api/themes/:id/activate - Set a theme as active
 */
router.post('/themes/:id/activate', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const themeId = req.params.id;
    
    // Verify theme exists and belongs to organization
    const themeResult = await query(`
      SELECT id FROM themes WHERE id = $1 AND organization_id = $2
    `, [themeId, orgId]);
    
    if (themeResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    // Set as active theme
    await query(`
      UPDATE organizations SET active_theme_id = $1 WHERE id = $2
    `, [themeId, orgId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Theme activate error:', err);
    res.status(500).json({ success: false, error: 'Failed to activate theme' });
  }
});

/**
 * POST /api/themes/deactivate - Remove active theme (use default)
 */
router.post('/themes/deactivate', async (req, res) => {
  try {
    const orgId = req.organizationId;
    
    await query(`
      UPDATE organizations SET active_theme_id = NULL WHERE id = $1
    `, [orgId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Theme deactivate error:', err);
    res.status(500).json({ success: false, error: 'Failed to deactivate theme' });
  }
});

/**
 * DELETE /api/themes/:id/logo - Remove logo from theme
 */
router.delete('/themes/:id/logo', async (req, res) => {
  try {
    const orgId = req.organizationId;
    const themeId = req.params.id;
    
    // Get current theme (including light logo)
    const themeResult = await query(`
      SELECT logo_url, logo_light_url FROM themes WHERE id = $1 AND organization_id = $2
    `, [themeId, orgId]);
    
    if (themeResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    const { logo_url: logoUrl, logo_light_url: logoLightUrl } = themeResult.rows[0];
    
    // Delete original logo file if exists
    if (logoUrl) {
      const filePath = getMediaFilePath(logoUrl);
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    
    // Delete light logo file if exists
    if (logoLightUrl) {
      const lightFilePath = getMediaFilePath(logoLightUrl);
      if (lightFilePath && fs.existsSync(lightFilePath)) {
        fs.unlinkSync(lightFilePath);
      }
    }
    
    // Update database
    await query(`
      UPDATE themes SET logo_url = NULL, logo_light_url = NULL, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2
    `, [themeId, orgId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Theme logo delete error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete logo' });
  }
});

// ============================================================================
// HELP API ENDPOINTS
// AI-powered help assistant for makers
// ============================================================================

/**
 * POST /api/help/search - Search help documentation and get AI response
 * 
 * Body:
 *   query: string - User's question
 *   context: string - Current UI context (e.g., 'builder', 'settings', 'dashboard')
 *   language: string - Response language (en, nl, de, fr, es)
 */
router.post('/help/search', async (req, res) => {
  try {
    const { query: userQuery, context = '', language = 'en' } = req.body;
    
    if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length < 2) {
      return res.status(400).json({ 
        success: false, 
        error: 'Please provide a search query' 
      });
    }
    
    // Gather maker and organization context for personalized responses
    const user = req.session?.user;
    const org = req.session?.organization;
    let tierInfo = null;
    
    if (org?.id) {
      try {
        tierInfo = await getOrganizationTier(org.id);
      } catch (e) {
        console.warn('[Help API] Could not get tier info:', e.message);
      }
    }
    
    const makerContext = {
      name: user?.fullName || user?.firstName || null,
      role: user?.role || null,
      organization: {
        name: org?.name || null,
        country: org?.country || null,
        tier: tierInfo?.tier ? {
          name: tierInfo.tier.name,
          displayName: tierInfo.tier.displayName
        } : null
      }
    };
    
    // Search relevant documentation
    const relevantDocs = await searchHelp(userQuery.trim(), context, 5);
    
    if (relevantDocs.length === 0) {
      return res.json({
        success: true,
        answer: null,
        noResults: true,
        topics: await getHelpTopics()
      });
    }
    
    // Generate AI response based on docs and maker context
    const response = await generateHelpResponse(
      userQuery.trim(),
      relevantDocs,
      context,
      language,
      makerContext
    );

    res.json({
      success: true,
      answer: response.answer,
      link: response.link,
      source: response.source,
      relatedTopics: relevantDocs.slice(1, 4).map(d => ({
        id: d.id,
        title: d.title
      }))
    });
    
  } catch (err) {
    console.error('[Help API] Search error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to search help' 
    });
  }
});

/**
 * GET /api/help/topics - Get all available help topics
 */
router.get('/help/topics', async (req, res) => {
  try {
    const topics = await getHelpTopics();
    res.json({ success: true, topics });
  } catch (err) {
    console.error('[Help API] Topics error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to load help topics' 
    });
  }
});

/**
 * GET /api/help/topic/:id - Get details for a specific help topic
 */
router.get('/help/topic/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Search for the specific topic
    const docs = await searchHelp(id, '', 1);
    
    if (docs.length === 0 || docs[0].id !== id) {
      return res.status(404).json({
        success: false,
        error: 'Help topic not found'
      });
    }
    
    const doc = docs[0];

    res.json({
      success: true,
      topic: {
        id: doc.id,
        title: doc.title,
        link: doc.links[0] || null,
        relatedFeatures: doc.relatedFeatures
      }
    });
    
  } catch (err) {
    console.error('[Help API] Topic error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to load help topic'
    });
  }
});

// ============================================
// ANALYTICS - Journey Event Tracking
// ============================================

/**
 * GET /api/analytics/events - Get journey events for testing/analysis
 * Query params:
 * - journey_id: Filter by journey
 * - end_user_id: Filter by end user
 * - event_type: Filter by event type
 * - limit: Max results (default 100)
 * - since: ISO date string to filter from
 */
router.get('/analytics/events', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    const { journey_id, end_user_id, event_type, limit = 100, since } = req.query;
    
    // Build query dynamically
    let whereClause = 'je.organization_id = $1';
    const params = [orgId];
    let paramIndex = 2;
    
    if (journey_id) {
      whereClause += ` AND je.journey_id = $${paramIndex++}`;
      params.push(journey_id);
    }
    
    if (end_user_id) {
      whereClause += ` AND je.end_user_id = $${paramIndex++}`;
      params.push(end_user_id);
    }
    
    if (event_type) {
      whereClause += ` AND je.event_type = $${paramIndex++}`;
      params.push(event_type);
    }
    
    if (since) {
      whereClause += ` AND je.created_at >= $${paramIndex++}`;
      params.push(new Date(since));
    }
    
    params.push(Math.min(parseInt(limit) || 100, 1000));
    
    const result = await query(`
      SELECT 
        je.*,
        j.title as journey_title,
        eu.first_name || ' ' || eu.last_name as end_user_name,
        eu.email as end_user_email,
        s.title as step_title,
        s.type as step_type
      FROM journey_events je
      LEFT JOIN journeys j ON je.journey_id = j.id
      LEFT JOIN end_users eu ON je.end_user_id = eu.id
      LEFT JOIN steps s ON je.step_id = s.id
      WHERE ${whereClause}
      ORDER BY je.created_at DESC
      LIMIT $${paramIndex}
    `, params);
    
    // Get summary stats
    const statsResult = await query(`
      SELECT 
        event_type,
        COUNT(*) as count,
        AVG(duration_ms) as avg_duration_ms
      FROM journey_events
      WHERE organization_id = $1
      ${since ? `AND created_at >= $2` : ''}
      GROUP BY event_type
      ORDER BY count DESC
    `, since ? [orgId, new Date(since)] : [orgId]);
    
    res.json({
      success: true,
      events: result.rows,
      stats: statsResult.rows,
      total: result.rows.length
    });
    
  } catch (err) {
    console.error('[Analytics] Events error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to load analytics events'
    });
  }
});

/**
 * GET /api/analytics/summary - Get high-level analytics summary
 * Uses end_user_progress and invitations tables for reliable start/completion data
 */
router.get('/analytics/summary', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    console.log('[Analytics] Summary request - user:', user.email, 'org:', orgId);
    const { journey_id, days = 30 } = req.query;
    
    // Use milliseconds calculation for reliable date math across month boundaries
    const sinceDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
    
    // Build journey filter for queries
    let journeyFilterProgress = '';
    let journeyFilterEvents = '';
    const baseParams = [orgId, sinceDate];
    
    if (journey_id) {
      journeyFilterProgress = 'AND eup.journey_id = $3';
      journeyFilterEvents = 'AND journey_id = $3';
    }
    
    const params = journey_id ? [...baseParams, journey_id] : baseParams;
    
    // Get journey starts and completions from end_user_progress (most reliable source)
    const progressStats = await query(`
      SELECT 
        COUNT(*) as started,
        COUNT(CASE WHEN eup.completed_at IS NOT NULL THEN 1 END) as completed
      FROM end_user_progress eup
      JOIN invitations i ON eup.invitation_id = i.id
      WHERE i.organization_id = $1 
        AND eup.started_at >= $2
        ${journeyFilterProgress}
    `, params);
    
    // Get unique active users from progress
    const uniqueUsers = await query(`
      SELECT COUNT(DISTINCT eup.end_user_id) as count
      FROM end_user_progress eup
      JOIN invitations i ON eup.invitation_id = i.id
      WHERE i.organization_id = $1 
        AND eup.started_at >= $2
        ${journeyFilterProgress}
    `, params);
    
    // Get event counts by type (for detailed breakdown)
    const eventCounts = await query(`
      SELECT event_type, COUNT(*) as count
      FROM journey_events
      WHERE organization_id = $1 AND created_at >= $2 ${journeyFilterEvents}
      GROUP BY event_type
    `, params);
    
    // Get average step duration from events
    const avgDuration = await query(`
      SELECT AVG(duration_ms) as avg_ms
      FROM journey_events
      WHERE organization_id = $1 
        AND created_at >= $2 
        AND event_type = 'step_completed'
        AND duration_ms IS NOT NULL
        ${journeyFilterEvents}
    `, params);
    
    // Get daily trend from end_user_progress (more reliable than events)
    const dailyTrend = await query(`
      SELECT 
        DATE(eup.started_at) as date,
        COUNT(*) as started,
        COUNT(CASE WHEN eup.completed_at IS NOT NULL THEN 1 END) as completed,
        COUNT(DISTINCT eup.end_user_id) as unique_users
      FROM end_user_progress eup
      JOIN invitations i ON eup.invitation_id = i.id
      WHERE i.organization_id = $1 
        AND eup.started_at >= $2
        ${journeyFilterProgress}
      GROUP BY DATE(eup.started_at)
      ORDER BY date
    `, params);
    
    const started = parseInt(progressStats.rows[0]?.started) || 0;
    const completed = parseInt(progressStats.rows[0]?.completed) || 0;
    
    console.log('[Analytics] Summary results - started:', started, 'completed:', completed, 'users:', uniqueUsers.rows[0]?.count);
    
    res.json({
      success: true,
      summary: {
        period_days: parseInt(days),
        total_events: eventCounts.rows.reduce((sum, r) => sum + parseInt(r.count), 0),
        unique_users: parseInt(uniqueUsers.rows[0]?.count) || 0,
        journeys_started: started,
        journeys_completed: completed,
        completion_rate: started > 0 ? Math.round((completed / started) * 100) : 0,
        avg_step_duration_ms: Math.round(parseFloat(avgDuration.rows[0]?.avg_ms) || 0),
        event_breakdown: eventCounts.rows,
        daily_trend: dailyTrend.rows.map(row => ({
          date: row.date,
          started: parseInt(row.started) || 0,
          completed: parseInt(row.completed) || 0,
          unique_users: parseInt(row.unique_users) || 0,
          event_count: parseInt(row.started) || 0 // For backwards compatibility
        }))
      }
    });
    
  } catch (err) {
    console.error('[Analytics] Summary error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to load analytics summary'
    });
  }
});

/**
 * GET /api/analytics/quiz-stats - Get quiz performance statistics
 * Provides detailed quiz analytics per step, user, or journey
 */
router.get('/analytics/quiz-stats', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { journey_id, step_id, end_user_id, days = 30 } = req.query;
    
    // Use milliseconds calculation for reliable date math across month boundaries
    const sinceDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
    
    let whereClause = 'qa.organization_id = $1 AND qa.created_at >= $2';
    const params = [orgId, sinceDate];
    let paramIndex = 3;
    
    if (journey_id) {
      whereClause += ` AND qa.journey_id = $${paramIndex++}`;
      params.push(journey_id);
    }
    if (step_id) {
      whereClause += ` AND qa.step_id = $${paramIndex++}`;
      params.push(step_id);
    }
    if (end_user_id) {
      whereClause += ` AND qa.end_user_id = $${paramIndex++}`;
      params.push(end_user_id);
    }
    
    // Overall quiz stats
    const overallStats = await query(`
      SELECT 
        COUNT(*) as total_attempts,
        COUNT(DISTINCT end_user_id) as unique_users,
        COUNT(DISTINCT COALESCE(end_user_id::text, session_id)) as unique_participants,
        AVG(score_percentage) as avg_score,
        AVG(duration_ms) as avg_duration_ms,
        SUM(CASE WHEN passed THEN 1 ELSE 0 END) as passed_count,
        ROUND(SUM(CASE WHEN passed THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100) as pass_rate
      FROM quiz_attempts qa
      WHERE ${whereClause}
    `, params);
    
    // Stats per quiz step
    const perStepStats = await query(`
      SELECT 
        qa.step_id,
        s.title as step_title,
        COUNT(*) as attempts,
        AVG(qa.score_percentage) as avg_score,
        SUM(CASE WHEN qa.passed THEN 1 ELSE 0 END) as passed,
        AVG(qa.duration_ms) as avg_duration_ms
      FROM quiz_attempts qa
      LEFT JOIN steps s ON qa.step_id = s.id
      WHERE ${whereClause}
      GROUP BY qa.step_id, s.title
      ORDER BY attempts DESC
    `, params);
    
    // Score distribution
    const scoreDistribution = await query(`
      SELECT 
        CASE 
          WHEN score_percentage >= 90 THEN '90-100%'
          WHEN score_percentage >= 70 THEN '70-89%'
          WHEN score_percentage >= 50 THEN '50-69%'
          ELSE '0-49%'
        END as score_range,
        COUNT(*) as count
      FROM quiz_attempts qa
      WHERE ${whereClause}
      GROUP BY score_range
      ORDER BY score_range DESC
    `, params);
    
    // Recent attempts (with user info if available)
    const recentAttempts = await query(`
      SELECT 
        qa.*,
        eu.first_name || ' ' || eu.last_name as user_name,
        eu.email as user_email,
        s.title as step_title
      FROM quiz_attempts qa
      LEFT JOIN end_users eu ON qa.end_user_id = eu.id
      LEFT JOIN steps s ON qa.step_id = s.id
      WHERE ${whereClause}
      ORDER BY qa.created_at DESC
      LIMIT 50
    `, params);
    
    const overall = overallStats.rows[0] || {};
    res.json({
      success: true,
      stats: {
        total_attempts: parseInt(overall.total_attempts) || 0,
        unique_users: parseInt(overall.unique_users) || 0,
        avg_score: parseFloat(overall.avg_score) || 0,
        avg_duration_ms: parseFloat(overall.avg_duration_ms) || 0,
        passed_count: parseInt(overall.passed_count) || 0,
        pass_rate: parseFloat(overall.pass_rate) || 0,
        per_step: perStepStats.rows,
        score_distribution: scoreDistribution.rows,
        recent_attempts: recentAttempts.rows
      },
      // For PDF reports
      distribution: scoreDistribution.rows,
      topQuizzes: perStepStats.rows.slice(0, 5)
    });
    
  } catch (err) {
    console.error('[Analytics] Quiz stats error:', err);
    res.status(500).json({ success: false, error: 'Failed to load quiz statistics' });
  }
});

/**
 * GET /api/analytics/video-stats - Get video engagement statistics
 */
router.get('/analytics/video-stats', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { journey_id, step_id, days = 30 } = req.query;
    
    // Use milliseconds calculation for reliable date math across month boundaries
    const sinceDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
    
    let whereClause = 'vw.organization_id = $1 AND vw.created_at >= $2';
    const params = [orgId, sinceDate];
    let paramIndex = 3;
    
    if (journey_id) {
      whereClause += ` AND vw.journey_id = $${paramIndex++}`;
      params.push(journey_id);
    }
    if (step_id) {
      whereClause += ` AND vw.step_id = $${paramIndex++}`;
      params.push(step_id);
    }
    
    // Overall video stats
    const overallStats = await query(`
      SELECT 
        COUNT(*) as total_sessions,
        COUNT(DISTINCT COALESCE(end_user_id::text, session_id)) as unique_viewers,
        AVG(watch_percentage) as avg_watch_percentage,
        SUM(watch_time_sec) as total_watch_time_sec,
        SUM(CASE WHEN completed THEN 1 ELSE 0 END) as completed_count,
        ROUND(SUM(CASE WHEN completed THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100) as completion_rate,
        AVG(pause_count) as avg_pause_count,
        AVG(seek_count) as avg_seek_count
      FROM video_watch_sessions vw
      WHERE ${whereClause}
    `, params);
    
    // Stats per video step
    const perStepStats = await query(`
      SELECT 
        vw.step_id,
        s.title as step_title,
        COUNT(*) as views,
        AVG(vw.watch_percentage) as avg_watch_percentage,
        SUM(CASE WHEN vw.completed THEN 1 ELSE 0 END) as completed,
        AVG(vw.video_duration_sec) as avg_video_duration_sec
      FROM video_watch_sessions vw
      LEFT JOIN steps s ON vw.step_id = s.id
      WHERE ${whereClause}
      GROUP BY vw.step_id, s.title
      ORDER BY views DESC
    `, params);
    
    // Watch percentage distribution
    const watchDistribution = await query(`
      SELECT 
        CASE 
          WHEN watch_percentage >= 90 THEN '90-100%'
          WHEN watch_percentage >= 75 THEN '75-89%'
          WHEN watch_percentage >= 50 THEN '50-74%'
          WHEN watch_percentage >= 25 THEN '25-49%'
          ELSE '0-24%'
        END as watch_range,
        COUNT(*) as count
      FROM video_watch_sessions vw
      WHERE ${whereClause}
      GROUP BY watch_range
      ORDER BY watch_range DESC
    `, params);
    
    const overall = overallStats.rows[0] || {};
    res.json({
      success: true,
      stats: {
        total_sessions: parseInt(overall.total_sessions) || 0,
        unique_viewers: parseInt(overall.unique_viewers) || 0,
        avg_watch_percentage: parseFloat(overall.avg_watch_percentage) || 0,
        total_watch_time_ms: (parseInt(overall.total_watch_time_sec) || 0) * 1000,
        completed_count: parseInt(overall.completed_count) || 0,
        completion_rate: parseFloat(overall.completion_rate) || 0,
        per_step: perStepStats.rows,
        watch_distribution: watchDistribution.rows
      },
      // For PDF reports
      topVideos: perStepStats.rows.slice(0, 5)
    });
    
  } catch (err) {
    console.error('[Analytics] Video stats error:', err);
    res.status(500).json({ success: false, error: 'Failed to load video statistics' });
  }
});

/**
 * GET /api/analytics/user/:userId - Get analytics for a specific end user
 * Shows journey progress, quiz scores, video engagement for one user
 */
router.get('/analytics/user/:userId', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { userId } = req.params;
    const { journey_id } = req.query;
    
    // Verify user belongs to this organization
    const endUserResult = await query(`
      SELECT eu.*, 
             (SELECT COALESCE(json_agg(json_build_object('id', g.id, 'name', g.name)), '[]'::json)
              FROM end_user_groups g 
              JOIN end_user_group_members gm ON g.id = gm.group_id 
              WHERE gm.end_user_id = eu.id) as groups
      FROM end_users eu
      WHERE eu.id = $1 AND eu.organization_id = $2
    `, [userId, orgId]);
    
    if (endUserResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const endUser = endUserResult.rows[0];
    const params = [userId, orgId];
    
    // Optional journey filter, qualified per query (the queries join other tables)
    const journeyFilter = (alias) => (journey_id ? `AND ${alias}.journey_id = $3` : '');
    if (journey_id) {
      params.push(journey_id);
    }
    
    // Journey activity summary
    const journeyActivity = await query(`
      SELECT 
        je.journey_id,
        j.title as journey_title,
        MIN(je.created_at) as first_activity,
        MAX(je.created_at) as last_activity,
        COUNT(*) as total_events,
        COUNT(CASE WHEN je.event_type = 'step_completed' THEN 1 END) as steps_completed,
        COUNT(CASE WHEN je.event_type = 'journey_completed' THEN 1 END) as completions
      FROM journey_events je
      JOIN journeys j ON je.journey_id = j.id
      WHERE je.end_user_id = $1 AND je.organization_id = $2 ${journeyFilter('je')}
      GROUP BY je.journey_id, j.title
      ORDER BY last_activity DESC
    `, params);
    
    // Quiz performance
    const quizPerformance = await query(`
      SELECT 
        qa.step_id,
        s.title as step_title,
        j.title as journey_title,
        COUNT(*) as attempts,
        MAX(qa.score_percentage) as best_score,
        AVG(qa.score_percentage) as avg_score,
        SUM(CASE WHEN qa.passed THEN 1 ELSE 0 END) as passed_count,
        AVG(qa.duration_ms) as avg_duration_ms
      FROM quiz_attempts qa
      JOIN steps s ON qa.step_id = s.id
      JOIN journeys j ON qa.journey_id = j.id
      WHERE qa.end_user_id = $1 AND qa.organization_id = $2 ${journeyFilter('qa')}
      GROUP BY qa.step_id, s.title, j.title
      ORDER BY MAX(qa.created_at) DESC
    `, params);
    
    // Video engagement
    const videoEngagement = await query(`
      SELECT 
        vw.step_id,
        s.title as step_title,
        COUNT(*) as watch_sessions,
        MAX(vw.watch_percentage) as max_watch_percentage,
        SUM(vw.watch_time_sec) as total_watch_time_sec,
        SUM(CASE WHEN vw.completed THEN 1 ELSE 0 END) as completed_count
      FROM video_watch_sessions vw
      JOIN steps s ON vw.step_id = s.id
      WHERE vw.end_user_id = $1 AND vw.organization_id = $2 ${journeyFilter('vw')}
      GROUP BY vw.step_id, s.title
    `, params);
    
    // Time spent per step (from journey_events)
    const stepTiming = await query(`
      SELECT 
        je.step_id,
        s.title as step_title,
        s.type as step_type,
        AVG(je.duration_ms) as avg_duration_ms,
        COUNT(*) as visit_count
      FROM journey_events je
      JOIN steps s ON je.step_id = s.id
      WHERE je.end_user_id = $1 
        AND je.organization_id = $2 
        AND je.event_type = 'step_completed'
        AND je.duration_ms IS NOT NULL
        ${journeyFilter('je')}
      GROUP BY je.step_id, s.title, s.type
      ORDER BY avg_duration_ms DESC
    `, params);
    
    // Calculate journey stats for PDF reports
    const totalJourneys = journeyActivity.rows.length;
    const completedJourneys = journeyActivity.rows.filter(j => j.completions > 0).length;
    const completionRate = totalJourneys > 0 ? Math.round((completedJourneys / totalJourneys) * 100) : 0;
    
    // Calculate quiz stats
    const totalQuizAttempts = quizPerformance.rows.reduce((sum, q) => sum + parseInt(q.attempts || 0), 0);
    const totalPassed = quizPerformance.rows.reduce((sum, q) => sum + parseInt(q.passed_count || 0), 0);
    const avgQuizScore = quizPerformance.rows.length > 0 
      ? quizPerformance.rows.reduce((sum, q) => sum + parseFloat(q.avg_score || 0), 0) / quizPerformance.rows.length 
      : 0;
    const bestQuizScore = quizPerformance.rows.length > 0 
      ? Math.max(...quizPerformance.rows.map(q => parseFloat(q.best_score || 0))) 
      : 0;
    const quizPassRate = totalQuizAttempts > 0 ? Math.round((totalPassed / totalQuizAttempts) * 100) : 0;
    
    // Calculate video stats
    const totalVideos = videoEngagement.rows.length;
    const avgWatchPercentage = totalVideos > 0 
      ? videoEngagement.rows.reduce((sum, v) => sum + parseFloat(v.max_watch_percentage || 0), 0) / totalVideos 
      : 0;
    const totalWatchTimeSec = videoEngagement.rows.reduce((sum, v) => sum + parseInt(v.total_watch_time_sec || 0), 0);
    
    // Build journeys array for table
    const journeys = journeyActivity.rows.map(j => ({
      title: j.journey_title,
      completed: j.completions > 0,
      completed_at: j.last_activity,
      score: null // Would need quiz data per journey
    }));
    
    res.json({
      success: true,
      user: {
        id: endUser.id,
        first_name: endUser.first_name,
        last_name: endUser.last_name,
        name: `${endUser.first_name || ''} ${endUser.last_name || ''}`.trim() || 'Anonymous',
        email: endUser.email,
        groups: endUser.groups || [],
        created_at: endUser.created_at,
        journey_stats: {
          total_journeys: totalJourneys,
          completed_journeys: completedJourneys,
          completion_rate: completionRate,
          avg_score: avgQuizScore
        },
        journeys: journeys,
        quiz_stats: {
          total_attempts: totalQuizAttempts,
          avg_score: avgQuizScore,
          pass_rate: quizPassRate,
          best_score: bestQuizScore
        },
        video_stats: {
          total_videos: totalVideos,
          avg_watch_percentage: avgWatchPercentage,
          total_watch_time_ms: totalWatchTimeSec * 1000
        }
      },
      // Keep analytics for other uses
      analytics: {
        journey_activity: journeyActivity.rows,
        quiz_performance: quizPerformance.rows,
        video_engagement: videoEngagement.rows,
        step_timing: stepTiming.rows
      },
      // Backwards compatibility for preview
      journeyStats: {
        started: totalJourneys,
        completed: completedJourneys
      },
      quizStats: {
        total_attempts: totalQuizAttempts,
        average_score: avgQuizScore,
        pass_rate: quizPassRate
      }
    });
    
  } catch (err) {
    console.error('[Analytics] User analytics error:', err);
    res.status(500).json({ success: false, error: 'Failed to load user analytics' });
  }
});

/**
 * GET /api/analytics/user/:userId/journey/:journeyId/replay - Journey Replay Timeline
 * Detailed step-by-step timeline showing all user interactions within a journey
 */
router.get('/analytics/user/:userId/journey/:journeyId/replay', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { userId, journeyId } = req.params;
    
    // Verify user and journey belong to organization
    const endUserResult = await query(`
      SELECT eu.id, eu.first_name, eu.last_name, eu.email
      FROM end_users eu
      WHERE eu.id = $1 AND eu.organization_id = $2
    `, [userId, orgId]);
    
    if (endUserResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    const journeyResult = await query(`
      SELECT j.id, j.title, j.settings
      FROM journeys j
      WHERE j.id = $1 AND j.organization_id = $2
    `, [journeyId, orgId]);
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const endUser = endUserResult.rows[0];
    const journey = journeyResult.rows[0];
    
    // Get all journey events for this user/journey, ordered chronologically
    const eventsResult = await query(`
      SELECT 
        je.id,
        je.event_type,
        je.step_id,
        je.duration_ms,
        je.event_data,
        je.created_at,
        s.title as step_title,
        s.type as step_type
      FROM journey_events je
      LEFT JOIN steps s ON je.step_id = s.id
      WHERE je.end_user_id = $1 AND je.journey_id = $2 AND je.organization_id = $3
      ORDER BY je.created_at ASC
    `, [userId, journeyId, orgId]);
    
    // Get quiz attempts with details
    const quizAttempts = await query(`
      SELECT 
        qa.id,
        qa.step_id,
        qa.total_questions,
        qa.correct_count,
        qa.score_percentage,
        qa.passed,
        qa.duration_ms,
        qa.question_results,
        qa.created_at,
        s.title as step_title
      FROM quiz_attempts qa
      JOIN steps s ON qa.step_id = s.id
      WHERE qa.end_user_id = $1 AND qa.journey_id = $2 AND qa.organization_id = $3
      ORDER BY qa.created_at ASC
    `, [userId, journeyId, orgId]);
    
    // Get form submissions
    const formSubmissions = await query(`
      SELECT 
        fa.id,
        fa.step_id,
        fa.total_fields,
        fa.filled_fields,
        fa.duration_ms,
        fa.completed_at,
        fa.created_at,
        s.title as step_title
      FROM form_analytics fa
      JOIN steps s ON fa.step_id = s.id
      WHERE fa.end_user_id = $1 AND fa.journey_id = $2 AND fa.organization_id = $3
      ORDER BY fa.created_at ASC
    `, [userId, journeyId, orgId]);
    
    // Get AI Guide chat sessions
    const chatSessions = await query(`
      SELECT 
        gcs.id,
        gcs.guide_id,
        gcs.message_count,
        gcs.user_message_count,
        gcs.guide_response_count,
        gcs.total_duration_ms,
        gcs.steps_used,
        gcs.created_at,
        gcs.last_message_at,
        g.name as guide_name
      FROM guide_chat_sessions gcs
      LEFT JOIN guides g ON gcs.guide_id = g.id
      WHERE gcs.end_user_id = $1 AND gcs.journey_id = $2 AND gcs.organization_id = $3
      ORDER BY gcs.created_at ASC
    `, [userId, journeyId, orgId]);
    
    // Get video watch sessions
    const videoSessions = await query(`
      SELECT 
        vws.id,
        vws.step_id,
        vws.video_url,
        vws.video_duration_sec,
        vws.watch_time_sec,
        vws.watch_percentage,
        vws.completed,
        vws.created_at,
        s.title as step_title
      FROM video_watch_sessions vws
      JOIN steps s ON vws.step_id = s.id
      WHERE vws.end_user_id = $1 AND vws.journey_id = $2 AND vws.organization_id = $3
      ORDER BY vws.created_at ASC
    `, [userId, journeyId, orgId]);
    
    // Get poll votes
    const pollVotes = await query(`
      SELECT 
        je.step_id,
        je.event_data,
        je.created_at,
        s.title as step_title
      FROM journey_events je
      JOIN steps s ON je.step_id = s.id
      WHERE je.end_user_id = $1 
        AND je.journey_id = $2 
        AND je.organization_id = $3
        AND je.event_type = 'poll_voted'
      ORDER BY je.created_at ASC
    `, [userId, journeyId, orgId]);
    
    // Build step-by-step timeline
    const stepMap = new Map();
    
    // Process events to build step timeline
    for (const event of eventsResult.rows) {
      if (!event.step_id) continue;
      
      if (!stepMap.has(event.step_id)) {
        stepMap.set(event.step_id, {
          step_id: event.step_id,
          step_title: event.step_title,
          step_type: event.step_type,
          entered_at: null,
          completed_at: null,
          duration_ms: null,
          events: [],
          quiz: null,
          form: null,
          video: null,
          poll: null,
          ai_chat: null
        });
      }
      
      const step = stepMap.get(event.step_id);
      step.events.push({
        type: event.event_type,
        timestamp: event.created_at,
        data: event.event_data
      });
      
      if (event.event_type === 'step_entered' && !step.entered_at) {
        step.entered_at = event.created_at;
      }
      if (event.event_type === 'step_completed') {
        step.completed_at = event.created_at;
        step.duration_ms = event.duration_ms;
      }
    }
    
    // Add quiz data
    for (const quiz of quizAttempts.rows) {
      const step = stepMap.get(quiz.step_id);
      if (step) {
        step.quiz = {
          total_questions: quiz.total_questions,
          correct_count: quiz.correct_count,
          score_percentage: quiz.score_percentage,
          passed: quiz.passed,
          duration_ms: quiz.duration_ms,
          question_results: quiz.question_results,
          timestamp: quiz.created_at
        };
      }
    }
    
    // Add form data
    for (const form of formSubmissions.rows) {
      const step = stepMap.get(form.step_id);
      if (step) {
        step.form = {
          total_fields: form.total_fields,
          fields_filled: form.filled_fields,
          completion_time_ms: form.duration_ms,
          submitted: !!form.completed_at,
          timestamp: form.created_at
        };
      }
    }
    
    // Add video data
    for (const video of videoSessions.rows) {
      const step = stepMap.get(video.step_id);
      if (step) {
        step.video = {
          duration_sec: video.video_duration_sec,
          watch_time_sec: video.watch_time_sec,
          watch_percentage: video.watch_percentage,
          completed: video.completed,
          timestamp: video.created_at
        };
      }
    }
    
    // Add poll data
    for (const poll of pollVotes.rows) {
      const step = stepMap.get(poll.step_id);
      if (step) {
        step.poll = {
          voted: true,
          options_selected: poll.event_data?.options_selected || [],
          timestamp: poll.created_at
        };
      }
    }
    
    // Add AI chat data (associate with steps where chat was used)
    for (const chat of chatSessions.rows) {
      const stepsUsed = chat.steps_used || [];
      for (const stepInfo of stepsUsed) {
        const step = stepMap.get(stepInfo.step_id);
        if (step) {
          if (!step.ai_chat) {
            step.ai_chat = {
              sessions: [],
              total_messages: 0,
              total_duration_ms: 0
            };
          }
          step.ai_chat.sessions.push({
            guide_name: chat.guide_name,
            message_count: chat.message_count,
            user_questions: chat.user_message_count,
            duration_ms: chat.total_duration_ms,
            timestamp: chat.created_at
          });
          step.ai_chat.total_messages += chat.message_count || 0;
          step.ai_chat.total_duration_ms += chat.total_duration_ms || 0;
        }
      }
    }
    
    // Convert to array and sort by entered_at
    const timeline = Array.from(stepMap.values())
      .filter(s => s.entered_at)
      .sort((a, b) => new Date(a.entered_at) - new Date(b.entered_at));
    
    // Calculate journey totals
    const journeyStarted = eventsResult.rows.find(e => e.event_type === 'journey_started');
    const journeyCompleted = eventsResult.rows.find(e => e.event_type === 'journey_completed');
    const totalDuration = timeline.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
    const maxStepDuration = Math.max(...timeline.map(s => s.duration_ms || 0));
    
    res.json({
      success: true,
      user: {
        id: endUser.id,
        name: `${endUser.first_name || ''} ${endUser.last_name || ''}`.trim() || 'Anonymous',
        email: endUser.email
      },
      journey: {
        id: journey.id,
        title: journey.title
      },
      summary: {
        started_at: journeyStarted?.created_at,
        completed_at: journeyCompleted?.created_at,
        is_completed: !!journeyCompleted,
        total_steps: timeline.length,
        total_duration_ms: totalDuration,
        max_step_duration_ms: maxStepDuration,
        quiz_attempts: quizAttempts.rows.length,
        // A form_analytics row is only written when a form is submitted
        forms_submitted: formSubmissions.rows.length,
        chat_sessions: chatSessions.rows.length,
        videos_watched: videoSessions.rows.length,
        polls_voted: pollVotes.rows.length
      },
      timeline,
      raw_chat_sessions: chatSessions.rows
    });
    
  } catch (err) {
    console.error('[Analytics] Journey replay error:', err);
    res.status(500).json({ success: false, error: 'Failed to load journey replay' });
  }
});

/**
 * GET /api/analytics/group/:groupId - Get analytics for a user group
 * Aggregated analytics for all users in a group
 */
router.get('/analytics/group/:groupId', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { groupId } = req.params;
    const { journey_id, days = 30 } = req.query;
    
    // Use milliseconds calculation for reliable date math across month boundaries
    const sinceDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
    
    // Verify group belongs to this organization
    const groupResult = await query(`
      SELECT * FROM end_user_groups WHERE id = $1 AND organization_id = $2
    `, [groupId, orgId]);
    
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }
    
    const group = groupResult.rows[0];
    
    if (journey_id && !isUuid(journey_id)) {
      return res.status(400).json({ success: false, error: 'Invalid journey ID' });
    }
    const journeyFilterId = journey_id || null;

    // Get all users in this group (membership lives in end_user_group_members)
    const groupUsers = await query(`
      SELECT m.end_user_id AS id
      FROM end_user_group_members m
      JOIN end_users eu ON eu.id = m.end_user_id AND eu.organization_id = $2
      WHERE m.group_id = $1
    `, [groupId, orgId]);
    
    const userIds = groupUsers.rows.map(u => u.id);
    
    if (userIds.length === 0) {
      return res.json({
        success: true,
        group: { id: group.id, name: group.name },
        analytics: { message: 'No users in this group' }
      });
    }
    
    // Group summary
    const groupSummary = await query(`
      SELECT 
        COUNT(DISTINCT je.end_user_id) as active_users,
        COUNT(CASE WHEN je.event_type = 'journey_started' THEN 1 END) as journeys_started,
        COUNT(CASE WHEN je.event_type = 'journey_completed' THEN 1 END) as journeys_completed,
        COUNT(CASE WHEN je.event_type = 'step_completed' THEN 1 END) as steps_completed,
        AVG(CASE WHEN je.event_type = 'step_completed' AND je.duration_ms IS NOT NULL THEN je.duration_ms END) as avg_step_duration_ms
      FROM journey_events je
      WHERE je.end_user_id = ANY($1)
        AND je.created_at >= $2
        AND ($3::uuid IS NULL OR je.journey_id = $3)
    `, [userIds, sinceDate, journeyFilterId]);
    
    // Quiz performance for group
    const groupQuizStats = await query(`
      SELECT 
        AVG(score_percentage) as avg_score,
        SUM(CASE WHEN passed THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100 as pass_rate,
        COUNT(*) as total_attempts,
        COUNT(DISTINCT end_user_id) as users_attempted
      FROM quiz_attempts
      WHERE end_user_id = ANY($1)
        AND created_at >= $2
        AND ($3::uuid IS NULL OR journey_id = $3)
    `, [userIds, sinceDate, journeyFilterId]);
    
    // Video engagement for group
    const groupVideoStats = await query(`
      SELECT 
        AVG(watch_percentage) as avg_watch_percentage,
        SUM(CASE WHEN completed THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100 as completion_rate,
        SUM(watch_time_sec) as total_watch_time_sec,
        COUNT(DISTINCT end_user_id) as users_watched
      FROM video_watch_sessions
      WHERE end_user_id = ANY($1)
        AND created_at >= $2
        AND ($3::uuid IS NULL OR journey_id = $3)
    `, [userIds, sinceDate, journeyFilterId]);
    
    // Per-user summary for leaderboard
    const userLeaderboard = await query(`
      SELECT 
        eu.id,
        eu.first_name || ' ' || eu.last_name as name,
        eu.email,
        COUNT(CASE WHEN je.event_type = 'journey_completed' THEN 1 END) as completions,
        COUNT(CASE WHEN je.event_type = 'step_completed' THEN 1 END) as steps_completed,
        MAX(je.created_at) as last_activity
      FROM end_users eu
      LEFT JOIN journey_events je ON eu.id = je.end_user_id AND je.created_at >= $2
        AND ($3::uuid IS NULL OR je.journey_id = $3)
      WHERE eu.id = ANY($1)
      GROUP BY eu.id, eu.first_name, eu.last_name, eu.email
      ORDER BY completions DESC, steps_completed DESC
      LIMIT 20
    `, [userIds, sinceDate, journeyFilterId]);
    
    res.json({
      success: true,
      group: {
        id: group.id,
        name: group.name,
        total_users: userIds.length
      },
      analytics: {
        summary: groupSummary.rows[0],
        quiz_stats: groupQuizStats.rows[0],
        video_stats: groupVideoStats.rows[0],
        user_leaderboard: userLeaderboard.rows
      }
    });
    
  } catch (err) {
    console.error('[Analytics] Group analytics error:', err);
    res.status(500).json({ success: false, error: 'Failed to load group analytics' });
  }
});

/**
 * GET /api/analytics/guide-chat-stats - Get AI Guide usage statistics
 * Shows which guides are used, from which steps, and how much
 */
router.get('/analytics/guide-chat-stats', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { journey_id, guide_id, days = 30 } = req.query;
    if ((journey_id && !isUuid(journey_id)) || (guide_id && !isUuid(guide_id))) {
      return res.status(400).json({ success: false, error: 'Invalid ID' });
    }
    
    // Use milliseconds calculation for reliable date math across month boundaries
    const sinceDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
    
    let whereClause = 'organization_id = $1 AND created_at >= $2';
    const params = [orgId, sinceDate];
    let paramIndex = 3;
    
    if (journey_id) {
      whereClause += ` AND journey_id = $${paramIndex++}`;
      params.push(journey_id);
    }
    if (guide_id) {
      whereClause += ` AND guide_id = $${paramIndex++}`;
      params.push(guide_id);
    }
    
    // Overall guide chat stats
    const overallStats = await query(`
      SELECT 
        COUNT(*) as total_sessions,
        COUNT(DISTINCT COALESCE(end_user_id::text, session_id)) as unique_users,
        SUM(message_count) as total_messages,
        SUM(user_message_count) as total_user_questions,
        AVG(message_count) as avg_messages_per_session,
        AVG(total_duration_ms) as avg_session_duration_ms,
        SUM(total_duration_ms) as total_chat_time_ms
      FROM guide_chat_sessions
      WHERE ${whereClause}
    `, params);
    
    // Stats per guide
    const perGuideStats = await query(`
      SELECT 
        gcs.guide_id,
        g.name as guide_name,
        COUNT(*) as sessions,
        SUM(gcs.message_count) as total_messages,
        SUM(gcs.user_message_count) as user_questions,
        AVG(gcs.total_duration_ms) as avg_duration_ms,
        COUNT(DISTINCT COALESCE(gcs.end_user_id::text, gcs.session_id)) as unique_users
      FROM guide_chat_sessions gcs
      LEFT JOIN guides g ON gcs.guide_id = g.id
      WHERE ${whereClause.replace('organization_id', 'gcs.organization_id').replace('created_at', 'gcs.created_at')}
      GROUP BY gcs.guide_id, g.name
      ORDER BY sessions DESC
    `, params);
    
    // Most common steps where users ask questions (from steps_used JSONB)
    const topStepsForQuestions = await query(`
      SELECT 
        step_data->>'step_id' as step_id,
        step_data->>'step_title' as step_title,
        step_data->>'step_type' as step_type,
        COUNT(*) as question_count
      FROM guide_chat_sessions gcs,
           jsonb_array_elements(gcs.steps_used) AS step_data
      WHERE gcs.organization_id = $1 
        AND gcs.created_at >= $2
        AND ($3::uuid IS NULL OR gcs.journey_id = $3)
      GROUP BY step_data->>'step_id', step_data->>'step_title', step_data->>'step_type'
      ORDER BY question_count DESC
      LIMIT 10
    `, [orgId, sinceDate, journey_id || null]);
    
    // Recent sessions with details
    const recentSessions = await query(`
      SELECT 
        gcs.*,
        g.name as guide_name,
        eu.first_name || ' ' || eu.last_name as user_name,
        eu.email as user_email,
        j.title as journey_title
      FROM guide_chat_sessions gcs
      LEFT JOIN guides g ON gcs.guide_id = g.id
      LEFT JOIN end_users eu ON gcs.end_user_id = eu.id
      LEFT JOIN journeys j ON gcs.journey_id = j.id
      WHERE ${whereClause.replace('organization_id', 'gcs.organization_id').replace('created_at', 'gcs.created_at')}
      ORDER BY gcs.last_message_at DESC
      LIMIT 20
    `, params);
    
    // Daily trend
    const dailyTrend = await query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as sessions,
        SUM(message_count) as messages,
        SUM(user_message_count) as questions
      FROM guide_chat_sessions
      WHERE ${whereClause}
      GROUP BY DATE(created_at)
      ORDER BY date
    `, params);
    
    const overall = overallStats.rows[0] || {};
    res.json({
      success: true,
      stats: {
        total_sessions: parseInt(overall.total_sessions) || 0,
        unique_users: parseInt(overall.unique_users) || 0,
        total_messages: parseInt(overall.total_messages) || 0,
        total_user_questions: parseInt(overall.total_user_questions) || 0,
        avg_messages_per_session: parseFloat(overall.avg_messages_per_session) || 0,
        avg_duration_ms: parseFloat(overall.avg_session_duration_ms) || 0,
        total_chat_time_ms: parseInt(overall.total_chat_time_ms) || 0,
        per_guide: perGuideStats.rows,
        top_steps_for_questions: topStepsForQuestions.rows,
        recent_sessions: recentSessions.rows,
        daily_trend: dailyTrend.rows
      },
      // For PDF reports - convert to expected format
      topSteps: topStepsForQuestions.rows.map(s => ({
        step_title: s.step_title,
        sessions: parseInt(s.question_count) || 0
      }))
    });
    
  } catch (err) {
    console.error('[Analytics] Guide chat stats error:', err);
    res.status(500).json({ success: false, error: 'Failed to load guide chat statistics' });
  }
});

/**
 * GET /api/analytics/journey-funnel/:journeyId - Get step-by-step funnel data for a journey
 * Shows user progression through each step with drop-off rates
 */
router.get('/analytics/journey-funnel/:journeyId', async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { journeyId } = req.params;
    const { days = 30 } = req.query;
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    
    const orgId = req.session.organization?.id;
    if (!orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    console.log('[Analytics] Journey funnel request - journeyId:', journeyId, 'org:', orgId);
    
    // Get journey info and steps
    const journeyResult = await query(`
      SELECT j.id, j.title, j.status,
             (SELECT COUNT(*) FROM steps WHERE journey_id = j.id) as total_steps
      FROM journeys j
      WHERE j.id = $1 AND j.organization_id = $2
    `, [journeyId, orgId]);
    
    console.log('[Analytics] Journey result rows:', journeyResult.rows.length);
    
    if (journeyResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Journey not found' });
    }
    
    const journey = journeyResult.rows[0];
    
    // Get overall journey stats
    const overallStats = await query(`
      SELECT 
        COUNT(DISTINCT CASE WHEN event_type = 'journey_started' THEN COALESCE(end_user_id::text, session_id) END) as started,
        COUNT(DISTINCT CASE WHEN event_type = 'journey_completed' THEN COALESCE(end_user_id::text, session_id) END) as completed
      FROM journey_events
      WHERE journey_id = $1 AND organization_id = $2 AND created_at >= $3
    `, [journeyId, orgId, sinceDate]);
    
    const started = parseInt(overallStats.rows[0].started) || 0;
    const completed = parseInt(overallStats.rows[0].completed) || 0;
    const completionRate = started > 0 ? Math.round((completed / started) * 100) : 0;
    
    // Get per-step funnel data, ordered by average time users reach each step
    const funnelData = await query(`
      SELECT 
        je.step_id,
        s.title as step_title,
        s.type as step_type,
        s.is_start,
        COUNT(DISTINCT CASE WHEN je.event_type = 'step_entered' THEN COALESCE(je.end_user_id::text, je.session_id) END) as users_reached,
        COUNT(DISTINCT CASE WHEN je.event_type = 'step_completed' THEN COALESCE(je.end_user_id::text, je.session_id) END) as users_completed,
        AVG(CASE WHEN je.event_type = 'step_completed' AND je.duration_ms IS NOT NULL THEN je.duration_ms END) as avg_duration_ms,
        MIN(CASE WHEN je.event_type = 'step_entered' THEN je.created_at END) as first_reached
      FROM journey_events je
      JOIN steps s ON je.step_id = s.id
      WHERE je.journey_id = $1 
        AND je.organization_id = $2 
        AND je.created_at >= $3
        AND je.step_id IS NOT NULL
      GROUP BY je.step_id, s.title, s.type, s.is_start
      ORDER BY s.is_start DESC, first_reached ASC NULLS LAST
    `, [journeyId, orgId, sinceDate]);
    
    // Build funnel with drop-off rates (using funnelData order - sorted by when users reach each step)
    const funnel = [];
    for (let index = 0; index < funnelData.rows.length; index++) {
      const stepData = funnelData.rows[index];
      const usersReached = parseInt(stepData.users_reached) || 0;
      const usersCompleted = parseInt(stepData.users_completed) || 0;
      const previousReached = index === 0 ? started : (funnel[index - 1]?.users_reached || started);
      
      funnel.push({
        step_id: stepData.step_id,
        step_title: stepData.step_title,
        step_type: stepData.step_type,
        step_order: index + 1,
        users_reached: usersReached,
        users_completed: usersCompleted,
        avg_duration_ms: stepData.avg_duration_ms ? Math.round(stepData.avg_duration_ms) : null,
        drop_off_rate: previousReached > 0 ? Math.round(((previousReached - usersReached) / previousReached) * 100) : 0,
        completion_rate: usersReached > 0 ? Math.round((usersCompleted / usersReached) * 100) : 0
      });
    }
    
    // Get quiz performance per step (if any quiz steps)
    const quizStats = await query(`
      SELECT 
        qa.step_id,
        COUNT(*) as attempts,
        AVG(CASE WHEN qa.total_questions > 0 THEN (qa.correct_count::float / qa.total_questions) * 100 END) as avg_score,
        SUM(CASE WHEN qa.passed THEN 1 ELSE 0 END) as passed_count
      FROM quiz_attempts qa
      WHERE qa.journey_id = $1 AND qa.organization_id = $2 AND qa.created_at >= $3
      GROUP BY qa.step_id
    `, [journeyId, orgId, sinceDate]);
    
    // Merge quiz stats into funnel
    const funnelWithQuiz = funnel.map(step => {
      const quiz = quizStats.rows.find(q => q.step_id === step.step_id);
      if (quiz) {
        return {
          ...step,
          quiz_attempts: parseInt(quiz.attempts) || 0,
          quiz_avg_score: quiz.avg_score ? Math.round(quiz.avg_score) : null,
          quiz_pass_rate: quiz.attempts > 0 ? Math.round((quiz.passed_count / quiz.attempts) * 100) : null
        };
      }
      return step;
    });
    
    // Daily trend for this journey
    const dailyTrend = await query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(DISTINCT CASE WHEN event_type = 'journey_started' THEN COALESCE(end_user_id::text, session_id) END) as started,
        COUNT(DISTINCT CASE WHEN event_type = 'journey_completed' THEN COALESCE(end_user_id::text, session_id) END) as completed
      FROM journey_events
      WHERE journey_id = $1 AND organization_id = $2 AND created_at >= $3
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [journeyId, orgId, sinceDate]);
    
    res.json({
      success: true,
      journey: {
        id: journey.id,
        title: journey.title,
        status: journey.status,
        total_steps: parseInt(journey.total_steps) || 0
      },
      funnel: funnelWithQuiz,
      overall: {
        started,
        completed,
        completion_rate: completionRate
      },
      daily_trend: dailyTrend.rows
    });
    
  } catch (err) {
    console.error('[Analytics] Journey funnel error:', err);
    res.status(500).json({ success: false, error: 'Failed to load journey funnel data' });
  }
});

/**
 * GET /api/analytics/users-overview - Get all end users with analytics summary
 * For the Users tab in analytics dashboard
 */
router.get('/analytics/users-overview', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { group_id, search, limit = 50, offset = 0 } = req.query;
    
    let whereClause = 'eu.organization_id = $1';
    const params = [orgId];
    let paramIndex = 2;
    
    if (group_id) {
      whereClause += ` AND eu.id IN (SELECT end_user_id FROM end_user_group_members WHERE group_id = $${paramIndex++})`;
      params.push(group_id);
    }
    
    if (search) {
      whereClause += ` AND (eu.first_name ILIKE $${paramIndex} OR eu.last_name ILIKE $${paramIndex} OR eu.email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    // Get users with analytics summary
    const usersResult = await query(`
      SELECT 
        eu.id,
        eu.first_name,
        eu.last_name,
        eu.email,
        (SELECT COALESCE(json_agg(json_build_object('id', g.id, 'name', g.name)), '[]'::json)
         FROM end_user_groups g 
         JOIN end_user_group_members gm ON g.id = gm.group_id 
         WHERE gm.end_user_id = eu.id) as groups,
        (SELECT COUNT(DISTINCT journey_id) FROM journey_events 
         WHERE end_user_id = eu.id AND event_type = 'journey_completed') as journeys_completed,
        (SELECT MAX(created_at) FROM journey_events WHERE end_user_id = eu.id) as last_activity,
        (SELECT AVG(CASE WHEN total_questions > 0 THEN (correct_count::float / total_questions) * 100 END)
         FROM quiz_attempts WHERE end_user_id = eu.id) as avg_quiz_score,
        (SELECT COALESCE(json_agg(json_build_object('id', j.id, 'title', j.title) ORDER BY je_max.last_activity DESC), '[]'::json)
         FROM (SELECT DISTINCT journey_id, MAX(created_at) as last_activity 
               FROM journey_events WHERE end_user_id = eu.id GROUP BY journey_id) je_max
         JOIN journeys j ON j.id = je_max.journey_id) as journeys
      FROM end_users eu
      WHERE ${whereClause}
      ORDER BY last_activity DESC NULLS LAST
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, [...params, limit, offset]);
    
    // Get total count
    const countResult = await query(`
      SELECT COUNT(*) as total FROM end_users eu WHERE ${whereClause}
    `, params);
    
    // Get groups for filter dropdown
    const groupsResult = await query(`
      SELECT id, name, 
             (SELECT COUNT(*) FROM end_user_group_members WHERE group_id = end_user_groups.id) as member_count
      FROM end_user_groups 
      WHERE organization_id = $1
      ORDER BY name
    `, [orgId]);
    
    res.json({
      success: true,
      users: usersResult.rows.map(u => ({
        ...u,
        name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
        avg_quiz_score: u.avg_quiz_score ? Math.round(u.avg_quiz_score) : null
      })),
      total: parseInt(countResult.rows[0].total),
      groups: groupsResult.rows
    });
    
  } catch (err) {
    console.error('[Analytics] Users overview error:', err);
    res.status(500).json({ success: false, error: 'Failed to load users overview' });
  }
});

/**
 * GET /api/analytics/groups-overview - Get all groups with analytics summary
 * For the Groups tab in analytics dashboard
 */
router.get('/analytics/groups-overview', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { days = 30 } = req.query;
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    
    // Get all groups with member counts and stats
    const groupsResult = await query(`
      SELECT 
        g.id,
        g.name,
        g.description,
        (SELECT COUNT(*) FROM end_user_group_members WHERE group_id = g.id) as member_count,
        (SELECT COUNT(DISTINCT je.end_user_id) 
         FROM journey_events je
         JOIN end_user_group_members gm ON je.end_user_id = gm.end_user_id
         WHERE gm.group_id = g.id AND je.created_at >= $2) as active_users,
        (SELECT COUNT(DISTINCT je.end_user_id) 
         FROM journey_events je
         JOIN end_user_group_members gm ON je.end_user_id = gm.end_user_id
         WHERE gm.group_id = g.id AND je.event_type = 'journey_completed' AND je.created_at >= $2) as users_completed,
        (SELECT AVG(CASE WHEN qa.total_questions > 0 THEN (qa.correct_count::float / qa.total_questions) * 100 END)
         FROM quiz_attempts qa
         JOIN end_user_group_members gm ON qa.end_user_id = gm.end_user_id
         WHERE gm.group_id = g.id AND qa.created_at >= $2) as avg_quiz_score
      FROM end_user_groups g
      WHERE g.organization_id = $1
      ORDER BY g.name
    `, [orgId, sinceDate]);
    
    // Calculate completion rates and format
    const groups = groupsResult.rows.map(g => ({
      ...g,
      member_count: parseInt(g.member_count) || 0,
      active_users: parseInt(g.active_users) || 0,
      users_completed: parseInt(g.users_completed) || 0,
      completion_rate: g.active_users > 0 ? Math.round((g.users_completed / g.active_users) * 100) : 0,
      avg_quiz_score: g.avg_quiz_score ? Math.round(g.avg_quiz_score) : null
    }));
    
    // Get organization-wide averages for benchmarking
    const orgAverages = await query(`
      SELECT 
        (SELECT AVG(CASE WHEN total_questions > 0 THEN (correct_count::float / total_questions) * 100 END)
         FROM quiz_attempts WHERE organization_id = $1 AND created_at >= $2) as org_avg_quiz_score,
        (SELECT COUNT(DISTINCT end_user_id)::float / NULLIF(COUNT(DISTINCT CASE WHEN event_type = 'journey_started' THEN end_user_id END), 0) * 100
         FROM journey_events 
         WHERE organization_id = $1 AND event_type IN ('journey_started', 'journey_completed') AND created_at >= $2) as org_completion_rate
    `, [orgId, sinceDate]);
    
    res.json({
      success: true,
      groups,
      org_benchmarks: {
        avg_quiz_score: orgAverages.rows[0].org_avg_quiz_score ? Math.round(orgAverages.rows[0].org_avg_quiz_score) : null,
        completion_rate: orgAverages.rows[0].org_completion_rate ? Math.round(orgAverages.rows[0].org_completion_rate) : null
      }
    });
    
  } catch (err) {
    console.error('[Analytics] Groups overview error:', err);
    res.status(500).json({ success: false, error: 'Failed to load groups overview' });
  }
});

/**
 * GET /api/analytics/top-journeys - Get top performing journeys
 * For the Overview tab in analytics dashboard
 * Uses end_user_progress for reliable start/completion data
 */
router.get('/analytics/top-journeys', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { days = 30, limit = 10 } = req.query;
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    
    // Get journey stats from end_user_progress (reliable source)
    const journeysResult = await query(`
      SELECT 
        j.id,
        j.title,
        j.status,
        COUNT(DISTINCT eup.id) as started,
        COUNT(DISTINCT CASE WHEN eup.completed_at IS NOT NULL THEN eup.id END) as completed,
        AVG(CASE WHEN je.event_type = 'step_completed' AND je.duration_ms IS NOT NULL THEN je.duration_ms END) as avg_step_duration_ms
      FROM journeys j
      LEFT JOIN invitations i ON j.id = i.journey_id AND i.organization_id = $1
      LEFT JOIN end_user_progress eup ON i.id = eup.invitation_id AND eup.started_at >= $2
      LEFT JOIN journey_events je ON j.id = je.journey_id AND je.created_at >= $2
      WHERE j.organization_id = $1 AND j.deleted_at IS NULL
      GROUP BY j.id, j.title, j.status
      HAVING COUNT(DISTINCT eup.id) > 0
      ORDER BY COUNT(DISTINCT CASE WHEN eup.completed_at IS NOT NULL THEN eup.id END) DESC, 
               COUNT(DISTINCT eup.id) DESC
      LIMIT $3
    `, [orgId, sinceDate, parseInt(limit)]);
    
    const journeys = journeysResult.rows.map(j => ({
      id: j.id,
      title: j.title,
      status: j.status,
      started: parseInt(j.started) || 0,
      completed: parseInt(j.completed) || 0,
      completion_rate: parseInt(j.started) > 0 ? Math.round((parseInt(j.completed) / parseInt(j.started)) * 100) : 0,
      avg_duration_ms: j.avg_step_duration_ms ? Math.round(j.avg_step_duration_ms) : null
    }));
    
    console.log('[Analytics] Top journeys found:', journeys.length);
    
    res.json({
      success: true,
      journeys
    });
    
  } catch (err) {
    console.error('[Analytics] Top journeys error:', err);
    res.status(500).json({ success: false, error: 'Failed to load top journeys' });
  }
});

// ============================================
// ONBOARDING & DEMO JOURNEYS
// ============================================

import {
  getDemoJourney,
  getUserOnboardingState,
  updateUserOnboardingState,
  shouldShowWelcome,
  markHintShown,
  createVirtualJourneyFromDemo
} from '../services/demoJourney.js';
import { dismissTip } from '../services/tips.js';

/**
 * GET /api/onboarding/state - Get current user's onboarding state
 */
router.get('/onboarding/state', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const state = await getUserOnboardingState(user.id, orgId);
    const showWelcome = await shouldShowWelcome(user.id, orgId);
    
    res.json({
      success: true,
      state: {
        ...state,
        should_show_welcome: showWelcome
      }
    });
  } catch (err) {
    console.error('[Onboarding] Get state error:', err);
    res.status(500).json({ success: false, error: 'Failed to get onboarding state' });
  }
});

/**
 * POST /api/onboarding/welcome-seen - Mark welcome modal as seen
 */
router.post('/onboarding/welcome-seen', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const state = await updateUserOnboardingState(user.id, {
      has_seen_welcome: true,
      welcome_seen_at: new Date().toISOString()
    });
    
    res.json({ success: true, state });
  } catch (err) {
    console.error('[Onboarding] Mark welcome seen error:', err);
    res.status(500).json({ success: false, error: 'Failed to update onboarding state' });
  }
});

/**
 * POST /api/onboarding/tour-started - Mark tour as started
 */
router.post('/onboarding/tour-started', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const state = await updateUserOnboardingState(user.id, {
      has_started_tour: true,
      tour_started_at: new Date().toISOString()
    });
    
    res.json({ success: true, state });
  } catch (err) {
    console.error('[Onboarding] Mark tour started error:', err);
    res.status(500).json({ success: false, error: 'Failed to update onboarding state' });
  }
});

/**
 * POST /api/onboarding/tour-completed - Mark tour as completed
 */
router.post('/onboarding/tour-completed', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { demo_journey_version } = req.body;
    
    const state = await updateUserOnboardingState(user.id, {
      has_completed_tour: true,
      tour_completed_at: new Date().toISOString(),
      demo_journey_version: demo_journey_version || null
    });
    
    res.json({ success: true, state });
  } catch (err) {
    console.error('[Onboarding] Mark tour completed error:', err);
    res.status(500).json({ success: false, error: 'Failed to update onboarding state' });
  }
});

/**
 * POST /api/onboarding/tour-skipped - Mark tour as skipped
 */
router.post('/onboarding/tour-skipped', async (req, res) => {
  try {
    const user = req.session.user;
    const orgId = req.session.organization?.id;
    if (!user || !orgId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const state = await updateUserOnboardingState(user.id, {
      has_skipped_tour: true,
      has_seen_welcome: true,
      welcome_seen_at: new Date().toISOString()
    });
    
    res.json({ success: true, state });
  } catch (err) {
    console.error('[Onboarding] Mark tour skipped error:', err);
    res.status(500).json({ success: false, error: 'Failed to update onboarding state' });
  }
});

/**
 * POST /api/onboarding/hint-shown - Mark a contextual hint as shown
 */
router.post('/onboarding/hint-shown', async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { hint_id } = req.body;
    if (!hint_id) {
      return res.status(400).json({ success: false, error: 'hint_id is required' });
    }
    
    await markHintShown(user.id, hint_id);
    
    res.json({ success: true });
  } catch (err) {
    console.error('[Onboarding] Mark hint shown error:', err);
    res.status(500).json({ success: false, error: 'Failed to mark hint as shown' });
  }
});

/**
 * POST /api/onboarding/tip-dismissed - Dismiss a dashboard tip for the current user
 */
router.post('/onboarding/tip-dismissed', async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const { tip_key } = req.body;
    if (!tip_key || typeof tip_key !== 'string') {
      return res.status(400).json({ success: false, error: 'tip_key is required' });
    }

    try {
      await dismissTip(user.id, req.organizationId, tip_key);
    } catch (err) {
      if (err.message === 'Unknown tip key') {
        return res.status(400).json({ success: false, error: 'Unknown tip key' });
      }
      throw err;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Onboarding] Dismiss tip error:', err);
    res.status(500).json({ success: false, error: 'Failed to dismiss tip' });
  }
});

/**
 * GET /api/demo-journey - Get the demo journey for organization's default language
 */
router.get('/demo-journey', async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    // Use organization's default language for demo journey content (not user's interface language)
    const orgLanguage = req.session.organization?.settings?.default_language || req.session.organization?.language || 'en';
    const role = user.role || null;
    
    const demoJourney = await getDemoJourney(orgLanguage, role);
    
    if (!demoJourney) {
      return res.json({ success: true, demo_journey: null });
    }
    
    const virtualJourney = createVirtualJourneyFromDemo(demoJourney);
    
    res.json({
      success: true,
      demo_journey: virtualJourney
    });
  } catch (err) {
    console.error('[Demo Journey] Get demo journey error:', err);
    res.status(500).json({ success: false, error: 'Failed to get demo journey' });
  }
});

/**
 * GET /api/demo-journey/:id - Get a specific demo journey by ID
 */
router.get('/demo-journey/:id', async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    
    const { id } = req.params;
    
    const result = await query('SELECT * FROM demo_journeys WHERE id = $1 AND is_active = true', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Demo journey not found' });
    }
    
    const virtualJourney = createVirtualJourneyFromDemo(result.rows[0]);
    
    res.json({
      success: true,
      demo_journey: virtualJourney
    });
  } catch (err) {
    console.error('[Demo Journey] Get demo journey by ID error:', err);
    res.status(500).json({ success: false, error: 'Failed to get demo journey' });
  }
});

// ============================================
// ADMIN: Demo Journey Management
// ============================================

// =============================================================================
// JOURNEY WIZARD ENDPOINTS
// =============================================================================
//
// Two endpoints power the Journey Wizard (see public/js/journey-wizard.js):
//   POST /api/wizard/upload    — validates a document and caches extracted
//                                text in Redis for later use during generation.
//   POST /api/wizard/generate  — streams a Server-Sent-Events response while
//                                the AI builds a journey + optional AI Guide.
// =============================================================================

const WIZARD_MAX_PAGES = 60;
const WIZARD_MAX_BYTES = 50 * 1024 * 1024;
const WIZARD_UPLOAD_TTL_SECONDS = 2 * 60 * 60;

/**
 * POST /api/wizard/upload
 * Accepts a document, parses it, returns an uploadId that can be passed to
 * /api/wizard/generate. Parsed text and file path are cached in Redis so the
 * generation step does not need to re-parse.
 */
const wizardUploadHandler = (req, res, next) => {
  knowledgeUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    // Surface multer/file-filter errors as clean JSON for the wizard UI
    let code = 'uploadGeneric';
    if (err && err.code === 'LIMIT_FILE_SIZE') code = 'uploadTooLarge';
    else if (err && typeof err.message === 'string' && err.message.startsWith('Unsupported file type')) code = 'uploadUnsupportedType';
    console.warn('[Wizard] upload rejected:', err.message);
    return res.status(400).json({ success: false, code, error: err.message });
  });
};

router.post('/wizard/upload', wizardUploadHandler, async (req, res) => {
  const tempFilePath = req.file ? req.file.path : null;
  let redisSaved = false;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, code: 'uploadGeneric', error: 'No file uploaded' });
    }
    const orgId = req.organizationId;
    const userId = req.user?.id;
    if (!orgId || !userId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    if (req.file.size > WIZARD_MAX_BYTES) {
      return res.status(400).json({ success: false, code: 'uploadTooLarge' });
    }

    // Parse the document.
    // The wizard only needs plain text (no layout/tables/OCR), so we force the
    // lightweight 'fast' strategy. That avoids loading YOLOX/OCR vision models
    // which spike memory and OOM-kill the parser worker on low-RAM hosts.
    const parsed = await parseDocument(req.file.path, req.file.mimetype, { strategy: 'fast' });
    if (!parsed.success) {
      const errMsg = String(parsed.error || '');
      if (errMsg === 'DOCUMENT_PARSER_DISABLED') {
        return res.status(400).json({ success: false, code: 'parserDisabled', error: req.t('journeys.wizard.errors.parserDisabled') });
      }
      const parserDown = /EAI_AGAIN|ECONNREFUSED|ENOTFOUND|fetch failed|Parser error/i.test(errMsg);
      return res.status(parserDown ? 503 : 400).json({
        success: false,
        code: parserDown ? 'parserUnavailable' : 'uploadGeneric',
        error: parsed.error
      });
    }

    // Count pages via element metadata if available
    let pages = 1;
    if (Array.isArray(parsed.elements)) {
      const pageNumbers = parsed.elements
        .map(el => el && el.metadata && el.metadata.page_number)
        .filter(n => typeof n === 'number');
      if (pageNumbers.length > 0) pages = Math.max(...pageNumbers);
    }

    const warnings = [];
    let text = parsed.text || '';

    if (pages > WIZARD_MAX_PAGES) {
      // Keep elements that belong to the first N pages and warn
      if (Array.isArray(parsed.elements)) {
        text = parsed.elements
          .filter(el => {
            const p = el && el.metadata && el.metadata.page_number;
            return typeof p !== 'number' || p <= WIZARD_MAX_PAGES;
          })
          .map(el => el.text || '')
          .filter(t => t.trim().length > 0)
          .join('\n\n');
      } else {
        text = text.slice(0, 30000);
      }
      warnings.push('truncated_pages');
      pages = WIZARD_MAX_PAGES;
    }

    if (!text || text.trim().length < 20) {
      return res.status(400).json({ success: false, code: 'uploadNoText' });
    }

    const uploadId = crypto.randomUUID();
    const redisKey = `wizard:upload:${orgId}:${userId}:${uploadId}`;
    const payload = {
      orgId,
      userId,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      filePath: req.file.path,
      text,
      pages,
      warnings,
      createdAt: Date.now()
    };

    try {
      await redis.set(redisKey, JSON.stringify(payload), 'EX', WIZARD_UPLOAD_TTL_SECONDS);
      redisSaved = true;
    } catch (redisErr) {
      console.warn('[Wizard] Redis unavailable, falling back to in-memory cache:', redisErr.message);
      if (!global.__wizardUploadCache) global.__wizardUploadCache = new Map();
      global.__wizardUploadCache.set(redisKey, { payload, expiresAt: Date.now() + WIZARD_UPLOAD_TTL_SECONDS * 1000 });
      redisSaved = true;
    }

    res.json({
      success: true,
      uploadId,
      fileName: req.file.originalname,
      pages,
      warnings
    });
  } catch (err) {
    console.error('[Wizard] Upload error:', err);
    const code = err.message && err.message.startsWith('Unsupported file type') ? 'uploadUnsupportedType' : 'uploadGeneric';
    res.status(500).json({ success: false, code, error: 'Upload failed' });
  } finally {
    // If we never saved anything to Redis / cache, clean up the temp file.
    if (!redisSaved && tempFilePath) {
      fs.unlink(tempFilePath, () => {});
    }
  }
});

async function getWizardUpload(orgId, userId, uploadId) {
  const key = `wizard:upload:${orgId}:${userId}:${uploadId}`;
  try {
    const raw = await redis.get(key);
    if (raw) return { key, payload: JSON.parse(raw) };
  } catch { /* fall back */ }
  if (global.__wizardUploadCache && global.__wizardUploadCache.has(key)) {
    const entry = global.__wizardUploadCache.get(key);
    if (entry.expiresAt > Date.now()) return { key, payload: entry.payload };
    global.__wizardUploadCache.delete(key);
  }
  return null;
}

async function deleteWizardUpload(orgId, userId, uploadId) {
  const key = `wizard:upload:${orgId}:${userId}:${uploadId}`;
  try { await redis.del(key); } catch {}
  if (global.__wizardUploadCache) global.__wizardUploadCache.delete(key);
}

/**
 * Ensure the AI Guide's greeting uses the maker-chosen name.
 *
 * Mistral may generate a greeting like "Hi, I'm Alex. Ask about parking." while
 * the maker chose the name "Willempie". In that case we swap Mistral's
 * suggested name with the real one so the greeting stays consistent. Handles
 * a few common salutation patterns across EN/NL/DE/FR/ES.
 */
function reconcileGreetingName(greeting, suggestedName, chosenName) {
  const g = String(greeting || '').trim();
  const suggested = String(suggestedName || '').trim();
  const chosen = String(chosenName || '').trim();
  if (!g || !chosen) return g;

  // If Mistral suggested the same name, nothing to reconcile.
  if (suggested && suggested.toLowerCase() === chosen.toLowerCase()) return g;

  // Escape user/AI-provided values for use in a RegExp.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 1. Replace any explicit occurrence of the suggested name with the chosen one.
  let out = g;
  if (suggested) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- value is passed through escape() above
    const reSuggested = new RegExp(`\\b${escape(suggested)}\\b`, 'g');
    out = out.replace(reSuggested, chosen);
  }

  // 2. Catch common "I'm X" / "ik ben X" / "Ich bin X" / "Je suis X" / "Soy X"
  //    patterns where Mistral may have inserted a different name anyway.
  const iAmPatterns = [
    /\b(I['’]?m|I am)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,30})/,
    /\b(ik\s+ben|ik\s+heet)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,30})/i,
    /\b(ich\s+bin|ich\s+heiße)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,30})/i,
    /\b(je\s+suis|je\s+m['’]appelle)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,30})/i,
    /\b(soy|me\s+llamo)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,30})/i
  ];
  for (const re of iAmPatterns) {
    out = out.replace(re, (_m, verb, name) => {
      if (name.toLowerCase() === chosen.toLowerCase()) return _m;
      return `${verb} ${chosen}`;
    });
  }

  return out;
}

/**
 * POST /api/wizard/generate
 * Streams Server-Sent Events with progress updates, then creates the journey
 * (and optional AI Guide) in the database. Responds with { done, journeyId }.
 */
router.post('/wizard/generate', async (req, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.id;
  if (!orgId || !userId) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  // Configure SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  };

  let uploadedFileToCleanup = null;

  try {
    const body = req.body || {};

    // Role check — viewers cannot create
    if (req.user && req.user.role === 'viewer') {
      send({ status: 'error', error: 'Viewers cannot create journeys' });
      return res.end();
    }

    // Journey tier check
    const journeyLimit = await checkLimit(orgId, RESOURCE_TYPES.JOURNEYS);
    if (!journeyLimit.allowed) {
      send({ status: 'error', code: 'LIMIT_EXCEEDED', limitType: 'journeys', error: req.t('subscription.limits.journeysExceeded') });
      return res.end();
    }

    // "newWithKb" requires an uploaded document — without one there is no
    // knowledge base to seed. If the client somehow sent this combination
    // (stale cache, direct API call, etc.) downgrade gracefully to newNoKb so
    // we still produce a valid journey instead of a broken half-guide.
    if (body.guide === 'newWithKb' && (body.source !== 'upload' || !body.uploadId)) {
      body.guide = 'newNoKb';
    }

    // Guide tier check (only if a new guide is requested)
    if (body.guide === 'newWithKb' || body.guide === 'newNoKb') {
      const guideLimit = await checkLimit(orgId, RESOURCE_TYPES.GUIDES);
      if (!guideLimit.allowed) {
        send({ status: 'error', code: 'LIMIT_EXCEEDED', limitType: 'guides', error: req.t('subscription.limits.guidesExceeded') });
        return res.end();
      }
    }

    send({ status: 'reading', progress: 5 });

    // Look up the maker's email once — we default form steps to send their
    // submissions to the maker so the form works right out of the box.
    // The maker can always change the recipient later in the builder.
    let makerEmail = null;
    try {
      const meRes = await query('SELECT email FROM users WHERE id = $1 AND organization_id = $2', [userId, orgId]);
      makerEmail = meRes.rows[0]?.email || null;
    } catch (_) { /* non-fatal */ }

    let documentText = null;
    let uploadRecord = null;
    if (body.source === 'upload' && body.uploadId) {
      uploadRecord = await getWizardUpload(orgId, userId, body.uploadId);
      if (!uploadRecord) {
        send({ status: 'error', error: 'Uploaded document not found or expired' });
        return res.end();
      }
      documentText = uploadRecord.payload.text;
      uploadedFileToCleanup = uploadRecord.payload.filePath;
    } else if (body.source === 'describe') {
      if (!body.topic || body.topic.trim().length < 10) {
        send({ status: 'error', error: 'Topic is too short' });
        return res.end();
      }
    } else {
      send({ status: 'error', error: 'Invalid source' });
      return res.end();
    }

    send({ status: 'thinking', progress: 15 });

    // Generate the plan via Mistral
    const plan = await buildJourneyPlan({
      documentText,
      topic: body.topic,
      purpose: body.purpose,
      audience: body.audience,
      guide: body.guide,
      length: body.length,
      branching: body.branching,
      branchingComplexity: body.branchingComplexity,
      reward: body.reward,
      rewardDetails: body.rewardDetails,
      language: body.language,
      title: body.title,
      description: body.description,
      guideName: body.guideName,
      // Component checkboxes from the wizard's "What goes in your journey?"
      // page. We coerce to plain booleans so the prompt only sees true/false.
      components: {
        quiz:  body.components?.quiz  === true,
        poll:  body.components?.poll  === true,
        form:  body.components?.form  === true,
        space: body.components?.space === true,
        video: body.components?.video === true,
        image: body.components?.image === true
      }
    });

    send({ status: 'creating', progress: 45 });

    // Handle AI Guide creation / linking
    let guideIdForJourney = null;
    let linkedGuideInfo = null; // { name, role, greeting } for step-level props
    if (body.guide === 'existing' && body.guideExistingId) {
      // Validate it belongs to this org and fetch its display fields.
      const gCheck = await query(
        'SELECT id, name, role, greeting FROM guides WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [body.guideExistingId, orgId]
      );
      if (gCheck.rows.length > 0) {
        guideIdForJourney = gCheck.rows[0].id;
        linkedGuideInfo = {
          name: gCheck.rows[0].name,
          role: gCheck.rows[0].role,
          greeting: gCheck.rows[0].greeting
        };
      }
    } else if (body.guide === 'newWithKb' || body.guide === 'newNoKb') {
      send({ status: 'guide', progress: 55 });
      const guideName = (body.guideName && body.guideName.trim()) || (plan.suggested_guide?.name) || 'Gryffi Assistant';
      const guideRole = plan.suggested_guide?.role || 'Guide';
      // Safety net: if Mistral invented a different name in the greeting
      // (e.g. "Hi, I'm Alex…") while the maker chose "Willempie", swap it out
      // so the greeting is consistent with the guide's actual name.
      const guideGreeting = reconcileGreetingName(
        plan.suggested_guide?.greeting || '',
        plan.suggested_guide?.name || '',
        guideName
      );
      const guideInsert = await query(
        `INSERT INTO guides (organization_id, name, role, personality, greeting, ai_instructions, language)
         VALUES ($1, $2, $3, 'friendly', $4, $5, $6)
         RETURNING id`,
        [orgId, guideName, guideRole, guideGreeting, (plan.suggested_guide?.topics || []).join(', '), body.language || 'en']
      );
      guideIdForJourney = guideInsert.rows[0].id;
      linkedGuideInfo = { name: guideName, role: guideRole, greeting: guideGreeting };
      await logUsageEvent(orgId, 'guide_create', 'guide', guideIdForJourney, userId);

      if (body.guide === 'newWithKb' && uploadRecord) {
        send({ status: 'knowledge', progress: 65 });
        try {
          let fileSize = null;
          try { fileSize = fs.statSync(uploadRecord.payload.filePath).size; } catch (_) {}
          const src = await createKnowledgeSource({
            guideId: guideIdForJourney,
            organizationId: orgId,
            sourceType: 'file',
            sourceName: uploadRecord.payload.originalName,
            originalFilename: uploadRecord.payload.originalName,
            contentType: uploadRecord.payload.mimeType,
            fileSize
          });
          // Fire-and-forget — the wizard doesn't need to wait for embeddings
          processFile(src.id, uploadRecord.payload.filePath, uploadRecord.payload.mimeType, guideIdForJourney, null, orgId)
            .catch(e => console.error('[Wizard] processFile error:', e));
          uploadedFileToCleanup = null; // ownership transferred to knowledge source
        } catch (kbErr) {
          console.error('[Wizard] Failed to attach knowledge to new guide:', kbErr);
        }
      }
    }

    // Create the journey
    send({ status: 'steps', progress: 75 });
    const journeyInsert = await query(
      `INSERT INTO journeys (organization_id, created_by, title, description, status, guide_id)
       VALUES ($1, $2, $3, $4, 'draft', $5)
       RETURNING id`,
      [orgId, userId, plan.title || body.title || 'Untitled', plan.description || body.description || '', guideIdForJourney]
    );
    const journeyId = journeyInsert.rows[0].id;
    await logUsageEvent(orgId, 'journey_create', 'journey', journeyId, userId);

    // Insert steps. We pre-compute (x, y) positions with a layered graph
    // layout so branched journeys open as a tidy diamond/tree on the canvas
    // instead of a stack of overlapping nodes that the maker has to drag
    // apart manually.
    const stepIdMap = new Map(); // plan step.id -> real DB id
    const layout = computePlanLayout(plan);
    const fallbackX = 100;
    const fallbackY = 240;

    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      const pos = layout.get(s.id);
      const x = pos ? pos.x : (fallbackX + i * 280);
      const y = pos ? pos.y : fallbackY;

      // Form steps need a recipient email to be submittable. Default to the
      // maker's own address so the form works immediately — they can change it
      // in the builder later.
      const basicProps = { ...(s.basic_props || {}) };
      if (s.type === 'form' && !basicProps.recipient_email && makerEmail) {
        basicProps.recipient_email = makerEmail;
      }

      const inserted = await query(
        `INSERT INTO steps (journey_id, type, title, position_x, position_y, is_start, is_end, basic_props, advanced_props)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         RETURNING id`,
        [
          journeyId, s.type, s.title, x, y, s.is_start, s.is_end,
          JSON.stringify(basicProps),
          JSON.stringify(s.advanced_props || {})
        ]
      );
      stepIdMap.set(s.id, inserted.rows[0].id);

      // Link guide steps to the AI Guide. Keep step-level display props
      // (name/role/greeting) perfectly in sync with the actual Guide record,
      // so the builder never shows a different name than the Guide really has.
      if (s.type === 'guide' && guideIdForJourney) {
        const mergedProps = { ...basicProps, guide_id: guideIdForJourney };
        if (linkedGuideInfo) {
          if (linkedGuideInfo.name) mergedProps.name = linkedGuideInfo.name;
          if (linkedGuideInfo.role) mergedProps.role = linkedGuideInfo.role;
          if (linkedGuideInfo.greeting) mergedProps.greeting = linkedGuideInfo.greeting;
        }
        await query(
          `UPDATE steps SET basic_props = $1::jsonb WHERE id = $2`,
          [JSON.stringify(mergedProps), inserted.rows[0].id]
        );
      }
    }

    // Insert paths
    send({ status: 'paths', progress: 90 });
    for (let i = 0; i < plan.paths.length; i++) {
      const p = plan.paths[i];
      const fromId = stepIdMap.get(p.from);
      const toId = stepIdMap.get(p.to);
      if (!fromId || !toId) continue;
      await query(
        `INSERT INTO paths (journey_id, from_step_id, to_step_id, label, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [journeyId, fromId, toId, p.label || 'Continue', p.sort_order || i]
      );
    }

    send({ status: 'finishing', progress: 98 });

    // Clean up the wizard upload record (file is kept by knowledge source if used)
    if (body.source === 'upload' && body.uploadId) {
      await deleteWizardUpload(orgId, userId, body.uploadId);
    }

    send({ done: true, journeyId, progress: 100 });
    res.end();

    // Clean up temp file only if it wasn't attached to a guide
    if (uploadedFileToCleanup) {
      fs.unlink(uploadedFileToCleanup, () => {});
    }
  } catch (err) {
    console.error('[Wizard] Generate error:', err);
    // Forward the error code so the client can pick a localised friendly
    // message ("This took longer than expected, try again or pick a shorter
    // length") instead of showing the raw English exception text.
    send({
      status: 'error',
      code: err && err.code ? err.code : undefined,
      error: err.message || 'Generation failed'
    });
    try { res.end(); } catch (_) {}
    if (uploadedFileToCleanup) {
      fs.unlink(uploadedFileToCleanup, () => {});
    }
  }
});

// Gryffi Cloud routes (billing, support, platform admin) live in src/cloud/, which the Community Edition
// does not ship
if (isCloud()) {
  const cloud = await import('../cloud/index.js');
  cloud.registerBillingRoutes(router);
  cloud.registerPlatformAdminRoutes(router);
}

// Community Edition: installation settings for admins (src/setup/installation.js)
if (isCommunity()) {
  const { registerInstallationApi } = await import('../setup/installation.js');
  registerInstallationApi(router);
}

export default router;
