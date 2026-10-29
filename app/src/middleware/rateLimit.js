/**
 * Rate Limiting Middleware - Gryffi
 * 
 * Protects against DDoS and brute force attacks while allowing
 * legitimate high-volume usage (e.g., 4000 employees from same corporate IP)
 * 
 * Limits per 15 minutes per IP:
 * - Global: 3000 requests (generous for corporate networks)
 * - Login: 50 requests (additional layer, already has brute-force protection)
 * - Invalid tokens: 100 requests (detects bots trying random tokens)
 * - Unauthenticated API: 200 requests
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';
import { sendEmail } from '../services/email.js';
import { getOpsAlertEmail } from '../utils/opsAlerts.js';

// Create a dedicated Redis client for rate limiting
// This avoids conflicts with the main redis client used for sessions
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const rateLimitRedis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  keyPrefix: 'ratelimit:'
});

rateLimitRedis.on('error', (err) => {
  console.error('[Rate Limit] Redis error:', err.message);
});

// Configuration
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Track if we've sent an alert recently (prevent alert spam)
const recentAlerts = new Map();
const ALERT_COOLDOWN = 60 * 60 * 1000; // 1 hour between alerts for same IP

// ============================================
// INTERNAL IP WHITELIST
// ============================================
// Skip rate limiting for internal/Docker IPs (server-to-server traffic
// between our own containers such as parser, nudenet, or maintenance jobs).
// These are IPs that originate from the server itself, not the internet.
const INTERNAL_IP_RANGES = [
  /^172\.1[6-9]\./,     // Docker bridge network (172.16.x.x - 172.19.x.x)
  /^172\.2[0-9]\./,     // Docker bridge network (172.20.x.x - 172.29.x.x)
  /^172\.3[0-1]\./,     // Docker bridge network (172.30.x.x - 172.31.x.x)
  /^10\./,              // Private network 10.x.x.x
  /^192\.168\./,        // Private network 192.168.x.x
  /^127\./,             // Localhost
  /^::1$/,              // IPv6 localhost
  /^fc00:/,             // IPv6 private
  /^fe80:/,             // IPv6 link-local
];

/**
 * Check if an IP is internal/whitelisted (skip rate limiting)
 */
function isInternalIp(ip) {
  if (!ip) return false;
  return INTERNAL_IP_RANGES.some(pattern => pattern.test(ip));
}

/**
 * Send alert email when rate limit is exceeded
 */
async function sendRateLimitAlert(ip, endpoint, limit, windowMinutes) {
  const alertKey = `${ip}:${endpoint}`;
  const lastAlert = recentAlerts.get(alertKey);
  
  // Don't spam alerts - max 1 per hour per IP/endpoint combination
  if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN) {
    console.log(`[Rate Limit] Alert suppressed for ${ip} (cooldown active)`);
    return;
  }
  
  recentAlerts.set(alertKey, Date.now());
  
  // Clean up old entries periodically
  if (recentAlerts.size > 1000) {
    const now = Date.now();
    for (const [key, time] of recentAlerts.entries()) {
      if (now - time > ALERT_COOLDOWN) {
        recentAlerts.delete(key);
      }
    }
  }
  
  const timestamp = new Date().toLocaleString('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    dateStyle: 'full',
    timeStyle: 'medium'
  });
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: #dc2626; color: white; padding: 24px; }
    .header h1 { margin: 0; font-size: 20px; }
    .content { padding: 24px; }
    .info-row { display: flex; padding: 12px 0; border-bottom: 1px solid #eee; }
    .info-label { font-weight: 600; color: #666; width: 140px; }
    .info-value { color: #333; }
    .footer { padding: 16px 24px; background: #f9f9f9; font-size: 12px; color: #666; }
    .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; margin-top: 16px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚠️ Rate Limit Overschreden</h1>
    </div>
    <div class="content">
      <p>Een IP-adres heeft de rate limit overschreden op de Gryffi webapp.</p>
      
      <div class="info-row">
        <span class="info-label">IP Adres:</span>
        <span class="info-value"><strong>${ip}</strong></span>
      </div>
      <div class="info-row">
        <span class="info-label">Endpoint:</span>
        <span class="info-value">${endpoint}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Limiet:</span>
        <span class="info-value">${limit} requests per ${windowMinutes} minuten</span>
      </div>
      <div class="info-row">
        <span class="info-label">Tijdstip:</span>
        <span class="info-value">${timestamp}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Server:</span>
        <span class="info-value">${process.env.APP_URL || 'unknown'}</span>
      </div>
      
      <div class="warning">
        <strong>Mogelijke oorzaken:</strong>
        <ul style="margin: 8px 0 0 0; padding-left: 20px;">
          <li>Legitiem hoog gebruik (grote organisatie)</li>
          <li>Bot of scraper</li>
          <li>DDoS aanval poging</li>
          <li>Misconfiguratie bij klant</li>
        </ul>
      </div>
    </div>
    <div class="footer">
      Dit is een automatisch beveiligingsbericht van Gryffi.<br>
      Je ontvangt maximaal 1 alert per uur per IP/endpoint combinatie.
    </div>
  </div>
</body>
</html>`;

  const alertEmail = getOpsAlertEmail();
  if (!alertEmail) {
    console.warn(`[Rate Limit] Limit exceeded for IP ${ip} on ${endpoint}; OPS_ALERT_EMAIL is not set, so no alert email`);
    return;
  }

  try {
    await sendEmail({
      to: alertEmail,
      subject: `[Gryffi Security] Rate Limit Overschreden - ${ip}`,
      customHtml: html
    });
    console.log(`[Rate Limit] Alert sent for IP ${ip} on ${endpoint}`);
  } catch (err) {
    console.error('[Rate Limit] Failed to send alert email:', err.message);
  }
}

/**
 * Get client IP address.
 * Uses req.ip, which Express derives from X-Forwarded-For with
 * 'trust proxy' = 1: the address nginx appended, not one the client sent.
 * Never read X-Forwarded-For directly: its first entry is client-controlled.
 */
function getClientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  // Normalize IPv4-mapped IPv6 (::ffff:172.18.0.5) so internal ranges match
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Create a rate limiter with Redis store
 */
function createLimiter(options) {
  const {
    windowMs = WINDOW_MS,
    max,
    keyPrefix,
    endpoint,
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
    skip = () => false,
    skipInternalIps = true,  // By default, skip rate limiting for internal IPs
    keySuffix = null         // Optional (req) => string, e.g. the journey token
  } = options;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false,
    
    // Use Redis for distributed rate limiting
    store: new RedisStore({
      sendCommand: (...args) => rateLimitRedis.call(...args),
      prefix: `rl:${keyPrefix}:`
    }),
    
    // Custom key generator - use IP address (plus an optional suffix)
    keyGenerator: (req) => {
      const ipKey = ipKeyGenerator(getClientIp(req));
      return keySuffix ? `${ipKey}:${keySuffix(req)}` : ipKey;
    },
    
    // Skip certain requests (including internal IPs for server-to-server traffic between containers)
    skip: (req) => {
      const ip = getClientIp(req);
      
      // Skip if internal IP and skipInternalIps is enabled
      if (skipInternalIps && isInternalIp(ip)) {
        return true;
      }
      
      // Also check custom skip function
      return skip(req);
    },
    skipSuccessfulRequests,
    skipFailedRequests,
    
    // Handler when limit is exceeded
    handler: async (req, res) => {
      const ip = getClientIp(req);
      const windowMinutes = Math.round(windowMs / 60000);
      
      console.warn(`[Rate Limit] BLOCKED: IP ${ip} exceeded ${max} requests on ${endpoint}`);
      
      // Send alert email (async, don't wait)
      sendRateLimitAlert(ip, endpoint, max, windowMinutes).catch(() => {});
      
      // Return appropriate response
      res.status(429).json({
        success: false,
        error: 'Too many requests',
        message: `Rate limit exceeded. Please try again in ${windowMinutes} minutes.`,
        retryAfter: Math.ceil(windowMs / 1000)
      });
    },
    
    // Message for HTML responses
    message: {
      success: false,
      error: 'Too many requests',
      message: 'Please try again later.'
    }
  });
}

// ============================================
// RATE LIMITERS
// ============================================

/**
 * Global rate limiter - very generous for corporate networks
 * 3000 requests per 15 minutes per IP
 */
export const globalLimiter = createLimiter({
  max: 3000,
  keyPrefix: 'global',
  endpoint: 'Global'
});

/**
 * Login rate limiter - moderate limit
 * 50 requests per 15 minutes per IP
 * Note: Login already has brute-force protection, this is additional layer
 */
export const loginLimiter = createLimiter({
  max: 50,
  keyPrefix: 'login',
  endpoint: 'Login (/login)'
});

/**
 * Auth pages rate limiter (register, forgot-password, etc.)
 * 30 requests per 15 minutes per IP
 */
export const authLimiter = createLimiter({
  max: 30,
  keyPrefix: 'auth',
  endpoint: 'Auth pages'
});

/**
 * Magic link rate limiter - very generous for legitimate corporate use
 * 10000 requests per 15 minutes per IP
 * 
 * Rationale: Large companies (4000+ employees) may all access via single corporate IP
 * when a journey invitation is sent. Brute-force protection is handled separately
 * via invalid token tracking (100 failed attempts = block).
 * 
 * This limit only blocks extreme abuse (bot hammering with valid/invalid tokens)
 */
export const magicLinkLimiter = createLimiter({
  max: 10000,
  keyPrefix: 'magiclink',
  endpoint: 'Magic Links (/e/:token)'
});

/**
 * Failed Public API authentications per IP. Runs before the API key check,
 * which costs a bcrypt compare per organization with a key; successful
 * requests do not count.
 */
export const publicApiAuthFailureLimiter = createLimiter({
  max: 30,
  keyPrefix: 'public-api-authfail',
  endpoint: 'Public API authentication failures',
  skipSuccessfulRequests: true
});

/**
 * AI calls from the journey player (guide chat and opening). Keyed on IP plus
 * journey token: many employees of one company often share an office IP.
 */
export const playerAiLimiter = createLimiter({
  max: 120,
  keyPrefix: 'player-ai',
  endpoint: 'Player AI chat',
  keySuffix: (req) => String(req.params.token || '').slice(0, 64)
});

/**
 * Text-to-speech from the journey player. Called per text block and mostly
 * served from cache, so the limit is higher than for chat.
 */
export const playerTtsLimiter = createLimiter({
  max: 600,
  keyPrefix: 'player-tts',
  endpoint: 'Player TTS',
  keySuffix: (req) => String(req.params.token || '').slice(0, 64)
});

/**
 * Invalid token tracker - stricter limit for failed attempts
 * This specifically catches bots trying random tokens
 * 100 failed attempts per 15 minutes per IP
 */
const invalidTokenCount = new Map();
const INVALID_TOKEN_LIMIT = 100;
const INVALID_TOKEN_WINDOW = WINDOW_MS;

export function trackInvalidToken(req) {
  const ip = getClientIp(req);
  const key = `invalid:${ip}`;
  const now = Date.now();
  
  // Get or create counter
  let data = invalidTokenCount.get(key);
  if (!data || now - data.windowStart > INVALID_TOKEN_WINDOW) {
    data = { count: 0, windowStart: now };
  }
  
  data.count++;
  invalidTokenCount.set(key, data);
  
  // Clean up old entries periodically
  if (invalidTokenCount.size > 10000) {
    for (const [k, v] of invalidTokenCount.entries()) {
      if (now - v.windowStart > INVALID_TOKEN_WINDOW) {
        invalidTokenCount.delete(k);
      }
    }
  }
  
  // Check if limit exceeded
  if (data.count >= INVALID_TOKEN_LIMIT) {
    console.warn(`[Rate Limit] IP ${ip} exceeded invalid token limit (${data.count} attempts)`);
    
    // Send alert on first exceed
    if (data.count === INVALID_TOKEN_LIMIT) {
      sendRateLimitAlert(ip, 'Invalid Magic Links', INVALID_TOKEN_LIMIT, 15).catch(() => {});
    }
    
    return true; // Blocked
  }
  
  return false; // Allowed
}

export function isInvalidTokenBlocked(req) {
  const ip = getClientIp(req);
  const key = `invalid:${ip}`;
  const now = Date.now();
  
  const data = invalidTokenCount.get(key);
  if (!data || now - data.windowStart > INVALID_TOKEN_WINDOW) {
    return false;
  }
  
  return data.count >= INVALID_TOKEN_LIMIT;
}

/**
 * Unauthenticated API rate limiter
 * 200 requests per 15 minutes per IP
 */
export const unauthenticatedApiLimiter = createLimiter({
  max: 200,
  keyPrefix: 'unauth-api',
  endpoint: 'Unauthenticated API'
});

/**
 * Authenticated API rate limiter - more generous
 * 1000 requests per 15 minutes per IP
 */
export const authenticatedApiLimiter = createLimiter({
  max: 1000,
  keyPrefix: 'auth-api',
  endpoint: 'Authenticated API'
});

/**
 * Public API rate limiter - per organization (API key)
 * 5000 requests per 15 minutes per organization
 * 
 * This limiter is applied AFTER API key validation, so req.organizationId is available.
 * Rate limiting per organization instead of per IP allows:
 * - Large customers to make bulk operations (e.g., importing 1000 users)
 * - Fair usage: each customer gets their own quota
 * - Better protection: leaked API key only affects that organization
 */
export const publicApiLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  
  // Use Redis for distributed rate limiting
  store: new RedisStore({
    sendCommand: (...args) => rateLimitRedis.call(...args),
    prefix: 'rl:public-api:'
  }),
  
  // Key by organization ID (set by API key middleware), fallback to IP
  keyGenerator: (req) => {
    // If API key was validated, use organization ID
    if (req.organizationId) {
      return `org:${req.organizationId}`;
    }
    // Fallback to IP for unauthenticated requests (will get 401 anyway)
    return `ip:${ipKeyGenerator(getClientIp(req))}`;
  },
  
  // Handler when limit is exceeded
  handler: async (req, res) => {
    const orgId = req.organizationId;
    const orgName = req.organization?.name || 'Unknown';
    const windowMinutes = Math.round(WINDOW_MS / 60000);
    
    console.warn(`[Rate Limit] BLOCKED: Organization ${orgName} (${orgId}) exceeded 5000 requests on Public API`);
    
    // Send alert email (async, don't wait)
    sendRateLimitAlert(
      `Organization: ${orgName} (${orgId})`, 
      'Public API (/api/v1)', 
      5000, 
      windowMinutes
    ).catch(() => {});
    
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      message: `Your organization has exceeded the API rate limit of 5000 requests per ${windowMinutes} minutes. Please try again later.`,
      retry_after_seconds: Math.ceil(WINDOW_MS / 1000)
    });
  }
});

// Export helpers
export { getClientIp, isInternalIp };

export default {
  globalLimiter,
  loginLimiter,
  authLimiter,
  magicLinkLimiter,
  unauthenticatedApiLimiter,
  authenticatedApiLimiter,
  publicApiLimiter,
  playerAiLimiter,
  playerTtsLimiter,
  publicApiAuthFailureLimiter,
  trackInvalidToken,
  isInvalidTokenBlocked,
  getClientIp,
  isInternalIp
};
