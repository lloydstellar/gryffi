/**
 * Tests for the magic-link tokens of invitations (src/services/invitationTokens.js)
 *
 * The tests against PostgreSQL run when GRYFFI_TEST_DB=1 (the conversion test
 * adds an organization with one invitation and removes it afterwards):
 *
 *   GRYFFI_TEST_DB=1 npm test
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

const enabled = process.env.GRYFFI_TEST_DB === '1';
const dbTest = (name, fn) => test(name, { skip: !enabled && 'set GRYFFI_TEST_DB=1 to run' }, fn);

process.env.OAUTH_TOKEN_KEY ||= '0'.repeat(64);
const { hashInvitationToken, newInvitationToken, invitationToken, protectStoredInvitationTokens, restoreInvitationTokens } =
  await import('../src/services/invitationTokens.js');
const orgIds = [];

after(async () => {
  if (!enabled) return;
  const { query, default: pool } = await import('../src/db/index.js');
  for (const id of orgIds) await query('DELETE FROM organizations WHERE id = $1', [id]);
  await pool.end?.();
});

test('hash is the SHA-256 of the token in hex', () => {
  assert.equal(hashInvitationToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('a new token is random and stored only as hash and encrypted copy', () => {
  const first = newInvitationToken();
  const second = newInvitationToken();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashInvitationToken(first.token));
  assert.ok(first.tokenEncrypted.startsWith('enc:v1:'));
  assert.ok(!first.tokenEncrypted.includes(first.token));
});

test('public API tokens are 64 hex characters, as before', () => {
  assert.match(newInvitationToken('hex').token, /^[0-9a-f]{64}$/);
});

test('the token for an email comes from the encrypted copy', () => {
  const { token, tokenEncrypted } = newInvitationToken();
  assert.equal(invitationToken({ token: null, token_encrypted: tokenEncrypted }), token);
});

test('an invitation from before the change still gives its plain token', () => {
  assert.equal(invitationToken({ token: 'legacy-token', token_encrypted: null }), 'legacy-token');
  assert.equal(invitationToken({ token: null, token_encrypted: null }), null);
  assert.equal(invitationToken(null), null);
});

dbTest('PostgreSQL computes the same hash as the lookups in auth.js', async () => {
  const { query } = await import('../src/db/index.js');
  for (const token of [newInvitationToken().token, newInvitationToken('hex').token, 'tøken-ü']) {
    const result = await query("SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS hash", [token]);
    assert.equal(result.rows[0].hash, hashInvitationToken(token));
  }
});

dbTest('at start the plain token stays; the hourly run removes it; a rollback can restore it', async () => {
  const { query } = await import('../src/db/index.js');
  const suffix = crypto.randomBytes(4).toString('hex');
  const org = (await query('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id', [`Token test ${suffix}`, `token-test-${suffix}`])).rows[0].id;
  orgIds.push(org);
  const journey = (await query('INSERT INTO journeys (organization_id, title) VALUES ($1, $2) RETURNING id', [org, 'Token test'])).rows[0].id;
  const user = (await query("INSERT INTO end_users (organization_id, email, first_name, last_name) VALUES ($1, $2, 'Pat', 'Test') RETURNING id", [org, `pat-${suffix}@example.com`])).rows[0].id;
  // As after the migration: plain token and its hash, no encrypted copy yet
  const id = (await query(
    `INSERT INTO invitations (organization_id, journey_id, end_user_id, token, token_hash, expires_at)
     VALUES ($1, $2, $3, 'legacy-token', encode(sha256(convert_to('legacy-token', 'UTF8')), 'hex'), NOW() + INTERVAL '7 days') RETURNING id`,
    [org, journey, user]
  )).rows[0].id;
  const row = async () => (await query('SELECT token, token_hash, token_encrypted FROM invitations WHERE id = $1', [id])).rows[0];

  // Start: hash and encrypted copy, plain token kept for a rollback to an older version
  await protectStoredInvitationTokens();
  let r = await row();
  assert.equal(r.token, 'legacy-token');
  assert.equal(r.token_hash, hashInvitationToken('legacy-token'));
  assert.ok(r.token_encrypted);
  assert.equal(invitationToken(r), 'legacy-token');

  // An older version changed the plain token after a rollback: hash and copy follow it
  await query("UPDATE invitations SET token = 'changed-token' WHERE id = $1", [id]);
  await protectStoredInvitationTokens();
  r = await row();
  assert.equal(r.token_hash, hashInvitationToken('changed-token'));
  assert.equal(invitationToken(r), 'changed-token');

  // Hourly run: the plain token goes
  await protectStoredInvitationTokens({ removePlain: true });
  r = await row();
  assert.equal(r.token, null);
  assert.equal(invitationToken(r), 'changed-token');

  // Before a rollback to an older version: the plain token comes back from the copy
  await restoreInvitationTokens();
  assert.equal((await row()).token, 'changed-token');
});
