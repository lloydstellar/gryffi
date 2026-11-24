/**
 * Login verification codes
 *
 * Sent by email when a maker has two-factor authentication on or after
 * failed login attempts, and when a participant opens a magic link on a new
 * device. Six digits, as users.login_verification_code and
 * invitation_sessions.verification_code (both VARCHAR(6)) store them.
 */
import crypto from 'crypto';

export const LOGIN_CODE_LENGTH = 6;

/**
 * A random code of LOGIN_CODE_LENGTH digits; the first digit is never 0, so
 * the code keeps its length when someone reads or types it as a number.
 * @returns {string}
 */
export function generateLoginCode() {
  const min = 10 ** (LOGIN_CODE_LENGTH - 1);
  return crypto.randomInt(min, min * 10).toString();
}
