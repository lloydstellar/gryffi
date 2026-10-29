/**
 * Public base URL of the app, for links in emails and redirects
 *
 * Always taken from APP_URL. Never build links from the Host or
 * X-Forwarded-Host header: a client can send any value there, which would
 * put an attacker's domain into password reset and invitation emails.
 */

/**
 * @returns {string} Base URL without trailing slash, e.g. https://gryffi.com
 */
export function getAppBaseUrl() {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
