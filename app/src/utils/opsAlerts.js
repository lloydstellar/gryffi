/**
 * Operator notifications
 *
 * Mail meant for whoever runs this installation (security alerts, the nightly
 * lint report, signup and cleanup notices) goes to OPS_ALERT_EMAIL. When that
 * is not set, callers only log the notice.
 */

/**
 * @returns {string|null} Address for operator notifications, or null when none is set
 */
export function getOpsAlertEmail() {
  const email = (process.env.OPS_ALERT_EMAIL || '').trim();
  return email || null;
}
