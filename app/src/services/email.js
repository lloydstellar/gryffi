/**
 * Nuntly Email Service - Gryffi
 * Clean, simple email sending via Nuntly API (EU-based)
 * 
 * Supports custom themes for Tier 3+ organizations:
 * - Custom logo replacement
 * - Custom brand colors (primary, accent, background)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/index.js';
import { getAppBaseUrl } from '../utils/appUrl.js';
import nodemailer from 'nodemailer';
import { getSetting, getSettings } from './settings.js';
import { isCloud } from '../edition.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NUNTLY_API_URL = 'https://api.nuntly.com/emails';

// Default Gryffi brand colors
const DEFAULT_THEME = {
  primary: '#0b4b34',
  accent: '#78c503',
  background: '#ecf2eb',
  logoUrl: null, // Will use default Gryffi logo
  isCustom: false
};

// ---------------------------------------------------------------------------
// Unsubscribe / List-Unsubscribe helpers
// ---------------------------------------------------------------------------
// Even on transactional mail, a small unsubscribe affordance + the
// List-Unsubscribe header improves Gmail/Outlook deliverability and gives
// recipients a clear escape hatch. Mailto-only (no one-click POST) is
// intentional: we keep handling on our side.

const UNSUBSCRIBE_EMAIL = 'unsubscribe@gryffi.com';

const UNSUBSCRIBE_LABELS = {
  en: 'Unsubscribe',
  nl: 'Afmelden',
  de: 'Abmelden',
  fr: 'Se désinscrire',
  es: 'Cancelar suscripción',
  it: 'Annulla iscrizione',
  pt: 'Cancelar inscrição',
  da: 'Afmeld',
  no: 'Avmeld',
  fi: 'Peruuta tilaus',
  sv: 'Avregistrera',
  pl: 'Wypisz się',
  ro: 'Dezabonează-te',
  tr: 'Aboneliği iptal et'
};

// Build the mailto: target. The "to" address defaults to the central
// unsubscribe inbox, but invite-style emails route the request directly to the
// maker who triggered the invite so end users can simply ask the human who
// added them.
function buildUnsubscribeMailto(recipient, unsubscribeEmail = UNSUBSCRIBE_EMAIL) {
  const target = unsubscribeEmail || UNSUBSCRIBE_EMAIL;
  const subject = recipient ? `Unsubscribe ${recipient}` : 'Unsubscribe';
  return `mailto:${target}?subject=${encodeURIComponent(subject)}`;
}

// The visible footer link: an HTTPS one-click page when the caller provides
// one (lifecycle emails), otherwise the mailto fallback.
function buildUnsubscribeHref(recipient, unsubscribeEmail = UNSUBSCRIBE_EMAIL, unsubscribeUrl = null) {
  return unsubscribeUrl || buildUnsubscribeMailto(recipient, unsubscribeEmail);
}

function buildUnsubscribeFooterHtml(recipient, language = 'en', unsubscribeEmail = UNSUBSCRIBE_EMAIL, unsubscribeUrl = null) {
  const label = UNSUBSCRIBE_LABELS[language] || UNSUBSCRIBE_LABELS.en;
  const href = buildUnsubscribeHref(recipient, unsubscribeEmail, unsubscribeUrl);
  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin: 12px auto 0 auto;">
    <tr>
      <td align="center" style="padding: 4px 20px;">
        <a href="${href}" style="color: #94a3b8; text-decoration: underline; font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">${label}</a>
      </td>
    </tr>
  </table>`;
}

function buildUnsubscribeFooterText(recipient, language = 'en', unsubscribeEmail = UNSUBSCRIBE_EMAIL, unsubscribeUrl = null) {
  const label = UNSUBSCRIBE_LABELS[language] || UNSUBSCRIBE_LABELS.en;
  return `${label}: ${buildUnsubscribeHref(recipient, unsubscribeEmail, unsubscribeUrl)}`;
}

// Inject the unsubscribe block into outgoing HTML just before </body>.
// Idempotent: skip when an unsubscribe link is already present so we never
// stack two footers on top of each other (covers both the central address and
// any per-mail override).
function injectUnsubscribeIntoHtml(html, recipient, language = 'en', unsubscribeEmail = UNSUBSCRIBE_EMAIL, unsubscribeUrl = null) {
  if (!html) return html;
  const target = unsubscribeEmail || UNSUBSCRIBE_EMAIL;
  if (html.includes(target) || html.includes(UNSUBSCRIBE_EMAIL) || (unsubscribeUrl && html.includes(unsubscribeUrl))) return html;
  const footer = buildUnsubscribeFooterHtml(recipient, language, target, unsubscribeUrl);
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${footer}\n</body>`);
  }
  return html + footer;
}

// Best-effort HTML to plain-text conversion. Used as a fallback when a caller
// only provides customHtml (no customBody / customText), so the multipart
// alternative isn't effectively empty — empty text parts are a strong spam
// signal (see SpamAssassin MPART_ALT_DIFF).
function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded pattern (<br\s*/?>) with no nested quantifiers, linear time
    .replace(/<br\s*\/?>(\r?\n)?/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Get email theme for an organization
 * Returns custom theme colors and logo for Tier 3+ orgs with active custom theme
 * Returns default Gryffi theme for Tier 1-2 or orgs using default theme
 */
export async function getOrganizationEmailTheme(orgId) {
  if (!orgId) {
    return DEFAULT_THEME;
  }
  
  try {
    // Get organization's tier and active theme in one query
    const result = await query(`
      SELECT 
        o.id,
        o.active_theme_id,
        st.name as tier_name,
        st.custom_branding,
        t.id as theme_id,
        t.name as theme_name,
        t.logo_url,
        t.tokens,
        t.is_preset,
        t.preset_key
      FROM organizations o
      JOIN subscription_tiers st ON o.subscription_tier_id = st.id
      LEFT JOIN themes t ON o.active_theme_id = t.id
      WHERE o.id = $1
    `, [orgId]);
    
    if (result.rows.length === 0) {
      return DEFAULT_THEME;
    }
    
    const org = result.rows[0];
    
    // Custom themes are a tier feature (custom_branding)
    if (!org.custom_branding) {
      return DEFAULT_THEME;
    }
    
    // No active theme set - use default
    if (!org.active_theme_id || !org.theme_id) {
      return DEFAULT_THEME;
    }
    
    // Check if it's the Gryffi Default preset - use default theme
    if (org.is_preset && org.preset_key === 'gryffi-default') {
      return DEFAULT_THEME;
    }
    
    // Parse theme tokens
    const tokens = typeof org.tokens === 'string' 
      ? JSON.parse(org.tokens) 
      : (org.tokens || {});
    
    // Build custom theme with fallbacks to default
    return {
      primary: tokens.primary || DEFAULT_THEME.primary,
      accent: tokens.accent || DEFAULT_THEME.accent,
      background: tokens.background || DEFAULT_THEME.background,
      logoUrl: org.logo_url || null, // Custom logo URL or null for default
      isCustom: true
    };
    
  } catch (err) {
    console.error('[Email] Failed to get organization theme:', err);
    return DEFAULT_THEME;
  }
}

// Cache for loaded locales
const localeCache = {};

/**
 * Load email template translations for a specific language
 */
function getEmailTranslations(language = 'en') {
  const lang = language || 'en';
  
  if (localeCache[lang]) {
    return localeCache[lang];
  }
  
  try {
    const localePath = path.join(__dirname, '../../locales', `${lang}.json`);
    const localeData = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    localeCache[lang] = localeData.emailTemplate || {};
    return localeCache[lang];
  } catch (_err) {
    console.warn(`[Email] Could not load locale ${lang}, falling back to English`);
    if (lang !== 'en') {
      return getEmailTranslations('en');
    }
    return {
      greeting: 'Hello',
      partOfJourney: 'Part of your journey',
      sentVia: 'Sent via',
      poweredBy: 'Powered by',
      interactiveJourneyBuilder: 'Interactive Journey Builder',
      emailSentVia: 'This email was sent via',
      partOf: 'Part of',
      clickHere: 'Click here'
    };
  }
}

// Email template definitions
const EMAIL_TEMPLATES = {
  // System emails
  welcome: {
    name: 'Welcome Message',
    subject: 'Welcome to {company_name}!',
    description: 'Send a welcome message to new employees'
  },
  password_reset: {
    name: 'Password Reset',
    subject: 'Reset your password',
    description: 'Email with link to reset password'
  },
  verification: {
    name: 'Email Verification',
    subject: 'Verify your email address',
    description: 'Verification email for new accounts'
  },
  
  // Journey emails
  journey_info: {
    name: 'Information',
    subject: 'Important information about {journey_title}',
    body: `We wanted to share some important information with you as part of your {journey_title} journey.

Please take a moment to review the details below and let us know if you have any questions.

We're here to help you succeed!`,
    description: 'Share important information with the employee'
  },
  journey_confirmation: {
    name: 'Confirmation',
    subject: 'Confirmed: {journey_title}',
    body: `Great news! We're confirming that you have successfully completed this step in your {journey_title} journey.

Keep up the great work! You're making excellent progress.

If you have any questions, don't hesitate to reach out.`,
    description: 'Confirm an action or completion'
  },
  journey_reminder: {
    name: 'Reminder',
    subject: 'Friendly reminder: {journey_title}',
    body: `Just a friendly reminder about your {journey_title} journey.

There are still some steps waiting for you to complete. Taking a few minutes now will help you stay on track.

We're here to support you every step of the way!`,
    description: 'Send a friendly reminder'
  },
  journey_credentials: {
    name: 'Login Credentials',
    subject: 'Your login credentials for {company_name}',
    body: `Welcome to {company_name}! Here are your login credentials to get started.

Please keep this information secure and change your password after your first login.

Username: [Your username will be provided]
Temporary password: [Your temporary password]

If you have any trouble logging in, please contact IT support.`,
    description: 'Share login credentials securely'
  },
  journey_welcome: {
    name: 'Welcome',
    subject: 'Welcome to {company_name}, {user_first_name}!',
    body: `We're thrilled to have you join us at {company_name}!

Your {journey_title} journey is ready to guide you through everything you need to know. Take your time, explore at your own pace, and don't hesitate to ask questions.

We're excited to have you on the team!`,
    description: 'Welcome new team members'
  },
  journey_completion: {
    name: 'Journey Complete',
    subject: 'Congratulations! You\'ve completed {journey_title}',
    body: `Amazing work, {user_first_name}! 🎉

You've successfully completed the {journey_title} journey. We hope you found it helpful and informative.

You're now ready to hit the ground running. Remember, we're always here if you need any support.

Welcome to the team!`,
    description: 'Celebrate journey completion'
  },
  journey_custom: {
    name: 'Custom',
    subject: '',
    body: '',
    description: 'Write your own email from scratch'
  }
};

// Available variables for templates
const TEMPLATE_VARIABLES = {
  user: [
    { key: 'user_name', label: 'Employee name', example: 'John Smith' },
    { key: 'user_email', label: 'Employee email', example: 'john@company.com' },
    { key: 'user_first_name', label: 'First name', example: 'John' }
  ],
  journey: [
    { key: 'journey_title', label: 'Journey title', example: 'Onboarding 2024' },
    { key: 'step_title', label: 'Current step', example: 'IT Setup' }
  ],
  company: [
    { key: 'company_name', label: 'Company name', example: 'Acme Corp' }
  ],
  custom: [
    { key: 'subject', label: 'Subject', example: 'Welcome!' },
    { key: 'custom_message', label: 'Custom message', example: '' },
    { key: 'custom_link', label: 'Link', example: 'https://...' },
    { key: 'custom_link_text', label: 'Link text', example: 'Click here' }
  ]
};

/**
 * Replace template variables with actual values
 * Supports both {variable} and {{variable}} syntax
 */
function replaceVariables(text, variables = {}) {
  if (!text) return '';
  
  let result = text;
  Object.entries(variables).forEach(([key, value]) => {
    // Replace {{variable}} format (double braces)
    // eslint-disable-next-line security/detect-non-literal-regexp -- keys are developer-defined template variable names, not user input
    const doubleRegex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(doubleRegex, value || '');
    // Replace {variable} format (single braces)
    // eslint-disable-next-line security/detect-non-literal-regexp -- keys are developer-defined template variable names, not user input
    const singleRegex = new RegExp(`\\{${key}\\}`, 'g');
    result = result.replace(singleRegex, value || '');
  });
  
  return result;
}

/**
 * Generate HTML email from template
 * Supports custom themes for Tier 3+ organizations
 * 
 * @param {string} templateType - Email template type
 * @param {object} variables - Template variables
 * @param {string} customBody - Custom body text
 * @param {string} customHtml - Full custom HTML (bypasses template)
 * @param {boolean} isHtmlBody - Whether customBody contains HTML
 * @param {string} language - Language code
 * @param {object} theme - Theme object with colors and logo
 */
function generateEmailHtml(templateType, variables = {}, customBody = '', customHtml = null, isHtmlBody = false, language = 'en', theme = null) {
  // Get translations for the email template
  const t = getEmailTranslations(language);
  
  // Use custom theme colors or default Gryffi colors
  const effectiveTheme = theme || DEFAULT_THEME;
  const bgColor = effectiveTheme.background;
  const primaryColor = effectiveTheme.primary;
  const accentColor = effectiveTheme.accent;
  const companyName = variables.company_name || 'Gryffi';
  
  // Add theme colors to variables for replacement in body content
  // This allows using {{primaryColor}} in email body HTML
  const enhancedVariables = {
    ...variables,
    primaryColor: primaryColor,
    accentColor: accentColor,
    bgColor: bgColor
  };
  
  // If custom HTML is provided, use it directly (with variable replacement including theme colors)
  if (customHtml) {
    return replaceVariables(customHtml, enhancedVariables);
  }
  
  // Logo URL - use custom logo if provided, otherwise default Gryffi logo
  // EMAIL_ASSETS_URL is used for email images (must be publicly accessible, even if APP_URL is IP-restricted)
  const appUrl = getAppBaseUrl();
  const emailAssetsUrl = process.env.EMAIL_ASSETS_URL || appUrl;
  const defaultLogoUrl = `${emailAssetsUrl}/images/logos/Logo---illustration-only-cropped-transparant.png`;
  
  // Handle logo URL - check if it's already a full URL or a relative path
  let logoUrl = defaultLogoUrl;
  if (effectiveTheme.logoUrl) {
    if (effectiveTheme.logoUrl.startsWith('http://') || effectiveTheme.logoUrl.startsWith('https://')) {
      // Already a full URL
      logoUrl = effectiveTheme.logoUrl;
    } else if (effectiveTheme.logoUrl.startsWith('/')) {
      // Relative path starting with /
      logoUrl = `${emailAssetsUrl}${effectiveTheme.logoUrl}`;
    } else {
      // Relative path without leading /
      logoUrl = `${emailAssetsUrl}/${effectiveTheme.logoUrl}`;
    }
  } else if (variables.logo_url) {
    logoUrl = variables.logo_url;
  }
  
  // Process body content - if isHtmlBody, use as-is; otherwise convert line breaks to paragraphs
  let bodyContent = '';
  if (customBody) {
    const processedBody = replaceVariables(customBody, enhancedVariables);
    if (isHtmlBody) {
      // Body is already HTML, use directly
      bodyContent = processedBody;
    } else {
      // Convert plain text to paragraphs
      bodyContent = processedBody
        .split('\n')
        .filter(line => line.trim())
        .map(line => `<p style="margin: 0 0 16px 0; line-height: 1.7; color: #334155;">${line.trim()}</p>`)
        .join('');
    }
  }
  
  // Generate CTA button if link provided
  const ctaButton = variables.custom_link ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin: 32px 0;">
      <tr>
        <td align="center">
          <a href="${variables.custom_link}" 
             style="display: inline-block; background: ${primaryColor}; color: white; 
                    padding: 14px 36px; border-radius: 8px; text-decoration: none; 
                    font-weight: 600; font-size: 15px; letter-spacing: 0.3px;
                    box-shadow: 0 2px 4px rgba(11, 75, 52, 0.2);">
            ${variables.custom_link_text || t.clickHere}
          </a>
        </td>
      </tr>
    </table>
  ` : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${replaceVariables(EMAIL_TEMPLATES[templateType]?.subject || 'Message', variables)}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: ${bgColor}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  
  <!-- Preheader text (hidden but shows in email preview) -->
  <div style="display: none; max-height: 0; overflow: hidden;">
    ${variables.preheader || replaceVariables(customBody || '', variables).replace(/<[^>]*>/g, '').substring(0, 100)}
  </div>
  
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: ${bgColor}; padding: 48px 20px;">
    <tr>
      <td align="center">
        
        <!-- Logo Section -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin-bottom: 24px;">
          <tr>
            <td align="center">
              <img src="${logoUrl}" alt="${companyName}" width="64" height="64" 
                   style="display: block; width: 64px; height: 64px; object-fit: contain;">
            </td>
          </tr>
        </table>
        
        <!-- Main Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(11, 75, 52, 0.08);">
          
          <!-- Accent Bar -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, ${primaryColor} 0%, ${accentColor} 100%);"></td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 36px 32px 36px;">
              
              <!-- Greeting -->
              ${variables.user_name ? `
                <p style="margin: 0 0 24px 0; color: ${primaryColor}; font-size: 18px; font-weight: 600;">
                  ${t.greeting} ${variables.user_first_name || variables.user_name},
                </p>
              ` : ''}
              
              <!-- Body Content -->
              <div style="font-size: 15px; line-height: 1.7;">
                ${bodyContent}
              </div>
              
              <!-- CTA Button -->
              ${ctaButton}
              
            </td>
          </tr>
          
          <!-- Divider -->
          <tr>
            <td style="padding: 0 36px;">
              <div style="height: 1px; background: #e2e8f0;"></div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 36px 32px 36px;">
              ${variables.journey_title ? `
                <p style="margin: 0 0 8px 0; color: #64748b; font-size: 13px; text-align: center;">
                  ${t.partOfJourney}: <strong>${variables.journey_title}</strong>
                </p>
              ` : ''}
              <p style="margin: 0; color: #94a3b8; font-size: 12px; text-align: center;">
                ${t.sentVia} ${companyName}
              </p>
            </td>
          </tr>
          
        </table>
        
        <!-- Bottom Footer -->
        <!-- powered-by:start -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin-top: 24px;">
          <tr>
            <td align="center">
              <p style="margin: 0; color: #64748b; font-size: 11px;">
                ${t.poweredBy} <span style="color: ${primaryColor}; font-weight: 500;">Gryffi</span> · ${t.interactiveJourneyBuilder}
              </p>
            </td>
          </tr>
        </table>
        <!-- powered-by:end -->
        
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Generate plain text version of email
 */
function generateEmailText(variables = {}, customBody = '', language = 'en') {
  const t = getEmailTranslations(language);
  const companyName = variables.company_name || 'Gryffi';
  let text = '';
  
  if (variables.user_name) {
    text += `${t.greeting} ${variables.user_first_name || variables.user_name},\n\n`;
  }
  
  text += replaceVariables(customBody, variables);
  
  if (variables.custom_link) {
    text += `\n\n${variables.custom_link_text || t.clickHere}: ${variables.custom_link}`;
  }
  
  text += `\n\n---\n${t.emailSentVia} ${companyName}`;
  
  if (variables.journey_title) {
    text += `\n${t.partOf}: ${variables.journey_title}`;
  }
  
  return text;
}

/**
 * Send an email via Nuntly API
 * 
 * @param {object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.templateType - Template type
 * @param {object} options.variables - Template variables
 * @param {string} options.customBody - Custom body text
 * @param {string} options.customHtml - Full custom HTML
 * @param {string} options.customText - Optional crafted plain-text body. When
 *   omitted we derive one from customBody (preferred) or strip customHtml as a
 *   safety net so the multipart/alternative text part is never effectively
 *   empty.
 * @param {string} options.replyTo - Reply-to address
 * @param {boolean} options.isHtmlBody - Whether customBody is HTML
 * @param {string} options.language - Language code
 * @param {string} options.orgId - Organization ID for custom theme support
 * @param {Array} options.attachments - Array of attachments with filename, content (Base64), and contentType
 * @param {string} options.unsubscribeEmail - Optional override for the
 *   unsubscribe destination (mailto + List-Unsubscribe header). Defaults to
 *   the central unsubscribe address; invite-style emails override this with
 *   the inviting maker's address so recipients can ask the human directly.
 * @param {string} options.unsubscribeUrl - Optional HTTPS one-click unsubscribe
 *   page. When given, the footer links there and the RFC 8058
 *   List-Unsubscribe-Post header is added (used by lifecycle emails).
 * @param {string} options.from - Optional sender override, e.g. a personal
 *   sender for lifecycle emails. Defaults to NUNTLY_FROM_EMAIL.
 * @param {string} options.idempotencyKey - Optional key so a retried request
 *   never results in a duplicate email (Nuntly deduplicates on it).
 */
const RESERVED_TEST_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);
const RESERVED_TEST_TLDS = new Set(['test', 'invalid', 'localhost', 'example']);

/**
 * Sender address for mail that does not set its own.
 * @returns {Promise<string>} The email.from setting (NUNTLY_FROM_EMAIL in Gryffi Cloud)
 */
export async function getDefaultFromAddress() {
  return getSetting('email.from');
}

const EMAIL_SETTING_KEYS = ['email.provider', 'email.nuntlyApiKey', 'email.smtpHost', 'email.smtpPort',
  'email.smtpSecurity', 'email.smtpUser', 'email.smtpPassword'];

/**
 * Whether mail can be sent with the configured provider.
 * @returns {Promise<boolean>}
 */
export async function isEmailConfigured() {
  const s = await getSettings(EMAIL_SETTING_KEYS);
  return s['email.provider'] === 'smtp' ? !!s['email.smtpHost'] : !!s['email.nuntlyApiKey'];
}

// One SMTP transport per configuration, rebuilt when the settings change
let smtpTransport = null;
let smtpTransportKey = null;

/**
 * Build a nodemailer transport from SMTP settings.
 * @param {Object} smtp - host, port, security ('starttls' | 'tls' | 'none'), user, password
 */
export function createSmtpTransport({ host, port, security, user, password }) {
  return nodemailer.createTransport({
    host,
    port,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    auth: user ? { user, pass: password || '' } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000
  });
}

function smtpSettings(s) {
  return {
    host: s['email.smtpHost'],
    port: s['email.smtpPort'],
    security: s['email.smtpSecurity'],
    user: s['email.smtpUser'],
    password: s['email.smtpPassword']
  };
}

function getSmtpTransport(s) {
  const config = smtpSettings(s);
  const key = JSON.stringify(config);
  if (!smtpTransport || smtpTransportKey !== key) {
    smtpTransport?.close();
    smtpTransport = createSmtpTransport(config);
    smtpTransportKey = key;
  }
  return smtpTransport;
}

/**
 * Hand a rendered message to the configured provider: Nuntly (HTTP API) or SMTP.
 * @param {Object} message - from, to, subject, html, text, headers, replyTo, attachments (base64 content)
 * @param {{idempotencyKey?: string|null}} [options] - Nuntly only
 * @returns {Promise<string|null>} The provider's message id
 */
async function deliverEmail(message, { idempotencyKey = null } = {}) {
  const s = await getSettings(EMAIL_SETTING_KEYS);

  if (s['email.provider'] === 'smtp') {
    if (!s['email.smtpHost']) throw new Error('Email service not configured');
    const info = await getSmtpTransport(s).sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
      replyTo: message.replyTo || undefined,
      attachments: message.attachments?.map((att) => ({
        filename: att.filename,
        content: att.content,
        encoding: 'base64',
        ...(att.contentType && { contentType: att.contentType })
      }))
    });
    return info.messageId || null;
  }

  const apiKey = s['email.nuntlyApiKey'];
  if (!apiKey) throw new Error('Email service not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(NUNTLY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey })
      },
      signal: controller.signal,
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
        ...(message.replyTo && { replyTo: message.replyTo }),
        ...(message.attachments && { attachments: message.attachments })
      })
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json();
  if (!response.ok) {
    console.error('[Email] API error:', data);
    throw new Error(data.error?.details || data.error?.title || 'Failed to send email');
  }
  return data.data?.id || data.id || null;
}

/**
 * True when every recipient is on a reserved test domain (RFC 2606)
 * @param {string|string[]} to - Recipient(s), optionally as "Name <address>"
 */
function isReservedTestAddress(to) {
  const list = (Array.isArray(to) ? to : [to]).map(String);
  return list.length > 0 && list.every((entry) => {
    const address = (entry.match(/<([^>]+)>/)?.[1] || entry).trim().toLowerCase();
    const domain = address.split('@')[1] || '';
    const tld = domain.split('.').pop();
    return RESERVED_TEST_DOMAINS.has(domain) || [...RESERVED_TEST_DOMAINS].some(d => domain.endsWith('.' + d)) || RESERVED_TEST_TLDS.has(tld);
  });
}

export async function sendEmail({
  to,
  subject,
  templateType = 'journey_custom',
  variables = {},
  customBody = '',
  customHtml = null,
  customText = null,
  replyTo = null,
  isHtmlBody = false,
  language = 'en',
  orgId = null,
  attachments = null,
  unsubscribeEmail = null,
  unsubscribeUrl = null,
  from = null,
  idempotencyKey = null
}) {
  const fromEmail = from || await getDefaultFromAddress();
  
  if (!(await isEmailConfigured())) {
    console.error('[Email] No email provider configured');
    throw new Error('Email service not configured');
  }
  
  if (!to) {
    throw new Error('Recipient email required');
  }
  
  const { html, text, subject: processedSubject, headers: extraHeaders } = await renderEmail({
    to, subject, templateType, variables, customBody, customHtml, customText,
    isHtmlBody, language, orgId, unsubscribeEmail, unsubscribeUrl
  });

  // Reserved test domains (RFC 2606) can never receive mail: log instead of
  // sending, so test accounts do not cause bounces on our sending domain.
  if (isReservedTestAddress(to)) {
    console.log(`[Email] Not sent, reserved test address: ${to} (${processedSubject})`);
    return { success: true, emailId: null, to, subject: processedSubject, skipped: 'reserved_test_domain' };
  }
  
  const emailAttachments = Array.isArray(attachments) && attachments.length > 0
    ? attachments.map(att => ({
      filename: att.filename,
      content: att.content,
      ...(att.contentType && { contentType: att.contentType })
    }))
    : undefined;
  if (emailAttachments) {
    console.log('[Email] Including', emailAttachments.length, 'attachment(s)');
  }
  
  try {
    console.log('[Email] Sending email to:', to);
    console.log('[Email] Subject:', processedSubject);
    
    const emailId = await deliverEmail({
      from: fromEmail,
      to,
      subject: processedSubject,
      html,
      text,
      headers: extraHeaders,
      replyTo,
      attachments: emailAttachments
    }, { idempotencyKey });
    console.log('[Email] Email sent successfully:', emailId);
    
    return {
      success: true,
      emailId,
      to: to,
      subject: processedSubject
    };
    
  } catch (error) {
    console.error('[Email] Send error:', error.message);
    throw error;
  }
}

/**
 * Build the final subject, HTML, plain text and unsubscribe headers for an
 * email without sending it. sendEmail() uses this; the lifecycle CLI uses it
 * to preview emails.
 */
export async function renderEmail({
  to,
  subject,
  templateType = 'journey_custom',
  variables = {},
  customBody = '',
  customHtml = null,
  customText = null,
  isHtmlBody = false,
  language = 'en',
  orgId = null,
  unsubscribeEmail = null,
  unsubscribeUrl = null
}) {
  // Get organization theme for custom branding (Tier 3+ with custom theme)
  const theme = orgId ? await getOrganizationEmailTheme(orgId) : null;
  
  // Process subject with variables
  const processedSubject = replaceVariables(subject, variables);
  
  // Recipient address used for the unsubscribe mailto subject so the handler
  // can identify who to remove without an extra lookup.
  const recipientAddress = Array.isArray(to) ? to[0] : to;
  
  // Resolve unsubscribe destination: caller-supplied address (used by invite
  // emails to point at the inviting maker) or the central inbox of Gryffi
  // Cloud. The Community Edition has no central inbox: without an address or
  // an unsubscribe page the email gets no unsubscribe line.
  const effectiveUnsubscribeEmail = (unsubscribeEmail && unsubscribeEmail.includes('@'))
    ? unsubscribeEmail
    : (isCloud() ? UNSUBSCRIBE_EMAIL : null);
  const withUnsubscribe = !!(effectiveUnsubscribeEmail || unsubscribeUrl);
  
  // 1. HTML body — generate or take as-is, then ensure a discreet unsubscribe
  // affordance is present at the bottom (idempotent).
  let html = generateEmailHtml(templateType, variables, customBody, customHtml, isHtmlBody, language, theme);
  if (withUnsubscribe) {
    html = injectUnsubscribeIntoHtml(html, recipientAddress, language, effectiveUnsubscribeEmail, unsubscribeUrl);
  }
  
  // 2. Plain-text body — pick the best source available, then append the
  // unsubscribe line. Without this, callers that pass only customHtml would
  // end up with a near-empty text part (a known spam signal).
  //
  // Theme placeholders ({{primaryColor}} etc.) must be resolved here as well:
  // generateEmailHtml() replaces them in the HTML part, but any {{...}} token
  // left in the text part makes the email provider's template engine reject
  // the whole message before sending.
  const effectiveTheme = theme || DEFAULT_THEME;
  const textVariables = {
    ...variables,
    primaryColor: effectiveTheme.primary,
    accentColor: effectiveTheme.accent,
    bgColor: effectiveTheme.background
  };
  let text;
  if (customText && customText.trim()) {
    text = customText;
  } else if (customBody) {
    // HTML bodies are stripped to readable plain text first; otherwise the
    // raw tags and inline styles would leak into the text part verbatim.
    const textSource = isHtmlBody
      ? htmlToPlainText(replaceVariables(customBody, textVariables))
      : customBody;
    text = generateEmailText(textVariables, textSource, language);
  } else if (customHtml) {
    text = htmlToPlainText(replaceVariables(customHtml, textVariables));
  } else {
    text = generateEmailText(textVariables, customBody, language);
  }
  // The administrator can switch off the "Powered by Gryffi" line (branding.poweredBy)
  if (!(await getSetting('branding.poweredBy'))) {
    html = html.replace(/[ \t]*<!-- powered-by:start -->[\s\S]*?<!-- powered-by:end -->\n?/g, '');
    text = (text || '').replace(/\s*Powered by Gryffi\s*$/, '');
  }
  text = withUnsubscribe
    ? `${(text || '').trimEnd()}\n\n${buildUnsubscribeFooterText(recipientAddress, language, effectiveUnsubscribeEmail, unsubscribeUrl)}\n`
    : `${(text || '').trimEnd()}\n`;
  
  // 3. Standard List-Unsubscribe header (RFC 2369). When an HTTPS unsubscribe
  // page is available (lifecycle emails) it goes first and the RFC 8058
  // one-click header is added, which Gmail and Yahoo require from senders of
  // recurring mail. Other emails keep the mailto-only variant.
  const extraHeaders = {};
  const listUnsubscribe = [
    unsubscribeUrl && `<${unsubscribeUrl}>`,
    effectiveUnsubscribeEmail && `<${buildUnsubscribeMailto(recipientAddress, effectiveUnsubscribeEmail)}>`
  ].filter(Boolean);
  if (listUnsubscribe.length) extraHeaders['List-Unsubscribe'] = listUnsubscribe.join(', ');
  if (unsubscribeUrl) {
    extraHeaders['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  
  return { subject: processedSubject, html, text, headers: extraHeaders };
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(userEmail, userName, resetLink, companyName = 'Gryffi') {
  return sendEmail({
    to: userEmail,
    subject: 'Reset your password',
    templateType: 'password_reset',
    variables: {
      user_name: userName,
      user_email: userEmail,
      company_name: companyName,
      custom_link: resetLink,
      custom_link_text: 'Reset Password'
    },
    customBody: `You have requested to reset your password.

Click the button below to set a new password. This link is valid for 1 hour.

If you did not request this, you can safely ignore this email.`
  });
}

/**
 * Send welcome email to new user
 */
export async function sendWelcomeEmail(userEmail, userName, loginLink, companyName = 'Gryffi') {
  return sendEmail({
    to: userEmail,
    subject: `Welcome to ${companyName}!`,
    templateType: 'welcome',
    variables: {
      user_name: userName,
      user_email: userEmail,
      company_name: companyName,
      custom_link: loginLink,
      custom_link_text: 'Get Started'
    },
    customBody: `Welcome! Your account has been created and you're ready to get started.

Log in to begin your onboarding journey and discover everything you need.

We look forward to having you on board!`
  });
}

/**
 * Send team invite email (builder user management)
 */
export async function sendTeamInviteEmail({
  toEmail,
  companyName = 'Gryffi',
  inviterName = '',
  inviteLink,
  roleName = 'Member',
  expiresInDays = 7
}) {
  const subject = `You're invited to join ${companyName} on Gryffi`;

  const intro = inviterName
    ? `${inviterName} invited you to join ${companyName}'s Journey Builder team on Gryffi.`
    : `You have been invited to join ${companyName}'s Journey Builder team on Gryffi.`;

  return await sendEmail({
    to: toEmail,
    subject,
    templateType: 'journey_custom',
    variables: {
      company_name: companyName,
      user_email: toEmail,
      custom_link: inviteLink,
      custom_link_text: 'Accept invitation'
    },
    customBody: `${intro}

Role: ${roleName}

Click the button below to create your account and set a password. This invitation expires in ${expiresInDays} days.

If you weren’t expecting this, you can safely ignore this email.`
  });
}

/**
 * Send journey step email
 * Supports custom themes for Tier 3+ organizations
 * Supports file attachments (max 12MB per file, max 2 files, 24MB total)
 */
export async function sendJourneyEmail({
  to,
  userName,
  subject,
  body,
  templateType = 'journey_info',
  journeyTitle = '',
  stepTitle = '',
  companyName = 'Gryffi',
  link = null,
  linkText = null,
  customHtml = null,
  isHtmlBody = false,
  language = 'en',
  orgId = null,
  attachments = null
}) {
  return sendEmail({
    to: to,
    subject: subject,
    templateType: templateType,
    variables: {
      user_name: userName,
      user_email: to,
      company_name: companyName,
      journey_title: journeyTitle,
      step_title: stepTitle,
      subject: subject,
      ...(link && { custom_link: link }),
      ...(linkText && { custom_link_text: linkText })
    },
    customBody: body,
    customHtml: customHtml,
    isHtmlBody: isHtmlBody,
    language: language,
    orgId: orgId,
    attachments: attachments
  });
}

/**
 * Send an automation email
 * Supports custom themes for Tier 3+ organizations
 * @param {Object} automation - The automation config from the step/journey
 * @param {Object} context - Context with user, journey, step info
 */
export async function sendAutomationEmail(automation, context) {
  const { user, journey, step, organization } = context;
  
  // Determine recipient
  let recipientEmail;
  if (automation.recipient === 'current_user') {
    recipientEmail = user?.email;
  } else {
    recipientEmail = automation.recipient; // Custom email address
  }
  
  if (!recipientEmail) {
    console.error('[Automation] No recipient email found');
    return { success: false, error: 'No recipient email' };
  }
  
  // Build variables (support both old and new variable names)
  const variables = {
    // New variable names (used in visual editor)
    first_name: user?.first_name || 'there',
    last_name: user?.last_name || '',
    email: user?.email || '',
    company_name: organization?.name || 'Gryffi',
    journey_title: journey?.title || 'Your Journey',
    step_title: step?.title || '',
    // Legacy variable names (for backwards compatibility)
    user_name: user?.first_name && user?.last_name 
      ? `${user.first_name} ${user.last_name}` 
      : user?.first_name || user?.email || 'User',
    user_first_name: user?.first_name || 'there',
    user_email: user?.email || ''
  };
  
  try {
    const result = await sendEmail({
      to: recipientEmail,
      subject: automation.subject || EMAIL_TEMPLATES[automation.template]?.subject || 'Notification',
      templateType: automation.template || 'journey_custom',
      variables,
      customBody: automation.body || '',
      orgId: organization?.id || null // Pass org ID for custom theme support
    });
    
    console.log(`[Automation] Email sent to ${recipientEmail} for trigger: ${automation.trigger}`);
    return { success: true, emailId: result.emailId };
  } catch (error) {
    console.error('[Automation] Failed to send email:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Process automations for a given trigger
 * @param {string} trigger - The trigger type (on_journey_start, on_step_enter, etc.)
 * @param {Array} automations - List of automations to check
 * @param {Object} context - Context with user, journey, step info
 * @param {string} pathId - Optional path ID for on_path triggers
 */
export async function processAutomations(trigger, automations, context, pathId = null) {
  const matchingAutomations = automations.filter(a => {
    if (a.trigger === trigger) return true;
    if (pathId && a.trigger === `on_path:${pathId}`) return true;
    return false;
  });
  
  const results = [];
  for (const automation of matchingAutomations) {
    const result = await sendAutomationEmail(automation, context);
    results.push({ automation, result });
  }
  
  return results;
}

/**
 * Send invitation email with magic link to end user
 * Supports custom themes for Tier 3+ organizations
 */
export async function sendInvitationEmail({
  to,
  firstName,
  journeyTitle,
  companyName = 'Gryffi',
  magicLink,
  validityText,
  language = 'en',
  orgId = null,
  unsubscribeEmail = null
}) {
  // Get organization theme for custom branding
  const theme = orgId ? await getOrganizationEmailTheme(orgId) : DEFAULT_THEME;
  
  // Language-specific content
  // Terms: EN=Journey, NL=Expeditie, DE=Expedition, FR=Parcours, ES=Expedición
  const translations = {
    en: {
      subject: `You're invited to ${journeyTitle}`,
      greeting: `Hello ${firstName},`,
      intro: `You've been invited to participate in "<strong>${journeyTitle}</strong>" at ${companyName}.`,
      instructions: `Click the button below to start your journey. This link is personal and valid for <strong>${validityText}</strong>.`,
      button: 'Start Journey',
      footer: "If you weren't expecting this invitation, you can safely ignore this email.",
      security: "This link is unique to you. Please don't share it with others."
    },
    nl: {
      subject: `Je bent uitgenodigd voor ${journeyTitle}`,
      greeting: `Hallo ${firstName},`,
      intro: `Je bent uitgenodigd om deel te nemen aan "<strong>${journeyTitle}</strong>" bij ${companyName}.`,
      instructions: `Klik op de knop hieronder om je expeditie te starten. Deze link is persoonlijk en <strong>${validityText}</strong> geldig.`,
      button: 'Start Expeditie',
      footer: 'Als je deze uitnodiging niet verwachtte, kun je deze e-mail negeren.',
      security: 'Deze link is uniek voor jou. Deel hem alsjeblieft niet met anderen.'
    },
    de: {
      subject: `Du bist eingeladen zu ${journeyTitle}`,
      greeting: `Hallo ${firstName},`,
      intro: `Du wurdest eingeladen, an "<strong>${journeyTitle}</strong>" bei ${companyName} teilzunehmen.`,
      instructions: `Klicke auf den Button unten, um deine Expedition zu starten. Dieser Link ist persönlich und <strong>${validityText}</strong> gültig.`,
      button: 'Expedition starten',
      footer: 'Wenn du diese Einladung nicht erwartet hast, kannst du diese E-Mail ignorieren.',
      security: 'Dieser Link ist nur für dich bestimmt. Bitte teile ihn nicht mit anderen.'
    },
    fr: {
      subject: `Vous êtes invité à ${journeyTitle}`,
      greeting: `Bonjour ${firstName},`,
      intro: `Vous avez été invité à participer à "<strong>${journeyTitle}</strong>" chez ${companyName}.`,
      instructions: `Cliquez sur le bouton ci-dessous pour commencer votre parcours. Ce lien est personnel et valide pendant <strong>${validityText}</strong>.`,
      button: 'Commencer le Parcours',
      footer: "Si vous n'attendiez pas cette invitation, vous pouvez ignorer cet e-mail.",
      security: 'Ce lien vous est unique. Veuillez ne pas le partager avec d\'autres.'
    },
    es: {
      subject: `Has sido invitado a ${journeyTitle}`,
      greeting: `Hola ${firstName},`,
      intro: `Has sido invitado a participar en "<strong>${journeyTitle}</strong>" en ${companyName}.`,
      instructions: `Haz clic en el botón de abajo para comenzar tu expedición. Este enlace es personal y válido durante <strong>${validityText}</strong>.`,
      button: 'Comenzar Expedición',
      footer: 'Si no esperabas esta invitación, puedes ignorar este correo electrónico.',
      security: 'Este enlace es único para ti. Por favor, no lo compartas con otros.'
    },
    it: {
      subject: `Sei stato invitato a ${journeyTitle}`,
      greeting: `Ciao ${firstName},`,
      intro: `Sei stato invitato a partecipare a "<strong>${journeyTitle}</strong>" presso ${companyName}.`,
      instructions: `Clicca il pulsante qui sotto per iniziare il tuo percorso. Questo link è personale e valido per <strong>${validityText}</strong>.`,
      button: 'Inizia il Percorso',
      footer: 'Se non ti aspettavi questo invito, puoi ignorare questa e-mail.',
      security: 'Questo link è unico per te. Per favore, non condividerlo con altri.'
    },
    pt: {
      subject: `Você foi convidado para ${journeyTitle}`,
      greeting: `Olá ${firstName},`,
      intro: `Você foi convidado a participar de "<strong>${journeyTitle}</strong>" na ${companyName}.`,
      instructions: `Clique no botão abaixo para iniciar sua jornada. Este link é pessoal e válido por <strong>${validityText}</strong>.`,
      button: 'Iniciar Jornada',
      footer: 'Se você não esperava este convite, pode ignorar este e-mail.',
      security: 'Este link é exclusivo para você. Por favor, não o compartilhe com outras pessoas.'
    },
    da: {
      subject: `Du er inviteret til ${journeyTitle}`,
      greeting: `Hej ${firstName},`,
      intro: `Du er blevet inviteret til at deltage i "<strong>${journeyTitle}</strong>" hos ${companyName}.`,
      instructions: `Klik på knappen nedenfor for at starte din rejse. Dette link er personligt og gyldigt i <strong>${validityText}</strong>.`,
      button: 'Start Rejse',
      footer: 'Hvis du ikke forventede denne invitation, kan du ignorere denne e-mail.',
      security: 'Dette link er unikt for dig. Del det venligst ikke med andre.'
    },
    no: {
      subject: `Du er invitert til ${journeyTitle}`,
      greeting: `Hei ${firstName},`,
      intro: `Du har blitt invitert til å delta i "<strong>${journeyTitle}</strong>" hos ${companyName}.`,
      instructions: `Klikk på knappen nedenfor for å starte reisen din. Denne lenken er personlig og gyldig i <strong>${validityText}</strong>.`,
      button: 'Start Reise',
      footer: 'Hvis du ikke forventet denne invitasjonen, kan du ignorere denne e-posten.',
      security: 'Denne lenken er unik for deg. Vennligst ikke del den med andre.'
    },
    fi: {
      subject: `Sinut on kutsuttu: ${journeyTitle}`,
      greeting: `Hei ${firstName},`,
      intro: `Sinut on kutsuttu osallistumaan "<strong>${journeyTitle}</strong>" organisaatiossa ${companyName}.`,
      instructions: `Napsauta alla olevaa painiketta aloittaaksesi matkasi. Tämä linkki on henkilökohtainen ja voimassa <strong>${validityText}</strong>.`,
      button: 'Aloita Matka',
      footer: 'Jos et odottanut tätä kutsua, voit jättää tämän sähköpostin huomiotta.',
      security: 'Tämä linkki on tarkoitettu vain sinulle. Älä jaa sitä muille.'
    },
    sv: {
      subject: `Du är inbjuden till ${journeyTitle}`,
      greeting: `Hej ${firstName},`,
      intro: `Du har blivit inbjuden att delta i "<strong>${journeyTitle}</strong>" hos ${companyName}.`,
      instructions: `Klicka på knappen nedan för att starta din resa. Denna länk är personlig och giltig i <strong>${validityText}</strong>.`,
      button: 'Starta Resa',
      footer: 'Om du inte förväntade dig denna inbjudan kan du ignorera detta e-postmeddelande.',
      security: 'Denna länk är unik för dig. Vänligen dela den inte med andra.'
    },
    pl: {
      subject: `Zaproszenie do ${journeyTitle}`,
      greeting: `Cześć ${firstName},`,
      intro: `Zostałeś zaproszony do udziału w "<strong>${journeyTitle}</strong>" w ${companyName}.`,
      instructions: `Kliknij poniższy przycisk, aby rozpocząć swoją podróż. Ten link jest osobisty i ważny przez <strong>${validityText}</strong>.`,
      button: 'Rozpocznij Podróż',
      footer: 'Jeśli nie spodziewałeś się tego zaproszenia, możesz zignorować tę wiadomość.',
      security: 'Ten link jest przeznaczony tylko dla Ciebie. Prosimy, nie udostępniaj go innym.'
    },
    ro: {
      subject: `Ești invitat la ${journeyTitle}`,
      greeting: `Bună ${firstName},`,
      intro: `Ai fost invitat să participi la "<strong>${journeyTitle}</strong>" la ${companyName}.`,
      instructions: `Apasă butonul de mai jos pentru a-ți începe călătoria. Acest link este personal și valabil pentru <strong>${validityText}</strong>.`,
      button: 'Începe Călătoria',
      footer: 'Dacă nu te așteptai la această invitație, poți ignora acest e-mail.',
      security: 'Acest link este unic pentru tine. Te rugăm să nu-l distribui altora.'
    },
    tr: {
      subject: `${journeyTitle} için davet edildiniz`,
      greeting: `Merhaba ${firstName},`,
      intro: `${companyName} bünyesindeki "<strong>${journeyTitle}</strong>" etkinliğine katılmaya davet edildiniz.`,
      instructions: `Yolculuğunuza başlamak için aşağıdaki düğmeye tıklayın. Bu bağlantı size özeldir ve <strong>${validityText}</strong> geçerlidir.`,
      button: 'Yolculuğu Başlat',
      footer: 'Bu daveti beklemiyorsanız, bu e-postayı güvenle görmezden gelebilirsiniz.',
      security: 'Bu bağlantı size özeldir. Lütfen başkalarıyla paylaşmayın.'
    }
  };

  const t = translations[language] || translations.en;
  
  // Use custom theme colors or default Gryffi colors
  const bgColor = theme.background;
  const primaryColor = theme.primary;
  const accentColor = theme.accent;
  const appUrl = getAppBaseUrl();
  const emailAssetsUrl = process.env.EMAIL_ASSETS_URL || appUrl;
  const defaultLogoUrl = `${emailAssetsUrl}/images/logos/Logo---illustration-only-cropped-transparant.png`;
  const logoUrl = theme.logoUrl ? `${emailAssetsUrl}${theme.logoUrl}` : defaultLogoUrl;

  const html = `
<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${t.subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${bgColor}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  
  <!-- Preheader -->
  <div style="display: none; max-height: 0; overflow: hidden;">
    ${t.intro.replace(/<[^>]*>/g, '')}
  </div>
  
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: ${bgColor}; padding: 48px 20px;">
    <tr>
      <td align="center">
        
        <!-- Logo -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin-bottom: 24px;">
          <tr>
            <td align="center">
              <img src="${logoUrl}" alt="Gryffi" width="64" height="64" 
                   style="display: block; width: 64px; height: 64px; object-fit: contain;">
            </td>
          </tr>
        </table>
        
        <!-- Main Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(11, 75, 52, 0.08);">
          
          <!-- Accent Bar -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, ${primaryColor} 0%, ${accentColor} 100%);"></td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 36px 32px 36px;">
              
              <!-- Greeting -->
              <p style="margin: 0 0 24px 0; color: ${primaryColor}; font-size: 20px; font-weight: 600;">
                ${t.greeting}
              </p>
              
              <!-- Intro -->
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #334155;">
                ${t.intro}
              </p>
              
              <!-- Instructions -->
              <p style="margin: 0 0 32px 0; font-size: 15px; line-height: 1.7; color: #64748b;">
                ${t.instructions}
              </p>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 32px 0;">
                <tr>
                  <td align="center">
                    <a href="${magicLink}" 
                       style="display: inline-block; background: ${primaryColor}; color: white; 
                              padding: 16px 48px; border-radius: 10px; text-decoration: none; 
                              font-weight: 700; font-size: 16px; letter-spacing: 0.3px;
                              box-shadow: 0 4px 12px rgba(11, 75, 52, 0.3);">
                      ${t.button}
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Security note -->
              <p style="margin: 0; font-size: 13px; color: #94a3b8; text-align: center; font-style: italic;">
                ${t.security}
              </p>
              
            </td>
          </tr>
          
          <!-- Divider -->
          <tr>
            <td style="padding: 0 36px;">
              <div style="height: 1px; background: #e2e8f0;"></div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 36px 32px 36px;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px; text-align: center;">
                ${t.footer}
              </p>
            </td>
          </tr>
          
        </table>
        
        <!-- Bottom Footer -->
        <!-- powered-by:start -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin-top: 24px;">
          <tr>
            <td align="center">
              <p style="margin: 0; color: #64748b; font-size: 11px;">
                Powered by <span style="color: ${primaryColor}; font-weight: 500;">Gryffi</span> · Interactive Journey Builder
              </p>
            </td>
          </tr>
        </table>
        <!-- powered-by:end -->
        
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const text = `${t.greeting}

${t.intro.replace(/<[^>]*>/g, '')}

${t.instructions.replace(/<[^>]*>/g, '')}

${t.button}: ${magicLink}

${t.security}

---
${t.footer}

Powered by Gryffi`;

  return sendEmail({
    to,
    subject: t.subject,
    templateType: 'journey_custom',
    variables: {},
    customBody: '',
    customHtml: html,
    customText: text,
    language,
    unsubscribeEmail
  });
}

/**
 * Send verification code email for device binding
 * Supports custom themes for Tier 3+ organizations
 */
export async function sendVerificationCodeEmail({
  to,
  firstName,
  journeyTitle,
  verificationCode,
  language = 'en',
  orgId = null
}) {
  // Get organization theme for custom branding
  const theme = orgId ? await getOrganizationEmailTheme(orgId) : DEFAULT_THEME;
  
  // Consistent terminology across languages:
  // EN: Journey, NL: Expeditie, DE: Expedition, FR: Parcours, ES: Expedición
  // Handle missing/undefined journeyTitle gracefully
  const hasJourneyTitle = journeyTitle && journeyTitle !== 'undefined' && journeyTitle.trim() !== '';
  
  const translations = {
    en: {
      subject: hasJourneyTitle ? `Your verification code for ${journeyTitle}` : 'Your verification code',
      greeting: `Hello ${firstName || 'there'},`,
      intro: hasJourneyTitle 
        ? `We need to verify your email to continue with "${journeyTitle}".`
        : 'We need to verify your email to continue.',
      instruction: 'Enter this code to continue:',
      expiry: 'This code expires in 10 minutes.',
      ignore: 'If you didn\'t request this code, please ignore this email.'
    },
    nl: {
      subject: hasJourneyTitle ? `Je verificatiecode voor ${journeyTitle}` : 'Je verificatiecode',
      greeting: `Hallo ${firstName || 'daar'},`,
      intro: hasJourneyTitle 
        ? `We moeten je e-mail verifiëren om door te gaan met "${journeyTitle}".`
        : 'We moeten je e-mail verifiëren om door te gaan.',
      instruction: 'Voer deze code in om door te gaan:',
      expiry: 'Deze code verloopt over 10 minuten.',
      ignore: 'Als je deze code niet hebt aangevraagd, kun je deze e-mail negeren.'
    },
    de: {
      subject: hasJourneyTitle ? `Dein Bestätigungscode für ${journeyTitle}` : 'Dein Bestätigungscode',
      greeting: `Hallo ${firstName || 'dort'},`,
      intro: hasJourneyTitle 
        ? `Wir müssen deine E-Mail verifizieren, um mit "${journeyTitle}" fortzufahren.`
        : 'Wir müssen deine E-Mail verifizieren, um fortzufahren.',
      instruction: 'Gib diesen Code ein, um fortzufahren:',
      expiry: 'Dieser Code läuft in 10 Minuten ab.',
      ignore: 'Wenn du diesen Code nicht angefordert hast, ignoriere diese E-Mail.'
    },
    fr: {
      subject: hasJourneyTitle ? `Votre code de vérification pour ${journeyTitle}` : 'Votre code de vérification',
      greeting: `Bonjour ${firstName || ''},`,
      intro: hasJourneyTitle 
        ? `Nous devons vérifier votre e-mail pour continuer avec "${journeyTitle}".`
        : 'Nous devons vérifier votre e-mail pour continuer.',
      instruction: 'Entrez ce code pour continuer:',
      expiry: 'Ce code expire dans 10 minutes.',
      ignore: 'Si vous n\'avez pas demandé ce code, veuillez ignorer cet e-mail.'
    },
    es: {
      subject: hasJourneyTitle ? `Tu código de verificación para ${journeyTitle}` : 'Tu código de verificación',
      greeting: `Hola ${firstName || ''},`,
      intro: hasJourneyTitle 
        ? `Necesitamos verificar tu correo para continuar con "${journeyTitle}".`
        : 'Necesitamos verificar tu correo para continuar.',
      instruction: 'Introduce este código para continuar:',
      expiry: 'Este código expira en 10 minutos.',
      ignore: 'Si no solicitaste este código, por favor ignora este correo electrónico.'
    }
  };

  const t = translations[language] || translations.en;
  
  // Use custom theme colors or default Gryffi colors
  const bgColor = theme.background;
  const primaryColor = theme.primary;
  const accentColor = theme.accent;
  const appUrl = getAppBaseUrl();
  const emailAssetsUrl = process.env.EMAIL_ASSETS_URL || appUrl;
  const defaultLogoUrl = `${emailAssetsUrl}/images/logos/Logo---illustration-only-cropped-transparant.png`;
  const logoUrl = theme.logoUrl ? `${emailAssetsUrl}${theme.logoUrl}` : defaultLogoUrl;

  const html = `
<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${t.subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${bgColor}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: ${bgColor}; padding: 48px 20px;">
    <tr>
      <td align="center">
        
        <!-- Logo -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin-bottom: 24px;">
          <tr>
            <td align="center">
              <img src="${logoUrl}" alt="Logo" width="64" height="64" 
                   style="display: block; width: 64px; height: 64px; object-fit: contain;">
            </td>
          </tr>
        </table>
        
        <!-- Main Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(11, 75, 52, 0.08);">
          
          <!-- Accent Bar -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, ${primaryColor} 0%, ${accentColor} 100%);"></td>
          </tr>
          
          <tr>
            <td style="padding: 40px 36px;">
              
              <p style="margin: 0 0 24px 0; color: ${primaryColor}; font-size: 20px; font-weight: 600;">
                ${t.greeting}
              </p>
              
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #334155;">
                ${t.intro}
              </p>
              
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #64748b;">
                ${t.instruction}
              </p>
              
              <!-- Verification Code -->
              <div style="text-align: center; margin: 24px 0;">
                <div style="display: inline-block; background: ${bgColor}; padding: 20px 40px; border-radius: 12px; border: 2px dashed ${accentColor};">
                  <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: ${primaryColor};">
                    ${verificationCode}
                  </span>
                </div>
              </div>
              
              <p style="margin: 24px 0 0 0; font-size: 13px; color: #94a3b8; text-align: center;">
                ${t.expiry}
              </p>
              
            </td>
          </tr>
          
          <tr>
            <td style="padding: 0 36px;">
              <div style="height: 1px; background: #e2e8f0;"></div>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 24px 36px;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px; text-align: center;">
                ${t.ignore}
              </p>
            </td>
          </tr>
          
        </table>
        
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const text = `${t.greeting}

${t.intro}

${t.instruction}

${verificationCode}

${t.expiry}

---
${t.ignore}

Powered by Gryffi`;

  return sendEmail({
    to,
    subject: t.subject,
    templateType: 'journey_custom',
    variables: {},
    customBody: '',
    customHtml: html,
    customText: text,
    language
  });
}

/**
 * Send subscription tier change notification email
 * Sent to organization admins when the subscription tier changes after a payment
 */
export async function sendSubscriptionChangeEmail({
  to,
  adminName,
  organizationName,
  newTierName,
  previousTierName,
  billingPeriod,
  language = 'en',
  orgId = null
}) {
  // Get organization theme for custom branding
  const theme = orgId ? await getOrganizationEmailTheme(orgId) : DEFAULT_THEME;
  
  // Determine if upgrade or downgrade. Without a previous tier (e.g. the
  // subscription became active again after past_due) it is neither: the
  // neutral "your subscription is now active" wording is used.
  const tierOrder = { free: 1, professional: 2, enterprise: 3, custom: 4 };
  const newRank = tierOrder[newTierName?.toLowerCase()] || 0;
  const previousRank = tierOrder[previousTierName?.toLowerCase()] || 0;
  const isUpgrade = !!previousTierName && newRank > previousRank;
  const isDowngrade = !!previousTierName && newRank < previousRank;
  
  // Format tier names for display
  const formatTierName = (tier) => {
    if (!tier) return '';
    return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
  };
  
  const newTierDisplay = formatTierName(newTierName);
  const previousTierDisplay = formatTierName(previousTierName);
  const billingDisplay = billingPeriod === 'yearly' || billingPeriod === 'year' ? 'yearly' : 'monthly';
  
  // Multi-language translations
  const translations = {
    en: {
      subject: isUpgrade 
        ? `🎉 Welcome to ${newTierDisplay}!` 
        : isDowngrade 
          ? `Your subscription has been changed to ${newTierDisplay}`
          : `Your ${newTierDisplay} subscription is now active`,
      greeting: `Hello ${adminName || 'there'},`,
      upgradeIntro: `Great news! Your organization "<strong>${organizationName}</strong>" has been successfully upgraded to the <strong>${newTierDisplay}</strong> plan.`,
      downgradeIntro: `Your organization "<strong>${organizationName}</strong>" subscription has been changed to the <strong>${newTierDisplay}</strong> plan.`,
      activeIntro: `Your organization "<strong>${organizationName}</strong>" now has an active <strong>${newTierDisplay}</strong> subscription.`,
      billingInfo: `Billing: <strong>${billingDisplay === 'yearly' ? 'Annual' : 'Monthly'}</strong>`,
      previousTier: previousTierName ? `Previous plan: ${previousTierDisplay}` : '',
      upgradeMessage: 'You now have access to all the features included in your new plan. Explore them in your dashboard!',
      downgradeMessage: 'Your plan features have been updated accordingly. You can upgrade again at any time.',
      activeMessage: 'Thank you for your subscription! You now have access to all features included in your plan.',
      button: 'Go to Dashboard',
      questions: 'If you have any questions about your subscription, please contact our support team.',
      footer: 'This is an automated message regarding your Gryffi subscription.'
    },
    nl: {
      subject: isUpgrade 
        ? `🎉 Welkom bij ${newTierDisplay}!` 
        : isDowngrade 
          ? `Je abonnement is gewijzigd naar ${newTierDisplay}`
          : `Je ${newTierDisplay} abonnement is nu actief`,
      greeting: `Hallo ${adminName || 'daar'},`,
      upgradeIntro: `Goed nieuws! Je organisatie "<strong>${organizationName}</strong>" is succesvol geüpgraded naar het <strong>${newTierDisplay}</strong> abonnement.`,
      downgradeIntro: `Je organisatie "<strong>${organizationName}</strong>" abonnement is gewijzigd naar het <strong>${newTierDisplay}</strong> abonnement.`,
      activeIntro: `Je organisatie "<strong>${organizationName}</strong>" heeft nu een actief <strong>${newTierDisplay}</strong> abonnement.`,
      billingInfo: `Facturering: <strong>${billingDisplay === 'yearly' ? 'Jaarlijks' : 'Maandelijks'}</strong>`,
      previousTier: previousTierName ? `Vorig abonnement: ${previousTierDisplay}` : '',
      upgradeMessage: 'Je hebt nu toegang tot alle functies van je nieuwe abonnement. Ontdek ze in je dashboard!',
      downgradeMessage: 'Je abonnementsfuncties zijn dienovereenkomstig aangepast. Je kunt op elk moment weer upgraden.',
      activeMessage: 'Bedankt voor je abonnement! Je hebt nu toegang tot alle functies van je abonnement.',
      button: 'Ga naar Dashboard',
      questions: 'Als je vragen hebt over je abonnement, neem dan contact op met ons supportteam.',
      footer: 'Dit is een automatisch bericht over je Gryffi abonnement.'
    },
    de: {
      subject: isUpgrade 
        ? `🎉 Willkommen bei ${newTierDisplay}!` 
        : isDowngrade 
          ? `Dein Abonnement wurde auf ${newTierDisplay} geändert`
          : `Dein ${newTierDisplay} Abonnement ist jetzt aktiv`,
      greeting: `Hallo ${adminName || 'dort'},`,
      upgradeIntro: `Tolle Neuigkeiten! Deine Organisation "<strong>${organizationName}</strong>" wurde erfolgreich auf das <strong>${newTierDisplay}</strong> Abonnement aktualisiert.`,
      downgradeIntro: `Das Abonnement deiner Organisation "<strong>${organizationName}</strong>" wurde auf das <strong>${newTierDisplay}</strong> Abonnement geändert.`,
      activeIntro: `Deine Organisation "<strong>${organizationName}</strong>" hat jetzt ein aktives <strong>${newTierDisplay}</strong> Abonnement.`,
      billingInfo: `Abrechnung: <strong>${billingDisplay === 'yearly' ? 'Jährlich' : 'Monatlich'}</strong>`,
      previousTier: previousTierName ? `Vorheriges Abonnement: ${previousTierDisplay}` : '',
      upgradeMessage: 'Du hast jetzt Zugang zu allen Funktionen deines neuen Abonnements. Entdecke sie in deinem Dashboard!',
      downgradeMessage: 'Deine Abonnement-Funktionen wurden entsprechend angepasst. Du kannst jederzeit wieder upgraden.',
      activeMessage: 'Danke für dein Abonnement! Du hast jetzt Zugang zu allen Funktionen deines Abonnements.',
      button: 'Zum Dashboard',
      questions: 'Bei Fragen zu deinem Abonnement wende dich bitte an unser Support-Team.',
      footer: 'Dies ist eine automatische Nachricht zu deinem Gryffi Abonnement.'
    },
    fr: {
      subject: isUpgrade 
        ? `🎉 Bienvenue sur ${newTierDisplay} !` 
        : isDowngrade 
          ? `Votre abonnement a été changé en ${newTierDisplay}`
          : `Votre abonnement ${newTierDisplay} est maintenant actif`,
      greeting: `Bonjour ${adminName || ''},`,
      upgradeIntro: `Bonne nouvelle ! Votre organisation "<strong>${organizationName}</strong>" a été mise à niveau vers le plan <strong>${newTierDisplay}</strong>.`,
      downgradeIntro: `L'abonnement de votre organisation "<strong>${organizationName}</strong>" a été changé en plan <strong>${newTierDisplay}</strong>.`,
      activeIntro: `Votre organisation "<strong>${organizationName}</strong>" a maintenant un abonnement <strong>${newTierDisplay}</strong> actif.`,
      billingInfo: `Facturation : <strong>${billingDisplay === 'yearly' ? 'Annuelle' : 'Mensuelle'}</strong>`,
      previousTier: previousTierName ? `Plan précédent : ${previousTierDisplay}` : '',
      upgradeMessage: 'Vous avez maintenant accès à toutes les fonctionnalités de votre nouveau plan. Découvrez-les dans votre tableau de bord !',
      downgradeMessage: 'Les fonctionnalités de votre plan ont été mises à jour en conséquence. Vous pouvez mettre à niveau à nouveau à tout moment.',
      activeMessage: 'Merci pour votre abonnement ! Vous avez maintenant accès à toutes les fonctionnalités de votre plan.',
      button: 'Aller au Tableau de Bord',
      questions: 'Si vous avez des questions sur votre abonnement, veuillez contacter notre équipe de support.',
      footer: 'Ceci est un message automatique concernant votre abonnement Gryffi.'
    },
    es: {
      subject: isUpgrade 
        ? `🎉 ¡Bienvenido a ${newTierDisplay}!` 
        : isDowngrade 
          ? `Tu suscripción ha sido cambiada a ${newTierDisplay}`
          : `Tu suscripción ${newTierDisplay} está ahora activa`,
      greeting: `Hola ${adminName || ''},`,
      upgradeIntro: `¡Buenas noticias! Tu organización "<strong>${organizationName}</strong>" ha sido actualizada exitosamente al plan <strong>${newTierDisplay}</strong>.`,
      downgradeIntro: `La suscripción de tu organización "<strong>${organizationName}</strong>" ha sido cambiada al plan <strong>${newTierDisplay}</strong>.`,
      activeIntro: `Tu organización "<strong>${organizationName}</strong>" ahora tiene una suscripción <strong>${newTierDisplay}</strong> activa.`,
      billingInfo: `Facturación: <strong>${billingDisplay === 'yearly' ? 'Anual' : 'Mensual'}</strong>`,
      previousTier: previousTierName ? `Plan anterior: ${previousTierDisplay}` : '',
      upgradeMessage: '¡Ahora tienes acceso a todas las características de tu nuevo plan. Explóralas en tu panel de control!',
      downgradeMessage: 'Las características de tu plan han sido actualizadas en consecuencia. Puedes volver a mejorar en cualquier momento.',
      activeMessage: '¡Gracias por tu suscripción! Ahora tienes acceso a todas las características de tu plan.',
      button: 'Ir al Panel',
      questions: 'Si tienes preguntas sobre tu suscripción, por favor contacta a nuestro equipo de soporte.',
      footer: 'Este es un mensaje automático sobre tu suscripción de Gryffi.'
    }
  };

  const t = translations[language] || translations.en;
  
  // Use custom theme colors or default Gryffi colors
  const bgColor = theme.background;
  const primaryColor = theme.primary;
  const accentColor = theme.accent;
  const appUrl = getAppBaseUrl();
  const emailAssetsUrl = process.env.EMAIL_ASSETS_URL || appUrl;
  const defaultLogoUrl = `${emailAssetsUrl}/images/logos/Logo---illustration-only-cropped-transparant.png`;
  const logoUrl = theme.logoUrl ? `${emailAssetsUrl}${theme.logoUrl}` : defaultLogoUrl;
  
  // Choose intro text based on upgrade/downgrade/active
  const introText = isUpgrade ? t.upgradeIntro : isDowngrade ? t.downgradeIntro : t.activeIntro;
  const messageText = isUpgrade ? t.upgradeMessage : isDowngrade ? t.downgradeMessage : t.activeMessage;
  
  // Accent bar color - green for upgrade, orange for downgrade
  const accentBarColor = isDowngrade ? '#f59e0b' : accentColor;

  const html = `
<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${t.subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${bgColor}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  
  <!-- Preheader -->
  <div style="display: none; max-height: 0; overflow: hidden;">
    ${introText.replace(/<[^>]*>/g, '')}
  </div>
  
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: ${bgColor}; padding: 48px 20px;">
    <tr>
      <td align="center">
        
        <!-- Logo -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin-bottom: 24px;">
          <tr>
            <td align="center">
              <img src="${logoUrl}" alt="Gryffi" width="64" height="64" 
                   style="display: block; width: 64px; height: 64px; object-fit: contain;">
            </td>
          </tr>
        </table>
        
        <!-- Main Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(11, 75, 52, 0.08);">
          
          <!-- Accent Bar -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, ${primaryColor} 0%, ${accentBarColor} 100%);"></td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 36px 32px 36px;">
              
              ${isUpgrade ? `
              <!-- Success Badge -->
              <div style="text-align: center; margin-bottom: 24px;">
                <span style="display: inline-block; background: ${accentColor}15; color: ${accentColor}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                  ✓ Upgrade Complete
                </span>
              </div>
              ` : ''}
              
              <!-- Greeting -->
              <p style="margin: 0 0 24px 0; color: ${primaryColor}; font-size: 20px; font-weight: 600;">
                ${t.greeting}
              </p>
              
              <!-- Intro -->
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #334155;">
                ${introText}
              </p>
              
              <!-- Subscription Details Box -->
              <div style="background: ${bgColor}; border-radius: 12px; padding: 20px; margin: 24px 0;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding: 8px 0;">
                      <span style="color: #64748b; font-size: 13px;">Plan:</span>
                      <span style="color: ${primaryColor}; font-size: 15px; font-weight: 600; float: right;">${newTierDisplay}</span>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; border-top: 1px solid #e2e8f0;">
                      <span style="color: #64748b; font-size: 13px;">${t.billingInfo.split(':')[0]}:</span>
                      <span style="color: #334155; font-size: 15px; float: right;">${billingDisplay === 'yearly' ? (language === 'nl' ? 'Jaarlijks' : language === 'de' ? 'Jährlich' : language === 'fr' ? 'Annuelle' : language === 'es' ? 'Anual' : 'Annual') : (language === 'nl' ? 'Maandelijks' : language === 'de' ? 'Monatlich' : language === 'fr' ? 'Mensuelle' : language === 'es' ? 'Mensual' : 'Monthly')}</span>
                    </td>
                  </tr>
                  ${previousTierName && previousTierName !== newTierName ? `
                  <tr>
                    <td style="padding: 8px 0; border-top: 1px solid #e2e8f0;">
                      <span style="color: #64748b; font-size: 13px;">${t.previousTier.split(':')[0]}:</span>
                      <span style="color: #94a3b8; font-size: 15px; float: right;">${previousTierDisplay}</span>
                    </td>
                  </tr>
                  ` : ''}
                </table>
              </div>
              
              <!-- Message -->
              <p style="margin: 0 0 32px 0; font-size: 15px; line-height: 1.7; color: #64748b;">
                ${messageText}
              </p>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
                <tr>
                  <td align="center">
                    <a href="${appUrl}/dashboard/subscription" 
                       style="display: inline-block; background: ${primaryColor}; color: white; 
                              padding: 14px 36px; border-radius: 10px; text-decoration: none; 
                              font-weight: 600; font-size: 15px; letter-spacing: 0.3px;
                              box-shadow: 0 4px 12px rgba(11, 75, 52, 0.25);">
                      ${t.button}
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Questions note -->
              <p style="margin: 0; font-size: 13px; color: #94a3b8; text-align: center;">
                ${t.questions}
              </p>
              
            </td>
          </tr>
          
          <!-- Divider -->
          <tr>
            <td style="padding: 0 36px;">
              <div style="height: 1px; background: #e2e8f0;"></div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 36px 32px 36px;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px; text-align: center;">
                ${t.footer}
              </p>
            </td>
          </tr>
          
        </table>
        
        <!-- Bottom Footer -->
        <!-- powered-by:start -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin-top: 24px;">
          <tr>
            <td align="center">
              <p style="margin: 0; color: #64748b; font-size: 11px;">
                Powered by <span style="color: ${primaryColor}; font-weight: 500;">Gryffi</span> · Interactive Journey Builder
              </p>
            </td>
          </tr>
        </table>
        <!-- powered-by:end -->
        
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const stripHtml = (s) => (s || '').replace(/<[^>]*>/g, '');
  const billingLabel = billingDisplay === 'yearly'
    ? (language === 'nl' ? 'Jaarlijks' : language === 'de' ? 'Jährlich' : language === 'fr' ? 'Annuelle' : language === 'es' ? 'Anual' : 'Annual')
    : (language === 'nl' ? 'Maandelijks' : language === 'de' ? 'Monatlich' : language === 'fr' ? 'Mensuelle' : language === 'es' ? 'Mensual' : 'Monthly');
  
  const text = `${t.greeting}

${stripHtml(introText)}

Plan: ${newTierDisplay}
${stripHtml(t.billingInfo).split(':')[0]}: ${billingLabel}${previousTierName && previousTierName !== newTierName ? `\n${stripHtml(t.previousTier)}` : ''}

${messageText}

${t.button}: ${appUrl}/dashboard/subscription

${t.questions}

---
${t.footer}

Powered by Gryffi`;

  return sendEmail({
    to,
    subject: t.subject,
    templateType: 'journey_custom',
    variables: {},
    customBody: '',
    customHtml: html,
    customText: text,
    language
  });
}

/**
 * Get available templates for UI
 */
export function getEmailTemplates() {
  return Object.entries(EMAIL_TEMPLATES)
    .filter(([key]) => key.startsWith('journey_'))
    .map(([key, value]) => ({
      id: key,
      ...value
    }));
}

/**
 * Get available variables for UI
 */
export function getTemplateVariables() {
  return TEMPLATE_VARIABLES;
}

function escapeEmailHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const AI_CREDITS_EMAIL_TEXTS = {
  en: {
    subject80: 'Your AI guides have used 80% of this month\'s questions',
    subject100: 'Your AI guides have used all questions for this month',
    body80: 'The AI guides of {org} have answered {used} of the {limit} questions in your plan this month. The counter resets on {date}.',
    body100: 'The AI guides of {org} have answered all {limit} questions in your plan this month.',
    action80: 'Do you expect more questions before {date}? Upgrade your plan so your guides keep answering.',
    action100: 'End users can still ask about {extra} more questions. After that, the guides stop answering until {date}. In the builder preview they stop now. Upgrade your plan to keep them answering.',
    cta: 'View plans'
  },
  nl: {
    subject80: 'Je AI-gidsen hebben 80% van de vragen van deze maand gebruikt',
    subject100: 'Je AI-gidsen hebben alle vragen van deze maand gebruikt',
    body80: 'De AI-gidsen van {org} hebben deze maand {used} van de {limit} vragen uit je abonnement beantwoord. De teller begint opnieuw op {date}.',
    body100: 'De AI-gidsen van {org} hebben deze maand alle {limit} vragen uit je abonnement beantwoord.',
    action80: 'Verwacht je voor {date} meer vragen? Upgrade je abonnement, dan blijven je gidsen antwoorden.',
    action100: 'Eindgebruikers kunnen nog ongeveer {extra} vragen stellen. Daarna antwoorden de gidsen niet meer tot {date}. In de preview van de builder stoppen ze nu al. Upgrade je abonnement om ze te laten doorgaan.',
    cta: 'Bekijk abonnementen'
  },
  de: {
    subject80: 'Ihre KI-Begleiter haben 80 % der Fragen dieses Monats genutzt',
    subject100: 'Ihre KI-Begleiter haben alle Fragen dieses Monats genutzt',
    body80: 'Die KI-Begleiter von {org} haben in diesem Monat {used} von {limit} Fragen aus Ihrem Plan beantwortet. Der Zähler beginnt am {date} neu.',
    body100: 'Die KI-Begleiter von {org} haben in diesem Monat alle {limit} Fragen aus Ihrem Plan beantwortet.',
    action80: 'Erwarten Sie vor dem {date} mehr Fragen? Upgraden Sie Ihren Plan, damit Ihre Begleiter weiter antworten.',
    action100: 'Endbenutzer können noch etwa {extra} Fragen stellen. Danach antworten die Begleiter bis zum {date} nicht mehr. In der Vorschau des Builders stoppen sie sofort. Upgraden Sie Ihren Plan, damit sie weiter antworten.',
    cta: 'Pläne ansehen'
  },
  fr: {
    subject80: 'Vos guides IA ont utilisé 80 % des questions de ce mois',
    subject100: 'Vos guides IA ont utilisé toutes les questions de ce mois',
    body80: 'Les guides IA de {org} ont répondu ce mois-ci à {used} des {limit} questions de votre plan. Le compteur repart à zéro le {date}.',
    body100: 'Les guides IA de {org} ont répondu ce mois-ci à toutes les {limit} questions de votre plan.',
    action80: 'Vous attendez plus de questions avant le {date} ? Mettez à niveau votre plan pour que vos guides continuent de répondre.',
    action100: 'Les utilisateurs finaux peuvent encore poser environ {extra} questions. Ensuite, les guides ne répondent plus jusqu\'au {date}. Dans l\'aperçu du builder, ils s\'arrêtent dès maintenant. Mettez à niveau votre plan pour qu\'ils continuent de répondre.',
    cta: 'Voir les plans'
  },
  es: {
    subject80: 'Tus guías de IA han usado el 80 % de las preguntas de este mes',
    subject100: 'Tus guías de IA han usado todas las preguntas de este mes',
    body80: 'Las guías de IA de {org} han respondido este mes {used} de las {limit} preguntas de tu plan. El contador se reinicia el {date}.',
    body100: 'Las guías de IA de {org} han respondido este mes todas las {limit} preguntas de tu plan.',
    action80: '¿Esperas más preguntas antes del {date}? Mejora tu plan para que tus guías sigan respondiendo.',
    action100: 'Los usuarios finales aún pueden hacer unas {extra} preguntas más. Después, las guías dejan de responder hasta el {date}. En la vista previa del builder se detienen ya. Mejora tu plan para que sigan respondiendo.',
    cta: 'Ver planes'
  }
};

/**
 * Tell an organization admin that the AI guides used 80% or 100% of this
 * month's questions (1 AI credit = 1 answered question).
 * @param {Object} options
 * @param {80|100} options.level
 * @param {Date|string} options.resetDate - End of the billing period
 * @param {number} options.extraQuestions - Questions end users may still ask over the limit
 */
export async function sendAiCreditsEmail({
  to,
  organizationName,
  level,
  limit,
  extraQuestions,
  resetDate,
  language = 'en'
}) {
  const texts = AI_CREDITS_EMAIL_TEXTS[language] || AI_CREDITS_EMAIL_TEXTS.en;
  const locale = AI_CREDITS_EMAIL_TEXTS[language] ? language : 'en';
  const date = new Date(resetDate).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  const used = level === 100 ? limit : Math.ceil(limit * 0.8);
  const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_m, key) => values[key] ?? '');
  const plain = { org: organizationName, used, limit, extra: extraQuestions, date };
  const html = { ...plain, org: escapeEmailHtml(organizationName) };

  const subject = level === 100 ? texts.subject100 : texts.subject80;
  const body = level === 100 ? texts.body100 : texts.body80;
  const action = level === 100 ? texts.action100 : texts.action80;
  const link = `${getAppBaseUrl()}/dashboard/subscription`;

  const customHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background: #f8fafc; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8fafc; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background: white; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 32px 36px 8px;">
              <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #0f172a; line-height: 1.4;">${escapeEmailHtml(subject)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 36px 32px;">
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155; line-height: 1.6;">${fill(escapeEmailHtml(body), html)}</p>
              <p style="margin: 0 0 24px 0; font-size: 15px; color: #334155; line-height: 1.6;">${fill(escapeEmailHtml(action), html)}</p>
              <a href="${link}" style="display: inline-block; padding: 14px 28px; background: #78C503; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px;">${escapeEmailHtml(texts.cta)}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const customText = `${subject}

${fill(body, plain)}

${fill(action, plain)}

${texts.cta}: ${link}`;

  return sendEmail({
    to,
    subject,
    templateType: 'limit_notification',
    variables: {},
    customBody: '',
    customHtml,
    customText,
    language
  });
}

/**
 * Send reminder email for invitation that hasn't been completed
 * Supports custom themes for Tier 3+ organizations
 */
export async function sendReminderEmail({
  to,
  firstName,
  journeyTitle,
  companyName = 'Gryffi',
  magicLink,
  daysRemaining,
  language = 'en',
  orgId = null,
  unsubscribeEmail = null
}) {
  // Get organization theme for custom branding
  const theme = orgId ? await getOrganizationEmailTheme(orgId) : DEFAULT_THEME;
  
  // Language-specific content
  // Terms: EN=Journey, NL=Expeditie, DE=Expedition, FR=Parcours, ES=Expedición
  const translations = {
    en: {
      subject: `Reminder: Complete your journey "${journeyTitle}"`,
      greeting: `Hello ${firstName},`,
      intro: `We noticed you haven't completed your journey "<strong>${journeyTitle}</strong>" at ${companyName} yet.`,
      reminder: `You still have <strong>${daysRemaining} days</strong> left to complete it. Don't miss out!`,
      instructions: 'Click the button below to continue where you left off.',
      button: 'Continue Journey',
      footer: "If you've already completed this journey or no longer wish to participate, you can ignore this email.",
      security: "This link is unique to you. Please don't share it with others."
    },
    nl: {
      subject: `Herinnering: Rond je expeditie "${journeyTitle}" af`,
      greeting: `Hallo ${firstName},`,
      intro: `We hebben gemerkt dat je je expeditie "<strong>${journeyTitle}</strong>" bij ${companyName} nog niet hebt afgerond.`,
      reminder: `Je hebt nog <strong>${daysRemaining} dagen</strong> om het af te ronden. Mis het niet!`,
      instructions: 'Klik op de knop hieronder om verder te gaan waar je gebleven was.',
      button: 'Ga Verder met Expeditie',
      footer: 'Als je deze expeditie al hebt afgerond of niet meer wilt deelnemen, kun je deze e-mail negeren.',
      security: 'Deze link is uniek voor jou. Deel hem alsjeblieft niet met anderen.'
    },
    de: {
      subject: `Erinnerung: Schließe deine Expedition "${journeyTitle}" ab`,
      greeting: `Hallo ${firstName},`,
      intro: `Wir haben bemerkt, dass du deine Expedition "<strong>${journeyTitle}</strong>" bei ${companyName} noch nicht abgeschlossen hast.`,
      reminder: `Du hast noch <strong>${daysRemaining} Tage</strong> Zeit, sie abzuschließen. Verpasse es nicht!`,
      instructions: 'Klicke auf den Button unten, um dort fortzufahren, wo du aufgehört hast.',
      button: 'Expedition Fortsetzen',
      footer: 'Wenn du diese Expedition bereits abgeschlossen hast oder nicht mehr teilnehmen möchtest, kannst du diese E-Mail ignorieren.',
      security: 'Dieser Link ist nur für dich bestimmt. Bitte teile ihn nicht mit anderen.'
    },
    fr: {
      subject: `Rappel : Terminez votre parcours "${journeyTitle}"`,
      greeting: `Bonjour ${firstName},`,
      intro: `Nous avons remarqué que vous n'avez pas encore terminé votre parcours "<strong>${journeyTitle}</strong>" chez ${companyName}.`,
      reminder: `Il vous reste encore <strong>${daysRemaining} jours</strong> pour le terminer. Ne manquez pas cette opportunité !`,
      instructions: 'Cliquez sur le bouton ci-dessous pour reprendre là où vous vous êtes arrêté.',
      button: 'Continuer le Parcours',
      footer: 'Si vous avez déjà terminé ce parcours ou ne souhaitez plus participer, vous pouvez ignorer cet e-mail.',
      security: 'Ce lien vous est unique. Veuillez ne pas le partager avec d\'autres.'
    },
    es: {
      subject: `Recordatorio: Completa tu expedición "${journeyTitle}"`,
      greeting: `Hola ${firstName},`,
      intro: `Hemos notado que aún no has completado tu expedición "<strong>${journeyTitle}</strong>" en ${companyName}.`,
      reminder: `Todavía tienes <strong>${daysRemaining} días</strong> para completarla. ¡No te lo pierdas!`,
      instructions: 'Haz clic en el botón de abajo para continuar donde lo dejaste.',
      button: 'Continuar Expedición',
      footer: 'Si ya has completado esta expedición o ya no deseas participar, puedes ignorar este correo electrónico.',
      security: 'Este enlace es único para ti. Por favor, no lo compartas con otros.'
    },
    it: {
      subject: `Promemoria: Completa il tuo percorso "${journeyTitle}"`,
      greeting: `Ciao ${firstName},`,
      intro: `Abbiamo notato che non hai ancora completato il tuo percorso "<strong>${journeyTitle}</strong>" presso ${companyName}.`,
      reminder: `Hai ancora <strong>${daysRemaining} giorni</strong> per completarlo. Non perdere l'occasione!`,
      instructions: 'Clicca il pulsante qui sotto per riprendere da dove avevi interrotto.',
      button: 'Continua il Percorso',
      footer: 'Se hai già completato questo percorso o non desideri più partecipare, puoi ignorare questa e-mail.',
      security: 'Questo link è unico per te. Per favore, non condividerlo con altri.'
    },
    pt: {
      subject: `Lembrete: Complete sua jornada "${journeyTitle}"`,
      greeting: `Olá ${firstName},`,
      intro: `Notamos que você ainda não completou sua jornada "<strong>${journeyTitle}</strong>" na ${companyName}.`,
      reminder: `Você ainda tem <strong>${daysRemaining} dias</strong> para completá-la. Não perca!`,
      instructions: 'Clique no botão abaixo para continuar de onde parou.',
      button: 'Continuar Jornada',
      footer: 'Se você já completou esta jornada ou não deseja mais participar, pode ignorar este e-mail.',
      security: 'Este link é exclusivo para você. Por favor, não o compartilhe com outras pessoas.'
    },
    da: {
      subject: `Påmindelse: Færdiggør din rejse "${journeyTitle}"`,
      greeting: `Hej ${firstName},`,
      intro: `Vi har bemærket, at du endnu ikke har færdiggjort din rejse "<strong>${journeyTitle}</strong>" hos ${companyName}.`,
      reminder: `Du har stadig <strong>${daysRemaining} dage</strong> til at færdiggøre den. Gå ikke glip af det!`,
      instructions: 'Klik på knappen nedenfor for at fortsætte, hvor du slap.',
      button: 'Fortsæt Rejse',
      footer: 'Hvis du allerede har færdiggjort denne rejse eller ikke længere ønsker at deltage, kan du ignorere denne e-mail.',
      security: 'Dette link er unikt for dig. Del det venligst ikke med andre.'
    },
    no: {
      subject: `Påminnelse: Fullfør reisen din "${journeyTitle}"`,
      greeting: `Hei ${firstName},`,
      intro: `Vi har lagt merke til at du ikke har fullført reisen din "<strong>${journeyTitle}</strong>" hos ${companyName} ennå.`,
      reminder: `Du har fortsatt <strong>${daysRemaining} dager</strong> igjen for å fullføre den. Ikke gå glipp av det!`,
      instructions: 'Klikk på knappen nedenfor for å fortsette der du slapp.',
      button: 'Fortsett Reise',
      footer: 'Hvis du allerede har fullført denne reisen eller ikke lenger ønsker å delta, kan du ignorere denne e-posten.',
      security: 'Denne lenken er unik for deg. Vennligst ikke del den med andre.'
    },
    fi: {
      subject: `Muistutus: Suorita matkasi "${journeyTitle}" loppuun`,
      greeting: `Hei ${firstName},`,
      intro: `Huomasimme, ettet ole vielä suorittanut matkaasi "<strong>${journeyTitle}</strong>" organisaatiossa ${companyName}.`,
      reminder: `Sinulla on vielä <strong>${daysRemaining} päivää</strong> aikaa suorittaa se. Älä jää paitsi!`,
      instructions: 'Napsauta alla olevaa painiketta jatkaaksesi siitä, mihin jäit.',
      button: 'Jatka Matkaa',
      footer: 'Jos olet jo suorittanut tämän matkan tai et halua enää osallistua, voit jättää tämän sähköpostin huomiotta.',
      security: 'Tämä linkki on tarkoitettu vain sinulle. Älä jaa sitä muille.'
    },
    sv: {
      subject: `Påminnelse: Slutför din resa "${journeyTitle}"`,
      greeting: `Hej ${firstName},`,
      intro: `Vi har märkt att du inte har slutfört din resa "<strong>${journeyTitle}</strong>" hos ${companyName} ännu.`,
      reminder: `Du har fortfarande <strong>${daysRemaining} dagar</strong> kvar att slutföra den. Missa inte det!`,
      instructions: 'Klicka på knappen nedan för att fortsätta där du slutade.',
      button: 'Fortsätt Resa',
      footer: 'Om du redan har slutfört denna resa eller inte längre vill delta kan du ignorera detta e-postmeddelande.',
      security: 'Denna länk är unik för dig. Vänligen dela den inte med andra.'
    },
    pl: {
      subject: `Przypomnienie: Dokończ swoją podróż "${journeyTitle}"`,
      greeting: `Cześć ${firstName},`,
      intro: `Zauważyliśmy, że nie ukończyłeś jeszcze swojej podróży "<strong>${journeyTitle}</strong>" w ${companyName}.`,
      reminder: `Masz jeszcze <strong>${daysRemaining} dni</strong> na jej ukończenie. Nie przegap!`,
      instructions: 'Kliknij poniższy przycisk, aby kontynuować od miejsca, w którym skończyłeś.',
      button: 'Kontynuuj Podróż',
      footer: 'Jeśli już ukończyłeś tę podróż lub nie chcesz już uczestniczyć, możesz zignorować tę wiadomość.',
      security: 'Ten link jest przeznaczony tylko dla Ciebie. Prosimy, nie udostępniaj go innym.'
    },
    ro: {
      subject: `Memento: Finalizează-ți călătoria "${journeyTitle}"`,
      greeting: `Bună ${firstName},`,
      intro: `Am observat că nu ai finalizat încă călătoria "<strong>${journeyTitle}</strong>" la ${companyName}.`,
      reminder: `Mai ai <strong>${daysRemaining} zile</strong> să o finalizezi. Nu rata această oportunitate!`,
      instructions: 'Apasă butonul de mai jos pentru a continua de unde ai rămas.',
      button: 'Continuă Călătoria',
      footer: 'Dacă ai finalizat deja această călătorie sau nu mai dorești să participi, poți ignora acest e-mail.',
      security: 'Acest link este unic pentru tine. Te rugăm să nu-l distribui altora.'
    },
    tr: {
      subject: `Hatırlatma: "${journeyTitle}" yolculuğunuzu tamamlayın`,
      greeting: `Merhaba ${firstName},`,
      intro: `${companyName} bünyesindeki "<strong>${journeyTitle}</strong>" yolculuğunuzu henüz tamamlamadığınızı fark ettik.`,
      reminder: `Tamamlamak için hâlâ <strong>${daysRemaining} gününüz</strong> var. Bu fırsatı kaçırmayın!`,
      instructions: 'Kaldığınız yerden devam etmek için aşağıdaki düğmeye tıklayın.',
      button: 'Yolculuğa Devam Et',
      footer: 'Bu yolculuğu zaten tamamladıysanız veya artık katılmak istemiyorsanız, bu e-postayı görmezden gelebilirsiniz.',
      security: 'Bu bağlantı size özeldir. Lütfen başkalarıyla paylaşmayın.'
    }
  };

  const t = translations[language] || translations.en;
  
  // Use custom theme colors or default Gryffi colors
  const bgColor = theme.background;
  const primaryColor = theme.primary;
  const accentColor = theme.accent;
  const reminderColor = '#f59e0b';
  const appUrl = getAppBaseUrl();
  const emailAssetsUrl = process.env.EMAIL_ASSETS_URL || appUrl;
  const defaultLogoUrl = `${emailAssetsUrl}/images/logos/Logo---illustration-only-cropped-transparant.png`;
  const logoUrl = theme.logoUrl ? `${emailAssetsUrl}${theme.logoUrl}` : defaultLogoUrl;

  const html = `
<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${t.subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${bgColor}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  
  <!-- Preheader -->
  <div style="display: none; max-height: 0; overflow: hidden;">
    ${t.intro.replace(/<[^>]*>/g, '')}
  </div>
  
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: ${bgColor}; padding: 48px 20px;">
    <tr>
      <td align="center">
        
        <!-- Logo -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin-bottom: 24px;">
          <tr>
            <td align="center">
              <img src="${logoUrl}" alt="Gryffi" width="64" height="64" 
                   style="display: block; width: 64px; height: 64px; object-fit: contain;">
            </td>
          </tr>
        </table>
        
        <!-- Main Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(11, 75, 52, 0.08);">
          
          <!-- Reminder Accent Bar -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, ${reminderColor} 0%, ${accentColor} 100%);"></td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 36px 32px 36px;">
              
              <!-- Reminder Badge -->
              <div style="text-align: center; margin-bottom: 24px;">
                <span style="display: inline-block; background: ${reminderColor}15; color: ${reminderColor}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                  ⏰ Reminder
                </span>
              </div>
              
              <!-- Greeting -->
              <p style="margin: 0 0 24px 0; color: ${primaryColor}; font-size: 20px; font-weight: 600;">
                ${t.greeting}
              </p>
              
              <!-- Intro -->
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #334155;">
                ${t.intro}
              </p>
              
              <!-- Reminder message with highlight -->
              <div style="background: ${reminderColor}10; border-left: 4px solid ${reminderColor}; padding: 16px; margin: 16px 0; border-radius: 0 8px 8px 0;">
                <p style="margin: 0; font-size: 15px; line-height: 1.7; color: #334155;">
                  ${t.reminder}
                </p>
              </div>
              
              <!-- Instructions -->
              <p style="margin: 0 0 32px 0; font-size: 15px; line-height: 1.7; color: #64748b;">
                ${t.instructions}
              </p>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 32px 0;">
                <tr>
                  <td align="center">
                    <a href="${magicLink}" 
                       style="display: inline-block; padding: 16px 40px; background: ${primaryColor}; color: white; font-size: 16px; font-weight: 600; text-decoration: none; border-radius: 12px; box-shadow: 0 4px 16px rgba(11, 75, 52, 0.25);">
                      ${t.button}
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Security note -->
              <p style="margin: 0; font-size: 13px; color: #94a3b8; text-align: center; font-style: italic;">
                ${t.security}
              </p>
              
            </td>
          </tr>
          
          <!-- Divider -->
          <tr>
            <td style="padding: 0 36px;">
              <div style="height: 1px; background: #e2e8f0;"></div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 36px 32px 36px;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px; text-align: center;">
                ${t.footer}
              </p>
            </td>
          </tr>
          
        </table>
        
        <!-- Bottom Footer -->
        <!-- powered-by:start -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; margin-top: 24px;">
          <tr>
            <td align="center">
              <p style="margin: 0; color: #64748b; font-size: 11px;">
                Powered by <span style="color: ${primaryColor}; font-weight: 500;">Gryffi</span> · Interactive Journey Builder
              </p>
            </td>
          </tr>
        </table>
        <!-- powered-by:end -->
        
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const text = `${t.greeting}

${t.intro.replace(/<[^>]*>/g, '')}

${t.reminder.replace(/<[^>]*>/g, '')}

${t.instructions}

${t.button}: ${magicLink}

${t.security}

---
${t.footer}

Powered by Gryffi`;

  return sendEmail({
    to,
    subject: t.subject,
    templateType: 'journey_reminder',
    variables: {},
    customBody: '',
    customHtml: html,
    customText: text,
    language,
    unsubscribeEmail
  });
}
