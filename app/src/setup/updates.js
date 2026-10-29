/**
 * Update check (Community Edition)
 *
 * Once a day Gryffi asks GitHub for the version number of the latest release,
 * so admins see when an update is available. That request sends nothing about
 * the installation. Admins switch it off with the setting updates.check.
 */
import { getSetting } from '../services/settings.js';

const RELEASES_API = 'https://api.github.com/repos/lloydstellar/gryffi/releases/latest';
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

let latest = { version: null, url: null, checkedAt: null };
let firstCheck = null;
let dailyCheck = null;

/**
 * Version of this installation, baked into the image (GRYFFI_VERSION).
 * Anything that is not x.y.z is a development build.
 */
export function currentVersion() {
  return process.env.GRYFFI_VERSION || 'dev';
}

/**
 * Whether version a is newer than version b (both x.y.z).
 */
export function isNewerVersion(a, b) {
  if (!VERSION_PATTERN.test(a || '') || !VERSION_PATTERN.test(b || '')) return false;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

/**
 * Ask GitHub for the latest release. Failures are logged and keep the last
 * known answer.
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export async function checkForUpdate({ fetchImpl = fetch } = {}) {
  if (!(await getSetting('updates.check'))) return latest;
  if (!VERSION_PATTERN.test(currentVersion())) return latest;
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gryffi-update-check' },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      console.warn(`[Updates] GitHub answered ${response.status}`);
      return latest;
    }
    const release = await response.json();
    const version = String(release.tag_name || '').replace(/^v/, '');
    if (VERSION_PATTERN.test(version)) {
      latest = { version, url: release.html_url || null, checkedAt: new Date().toISOString() };
    }
  } catch (err) {
    console.warn('[Updates] Check failed:', err.message);
  }
  return latest;
}

/**
 * What the dashboard shows about versions.
 */
export async function getUpdateStatus() {
  const enabled = await getSetting('updates.check');
  const current = currentVersion();
  return {
    enabled,
    current,
    development: !VERSION_PATTERN.test(current),
    latest: enabled ? latest.version : null,
    url: enabled ? latest.url : null,
    checkedAt: enabled ? latest.checkedAt : null,
    available: enabled && isNewerVersion(latest.version, current)
  };
}

/**
 * Check a minute after startup, then once a day.
 */
export function startUpdateChecks() {
  stopUpdateChecks();
  firstCheck = setTimeout(() => checkForUpdate(), FIRST_CHECK_DELAY_MS);
  dailyCheck = setInterval(() => checkForUpdate(), DAY_MS);
  firstCheck.unref?.();
  dailyCheck.unref?.();
}

export function stopUpdateChecks() {
  clearTimeout(firstCheck);
  clearInterval(dailyCheck);
  firstCheck = null;
  dailyCheck = null;
}
