/**
 * Gryffi - Interactive Journey Builder
 * Main Server Entry Point
 */
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import i18next from 'i18next';
import i18nextMiddleware from 'i18next-http-middleware';
import i18nextFsBackend from 'i18next-fs-backend';

import logger from './lib/logger.js';
import redis from './db/redis.js';
import pool from './db/index.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import apiRoutes from './routes/api.js';
import publicApiRoutes from './routes/publicApi.js';
import emailPreferenceRoutes from './routes/emailPreferences.js';
import { tenantFilter, refreshSessionUser } from './middleware/auth.js';
import { orgContextMiddleware } from './db/index.js';
import { startScheduler } from './services/scheduler.js';
import { 
  globalLimiter, 
  loginLimiter, 
  authLimiter,
  authenticatedApiLimiter
} from './middleware/rateLimit.js';
import { initHelpCache } from './services/help.js';
import { preloadPlayerLocales } from './services/playerLocales.js';
import { initializeDefaultDemoJourneys } from './services/demoJourney.js';
import { ensureCommunityTier } from './services/subscription.js';
import { isCloud, isCommunity, getEdition, COMMUNITY_SUPPORT_URL } from './edition.js';
import { isInlineSafeExtension } from './utils/imageType.js';
import { safeJson } from './utils/safeJson.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global safety nets for unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal(err, 'Uncaught Exception');
  process.exit(1);
});

// Initialize i18next
await i18next
  .use(i18nextFsBackend)
  .use(i18nextMiddleware.LanguageDetector)
  .init({
    fallbackLng: 'en',
    supportedLngs: ['en', 'nl', 'de', 'fr', 'es'],
    preload: ['en', 'nl', 'de', 'fr', 'es'],
    returnObjects: true, // Allow returning nested objects for translations
    backend: {
      loadPath: path.join(__dirname, '../locales/{{lng}}.json'),
    },
    detection: {
      // Priority: session > cookie > header
      order: ['querystring', 'session', 'cookie', 'header'],
      lookupSession: 'language',
      lookupCookie: 'i18next',
      caches: ['cookie'],
      cookieExpirationDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
    },
    interpolation: {
      escapeValue: false,
    },
  });

const app = express();
const PORT = process.env.APP_INTERNAL_PORT || 3000;

// Trust proxy (for Docker/Nginx setup)
app.set('trust proxy', 1);

// View engine setup
app.set('view engine', 'ejs');
// Script-safe JSON for inline <script> blocks: <%- safeJson(value) %>
app.locals.safeJson = safeJson;
app.set('views', path.join(__dirname, 'views'));

// Gryffi Cloud: signup, billing, platform admin, payment webhook and website
// analytics live in src/cloud/, which the Community Edition does not ship
const cloud = isCloud() ? await import('./cloud/index.js') : null;
const cloudCsp = cloud ? cloud.getCloudCspSources() : { script: [], frame: [], connect: [] };

// Security middleware - conditionally apply CSP based on client IP
// Internal IPs (Docker containers) need a relaxed CSP so server-to-server
// traffic between our containers can talk over plain HTTP.
app.use((req, res, next) => {
  const ip = getClientIp(req);
  const isInternal = isInternalIp(ip);
  
  // CSP directives shared between internal and external
  const baseDirectives = {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
    fontSrc: ["'self'"],
    imgSrc: ["'self'", "data:", "blob:", "https://images.pexels.com", "https://i.ytimg.com", "https://img.youtube.com", "https://api.dicebear.com"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://www.youtube.com", "https://unpkg.com", ...cloudCsp.script],
    frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://youtube-nocookie.com", ...cloudCsp.frame],
    connectSrc: ["'self'", ...cloudCsp.connect],
    objectSrc: ["'self'"],
  };

  // For internal IPs: disable upgrade-insecure-requests so HTTP works between
  // Docker containers (e.g. parser, nudenet) that hit the app over plain HTTP.
  if (isInternal) {
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...baseDirectives,
          upgradeInsecureRequests: null,  // Disable HTTPS upgrade for internal
        },
      },
    })(req, res, next);
  } else {
    // For external IPs, use standard CSP (with upgrade-insecure-requests)
    helmet({
      contentSecurityPolicy: {
        directives: baseDirectives,
        // upgrade-insecure-requests is added by default by Helmet
      },
    })(req, res, next);
  }
});

// Compression
app.use(compression());

// Request ID and logging
import crypto from 'crypto';
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID().slice(0, 8);
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Global rate limiting - very generous for corporate networks
// 3000 requests per 15 minutes per IP
app.use(globalLimiter);

// Gryffi Cloud webhooks verify a signature on the raw body, so they come
// before body parsing
if (cloud) cloud.registerWebhooks(app);

// Community Edition: first-run setup wizard (src/setup/)
const setup = isCommunity() ? await import('./setup/routes.js') : null;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Session configuration with Redis
const redisStore = new RedisStore({
  client: redis,
  prefix: 'gryffi:session:',
});

// Import internal IP checker for session cookie handling
import { isInternalIp, getClientIp } from './middleware/rateLimit.js';

if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET environment variable is not set. Refusing to start in production.');
    process.exit(1);
  }
  console.warn('⚠️  SESSION_SECRET not set. Using insecure default (development only).');
}

// Public assets (css/js/images/fonts) before session, i18n and the RLS org
// context: they need none of it, and the org context would otherwise hold a
// database connection for every asset of a logged-in maker. /media stays on
// the access-controlled route further down.
const publicAssets = express.static(path.join(__dirname, '..', 'public'));
app.use((req, res, next) => (/^\/(css|js|images|fonts)\//.test(req.path) ? publicAssets(req, res, next) : next()));

app.use(session({
  store: redisStore,
  secret: process.env.SESSION_SECRET || 'gryffi-dev-secret-not-for-production',
  resave: false,
  saveUninitialized: false,
  name: 'gryffi.sid',
  proxy: true, // Trust the reverse proxy (nginx)
  cookie: {
    // Dynamically set secure based on request - allow HTTP for internal IPs
    // so automated tools from Docker containers can authenticate via HTTP.
    secure: 'auto', // Express will set based on req.secure (respects X-Forwarded-Proto)
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax' // Changed from 'none' - 'lax' is safer and works with OAuth
  }
}));

// Middleware to allow insecure cookies for internal IPs (server-to-server calls from Docker containers)
app.use((req, res, next) => {
  const ip = getClientIp(req);
  if (isInternalIp(ip)) {
    // For internal IPs, force session cookie to be non-secure
    // This allows HTTP connections from Docker containers
    if (req.session && req.session.cookie) {
      req.session.cookie.secure = false;
    }
  }
  next();
});

// i18next middleware - must be before routes
app.use(i18nextMiddleware.handle(i18next));

// Community Edition: admins see in the sidebar when a newer release exists
const updates = isCommunity() ? await import('./setup/updates.js') : null;
app.use(async (req, res, next) => {
  res.locals.updateAvailable = null;
  if (updates && req.session?.user?.role === 'admin') {
    try {
      const status = await updates.getUpdateStatus();
      if (status.available) res.locals.updateAvailable = status.latest;
    } catch (err) {
      console.error('[Updates] Status failed:', err.message);
    }
  }
  next();
});

// Add common template variables
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.env = process.env.NODE_ENV || 'development';
  // Make translation function available in templates
  res.locals.t = req.t;
  res.locals.locale = req.language; // For builder.ejs
  res.locals.language = req.language;
  res.locals.edition = getEdition();
  res.locals.isCommunity = isCommunity();
  res.locals.communitySupportUrl = COMMUNITY_SUPPORT_URL;
  res.locals.languages = ['en', 'nl', 'de', 'fr', 'es'];
  res.locals.languageNames = {
    en: 'English',
    nl: 'Nederlands',
    de: 'Deutsch',
    fr: 'Français',
    es: 'Español'
  };

  // Website analytics of Gryffi Cloud (src/cloud/analytics.js); off in the
  // Community Edition
  res.locals.siteAnalytics = cloud ? cloud.getAnalyticsConfig() : { enabled: false };

  // Consume the one-shot justLoggedIn flag (set by auth.js after a
  // successful login). We pull it out of the session here so it only
  // fires once, then immediately delete it so a page refresh on the
  // dashboard doesn't double-count.
  if (req.session && req.session.justLoggedIn) {
    res.locals.justLoggedIn = req.session.justLoggedIn;
    delete req.session.justLoggedIn;
  }

  next();
});

// Re-check role and active status of the logged-in maker (deactivated or
// demoted makers lose their rights within 30 seconds, not when the session ends)
app.use(refreshSessionUser);

// Apply tenant filter (sets req.organizationId from session)
app.use(tenantFilter);

// Apply RLS org context (acquires per-request DB client with SET ROLE gryffi_app)
app.use(orgContextMiddleware);

// Apply organization default language for sessions that haven't chosen a language yet.
// - If org is set to fixed, we set session.language (so i18next will pick it up next requests)
// - We do NOT override if user already has session language or i18next cookie
app.use(async (req, res, next) => {
  try {
    const orgSettings = req.session?.organization?.settings || {};
    const mode = orgSettings.default_language_mode || 'fixed';
    const lang = orgSettings.default_language;
    const hasI18nCookie = String(req.headers.cookie || '').includes('i18next=');

    if (!req.session?.language && !hasI18nCookie && mode === 'fixed' && ['en', 'nl', 'de', 'fr', 'es'].includes(lang)) {
      req.session.language = lang;
      // Apply immediately for this request too
      await req.i18n.changeLanguage(lang);
      res.locals.t = req.t;
      res.locals.locale = req.language;
      res.locals.language = req.language;
    }
  } catch (_e) {
    // Best-effort only
  }
  next();
});

// Helper function to serve organization media files with access control
// Supports both new (/uploads/) and legacy (/media/) URL patterns
async function serveOrgMedia(req, res, isLegacyPath = false) {
  try {
    const orgId = req.params.orgId;
    const rest = req.params[0] || '';
    const requestedFile = rest.split('/').pop(); // Get filename

    // Check authorization: logged-in user, player mode (magic link), or public journey participant
    const isLoggedInUser = req.session?.user && req.session?.organization?.id;
    const isPlayerMode = req.session?.expedition?.invitationId;
    const isPublicJourneyParticipant = req.session?.publicParticipantId && req.session?.publicOrgId;
    
    // Allow public access to theme logos (needed for emails)
    // Theme logos are intentionally public since they appear in external emails
    let isPublicLogo = false;
    if (requestedFile && (rest.includes('media/') || rest.includes('uploads/'))) {
      const { query } = await import('./db/index.js');
      const logoCheck = await query(`
        SELECT id FROM themes 
        WHERE organization_id = $1 
          AND (logo_url LIKE $2 OR logo_light_url LIKE $2)
        LIMIT 1
      `, [orgId, `%${requestedFile}`]);
      isPublicLogo = logoCheck.rows.length > 0;
    }
    
    // Access is granted when one of the session's contexts belongs to this
    // organization: the maker's own org, the org that invited this end user
    // (magic link), the org of the public journey, or a public theme logo.
    let allowed = isPublicLogo
      || (isLoggedInUser && req.session.organization.id === orgId)
      || (isPublicJourneyParticipant && req.session.publicOrgId === orgId);

    if (!allowed && isPlayerMode) {
      let expeditionOrgId = req.session.expedition.orgId;
      if (!expeditionOrgId) {
        const { query } = await import('./db/index.js');
        const inv = await query('SELECT organization_id FROM invitations WHERE id = $1', [req.session.expedition.invitationId]);
        expeditionOrgId = inv.rows[0]?.organization_id;
        if (expeditionOrgId) req.session.expedition.orgId = expeditionOrgId;
      }
      allowed = expeditionOrgId === orgId;
    }

    if (!allowed) {
      return res.status(403).send('Forbidden');
    }

    // Determine base directory based on path type
    // New path: /uploads/organizations/{orgId}/media/ or /uploads/organizations/{orgId}/pexels/
    // Legacy path: /media/organizations/{orgId}/uploads/ or /media/organizations/{orgId}/pexels/
    let baseDir, resolved;
    
    if (isLegacyPath) {
      // Legacy URL: try new location first (data/uploads), then old location (app/public/media)
      // Map legacy paths to new structure: uploads/ -> media/, pexels/ stays pexels/
      let newRest = rest;
      if (rest.startsWith('uploads/')) {
        newRest = rest.replace('uploads/', 'media/');
      }
      
      const newBaseDir = path.join(__dirname, '..', 'uploads', 'organizations', orgId);
      const newResolvedBase = path.resolve(newBaseDir);
      const newRequestedPath = path.join(newBaseDir, newRest);
      const newResolved = path.resolve(newRequestedPath);
      
      // Check new location first
      if (newResolved.startsWith(newResolvedBase) && fs.existsSync(newResolved) && fs.statSync(newResolved).isFile()) {
        baseDir = newBaseDir;
        resolved = newResolved;
      } else {
        // Fall back to old location
        baseDir = path.join(__dirname, '..', 'public', 'media', 'organizations', orgId);
        const resolvedBase = path.resolve(baseDir);
        const requestedPath = path.join(baseDir, rest);
        resolved = path.resolve(requestedPath);
        
        if (!resolved.startsWith(resolvedBase)) {
          return res.status(400).send('Bad Request');
        }
      }
    } else {
      // New URL structure: files are in data/uploads/organizations/{orgId}/
      baseDir = path.join(__dirname, '..', 'uploads', 'organizations', orgId);
      const resolvedBase = path.resolve(baseDir);
      const requestedPath = path.join(baseDir, rest);
      resolved = path.resolve(requestedPath);

      // Prevent path traversal
      if (!resolved.startsWith(resolvedBase)) {
        return res.status(400).send('Bad Request');
      }
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).send('Not Found');
    }

    // Let the browser cache static files (safe because org-locked, or public logo)
    res.setHeader('Cache-Control', isPublicLogo ? 'public, max-age=86400' : 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Only known media types are shown inline. Anything else (HTML, SVG, XML)
    // is forced to download so an uploaded file can never run on our origin.
    if (!isInlineSafeExtension(resolved)) {
      return res.download(resolved, path.basename(resolved), {
        headers: { 'Content-Type': 'application/octet-stream' }
      });
    }
    return res.sendFile(resolved);
  } catch (err) {
    console.error('Media access error:', err);
    return res.status(500).send('Server Error');
  }
}

// New URL structure: /uploads/organizations/:orgId/*
// This serves files from data/uploads/organizations/{orgId}/ (via Docker volume mount)
// Note: this must be registered BEFORE the static middleware.
app.get('/uploads/organizations/:orgId/*', async (req, res) => {
  return serveOrgMedia(req, res, false);
});

// Legacy URL structure: /media/organizations/:orgId/*
// For backward compatibility with existing database URLs
// First tries new location, falls back to old location
app.get('/media/organizations/:orgId/*', async (req, res) => {
  return serveOrgMedia(req, res, true);
});

// Static files (CSS/JS/images)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rate limiting for specific endpoints
app.use('/login', loginLimiter);
app.use('/register', authLimiter);
app.use('/forgot-password', authLimiter);
app.use('/reset-password', authLimiter);

// Routes
if (setup) {
  app.use(setup.setupGate);
  app.use('/setup', setup.createSetupRouter());
}
app.use('/', authRoutes);
app.use('/', emailPreferenceRoutes);
app.use('/dashboard', dashboardRoutes);

// Public API (for external integrations via API_URL subdomain)
// Mounted at /api/v1 - accessible only via API key
// Rate limiting is handled inside publicApiRoutes AFTER API key validation (per organization)
// IMPORTANT: This must be BEFORE /api routes to prevent /api catching /api/v1 requests
app.use('/api/v1', publicApiRoutes);

// Internal API (requires session authentication)
// Uses authenticated rate limit (more generous)
app.use('/api', authenticatedApiLimiter, apiRoutes);

// Redirect root to dashboard
app.get('/', (req, res) => {
  if (req.session?.user) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// Health check (public)
app.get('/health', async (req, res) => {
  try {
    // Check database
    await pool.query('SELECT 1');
    // Check Redis
    await redis.ping();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      services: {
        database: 'connected',
        redis: 'connected'
      }
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: err.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('pages/error', {
    title: 'Page Not Found',
    message: 'The page you are looking for does not exist.',
    code: 404,
    user: req.session?.user,
    organization: req.session?.organization
  });
});

// Error handler
// Upload limits (multer): a clear answer instead of a server error. The
// browser checks sizes first; this catches requests that skip that check.
app.use((err, req, res, next) => {
  if (err?.name !== 'MulterError') return next(err);
  const tooLarge = err.code === 'LIMIT_FILE_SIZE';
  const status = tooLarge ? 413 : 400;
  const message = req.t(tooLarge ? 'errors.upload_too_large' : 'errors.upload_failed');
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(status).json({ success: false, code: err.code, error: message });
  }
  return res.status(status).render('pages/error', { title: message, message, code: status });
});

app.use((err, req, res, _next) => {
  logger.error({ err, reqId: req.id, path: req.path }, 'Server error');
  res.status(500).render('pages/error', {
    title: 'Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred.',
    code: 500,
    user: req.session?.user,
    organization: req.session?.organization
  });
});

// Connect to Redis and start server
async function start() {
  try {
    await redis.connect();
    console.log('🔴 Redis connected');
    
    // Test database connection
    await pool.query('SELECT NOW()');
    console.log('📦 Database connected');
    
    // Community Edition: the one organization always runs on the unlimited community tier
    if (isCommunity()) {
      const moved = await ensureCommunityTier();
      console.log(`🏠 Community Edition${moved ? ` (moved ${moved} organization(s) to the community tier)` : ''}`);
      const { isSetupCompleted, announceSetup } = await import('./setup/setup.js');
      if (!(await isSetupCompleted())) await announceSetup();
    }
    
    // Initialize help documentation cache
    try {
      const helpDocsCount = await initHelpCache();
      console.log(`📚 Help docs loaded: ${helpDocsCount} documents`);
    } catch (helpErr) {
      console.warn('⚠️ Help docs not loaded:', helpErr.message);
    }
    
    // Initialize default demo journeys for onboarding
    try {
      await initializeDefaultDemoJourneys();
      console.log('🎓 Demo journeys initialized');
    } catch (demoErr) {
      console.warn('⚠️ Demo journeys not initialized:', demoErr.message);
    }
    
    // Preload player locales for extended language support
    try {
      preloadPlayerLocales();
    } catch (localeErr) {
      console.warn('⚠️ Player locales not preloaded:', localeErr.message);
    }
    
    app.listen(PORT, '0.0.0.0', () => {
      // Show worker ID if running in cluster mode
      const workerId = process.env.WORKER_ID;
      const workerInfo = workerId !== undefined ? ` (Worker ${workerId})` : '';
      
      console.log(`\n🚀 Gryffi server running on port ${PORT}${workerInfo}`);
      console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🌐 URL: http://localhost:${PORT}\n`);
      
      // Start background scheduler for periodic tasks (Google sync, etc.)
      // Skip if running as a cluster worker (scheduler runs on primary)
      if (process.env.SKIP_SCHEDULER !== 'true') {
        startScheduler();
      }
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

start();

