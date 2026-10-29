/**
 * First-run setup (Community Edition)
 *
 * A new installation has no organization and no admin. Until the setup wizard
 * has run, every page redirects to /setup. The wizard only opens with a
 * one-time setup code, printed in the application log at startup (and on
 * request with `node src/setup/cli.js new-code`), so nobody else can take over
 * a freshly started server. Only a hash of the code is stored.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { getClient } from '../db/index.js';
import { getSetting, setSettings, SETTINGS } from '../services/settings.js';
import { ensureCommunityTier } from '../services/subscription.js';
import { getAppBaseUrl } from '../utils/appUrl.js';

const CODE_VALID_HOURS = 72;
// Crockford base32 without look-alike characters
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const MIN_PASSWORD_LENGTH = 12;
const MAKER_LANGUAGES = ['en', 'nl', 'de', 'fr', 'es'];

/**
 * Raised for wizard input that cannot be used; `field` names the form field.
 */
export class SetupInputError extends Error {
  constructor(field, code) {
    super(code);
    this.name = 'SetupInputError';
    this.field = field;
    this.code = code;
  }
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase().replace(/[\s-]/g, '')).digest('hex');
}

/**
 * Whether the setup wizard has completed.
 * @returns {Promise<boolean>}
 */
export async function isSetupCompleted() {
  return (await getSetting('setup.completed')) === true;
}

/**
 * Create a new one-time setup code; any older code stops working.
 * @returns {Promise<{code: string, url: string, expiresAt: string}>}
 */
export async function createSetupCode() {
  const bytes = crypto.randomBytes(16);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  const code = chars.match(/.{4}/g).join('-');
  const expiresAt = new Date(Date.now() + CODE_VALID_HOURS * 3600 * 1000).toISOString();
  await setSettings({ 'setup.codeHash': hashCode(code), 'setup.codeExpiresAt': expiresAt });
  return { code, url: `${getAppBaseUrl()}/setup?code=${code}`, expiresAt };
}

/**
 * Check a setup code from the browser.
 * @param {string} code
 * @returns {Promise<boolean>}
 */
export async function verifySetupCode(code) {
  if (!code) return false;
  const [storedHash, expiresAt] = await Promise.all([getSetting('setup.codeHash'), getSetting('setup.codeExpiresAt')]);
  if (!storedHash || !expiresAt || Date.parse(expiresAt) < Date.now()) return false;
  const given = Buffer.from(hashCode(code), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
}

/**
 * At startup of an installation without setup: print a fresh setup link.
 */
export async function announceSetup() {
  const { url, expiresAt } = await createSetupCode();
  const line = '='.repeat(72);
  console.log(`\n${line}\n Gryffi is not set up yet. Open this link to start the setup wizard:\n\n   ${url}\n\n The link works until ${expiresAt}. A new link: gryffi setup-code\n (without the gryffi command: docker compose exec app node src/setup/cli.js new-code)\n${line}\n`);
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'organization';
}

/**
 * Validate the organization and admin part of the wizard.
 * @throws {SetupInputError}
 */
export function validateAccountInput({ organizationName, language, firstName, lastName, email, password }) {
  if (!organizationName || String(organizationName).trim().length < 2) throw new SetupInputError('organizationName', 'ORG_NAME_REQUIRED');
  if (!MAKER_LANGUAGES.includes(language)) throw new SetupInputError('language', 'LANGUAGE_INVALID');
  if (!firstName || !String(firstName).trim()) throw new SetupInputError('firstName', 'NAME_REQUIRED');
  if (!lastName || !String(lastName).trim()) throw new SetupInputError('lastName', 'NAME_REQUIRED');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())) throw new SetupInputError('email', 'EMAIL_INVALID');
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) throw new SetupInputError('password', 'PASSWORD_TOO_SHORT');
}

/**
 * Run the installation: save the settings, create the organization and its
 * first admin, and close the wizard. Steps are reported through `progress`.
 *
 * @param {Object} input
 * @param {Object} input.account - organizationName, language, firstName, lastName, email, password
 * @param {Object<string, *>} input.settings - installation settings (keys from SETTINGS)
 * @param {(step: string) => void} [progress]
 * @returns {Promise<{organizationId: string, userId: string}>}
 */
export async function runInstallation({ account, settings }, progress = () => {}) {
  validateAccountInput(account);
  const allowed = Object.fromEntries(Object.entries(settings || {})
    .filter(([key]) => SETTINGS[key] && !SETTINGS[key].internal && key !== 'setup.completed'));

  // One installation at a time: a second request (another tab, a retry)
  // waits here and then finds the first one done, before it writes anything
  const client = await getClient();
  let organizationId;
  let userId;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('gryffi.setup'))");
    if (await isSetupCompleted()) throw new SetupInputError(null, 'ALREADY_INSTALLED');
    const existing = await client.query('SELECT count(*)::int AS n FROM organizations');
    if (existing.rows[0].n > 0) throw new SetupInputError(null, 'ALREADY_INSTALLED');

    progress('settings');
    await setSettings(allowed);

    progress('account');
    try {
      await client.query('BEGIN');
      const name = String(account.organizationName).trim();
      const org = await client.query(
        `INSERT INTO organizations (name, slug, settings, language)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id`,
        [name, slugify(name), JSON.stringify({ default_language: account.language, default_language_mode: 'fixed' }), account.language]
      );
      organizationId = org.rows[0].id;

      const passwordHash = await bcrypt.hash(String(account.password), 12);
      const user = await client.query(
        `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, 'admin', NOW())
         RETURNING id`,
        [organizationId, String(account.email).trim().toLowerCase(), passwordHash, String(account.firstName).trim(), String(account.lastName).trim()]
      );
      userId = user.rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    progress('plan');
    await ensureCommunityTier();

    progress('finish');
    await setSettings({ 'setup.completed': true, 'setup.codeHash': null, 'setup.codeExpiresAt': null }, { userId });
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('gryffi.setup'))").catch(() => {});
    client.release();
  }

  return { organizationId, userId };
}
