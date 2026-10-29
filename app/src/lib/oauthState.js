/**
 * OAuth state signing/verification (CSRF protection for OAuth connect flows)
 *
 * The OAuth `state` parameter carries the organization id that the resulting
 * tokens get written to. If an attacker can forge that value, they can attach
 * their own provider account to a victim organization (account takeover).
 *
 * We therefore HMAC-sign the state with SESSION_SECRET. The callback only
 * trusts an orgId that comes from a state we signed ourselves, so an attacker
 * who does not know SESSION_SECRET cannot produce a valid state for an org
 * they don't control. This does not rely on the session cookie surviving the
 * cross-site OAuth redirect (the callback additionally binds to the session
 * when it is present, as defense in depth).
 */
import crypto from 'crypto';

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not configured; cannot sign OAuth state');
  }
  return secret;
}

/**
 * Sign an OAuth state payload. Returns `<base64url(payload)>.<base64url(hmac)>`.
 * A `timestamp` is added automatically if not present.
 */
export function signOAuthState(payload = {}) {
  const data = { ...payload };
  if (typeof data.timestamp !== 'number') {
    data.timestamp = Date.now();
  }
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verify a signed OAuth state. Returns the decoded payload object on success,
 * or null when the signature is invalid, the format is wrong, or it expired.
 */
export function verifyOAuthState(state, { maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (typeof state !== 'string' || !state.includes('.')) return null;

  const [body, sig] = state.split('.');
  if (!body || !sig) return null;

  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch (_e) {
    return null;
  }

  if (!payload || typeof payload.timestamp !== 'number') return null;
  if (Date.now() - payload.timestamp > maxAgeMs) return null;

  return payload;
}
