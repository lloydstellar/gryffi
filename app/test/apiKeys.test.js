/**
 * Tests for public API keys (src/services/apiKeys.js) and the wording of
 * invitation mails (src/utils/invitationText.js).
 *
 * The database tests make their own organizations and remove them afterwards.
 * They run when GRYFFI_TEST_DB=1:
 *
 *   GRYFFI_TEST_DB=1 npm test
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { apiKeyLookup, newApiKey, findOrganizationByApiKey } from '../src/services/apiKeys.js';
import { invitationEmailLanguage, invitationValidityText } from '../src/utils/invitationText.js';

const enabled = process.env.GRYFFI_TEST_DB === '1';
const dbTest = (name, fn) => test(name, { skip: !enabled && 'set GRYFFI_TEST_DB=1 to run' }, fn);

const orgIds = [];

after(async () => {
  if (!enabled) return;
  const { query, default: pool } = await import('../src/db/index.js');
  for (const id of orgIds) await query('DELETE FROM organizations WHERE id = $1', [id]);
  await pool.end?.();
});

test('a new key has the grf_ format, a bcrypt hash and its SHA-256 lookup value', async () => {
  const { apiKey, hash, lookup } = await newApiKey();
  assert.match(apiKey, /^grf_[0-9a-f]{64}$/);
  assert.equal(await bcrypt.compare(apiKey, hash), true);
  assert.equal(lookup, apiKeyLookup(apiKey));
  assert.match(lookup, /^[0-9a-f]{64}$/);
  assert.notEqual(apiKeyLookup(apiKey + 'x'), lookup);
});

test('invitation mails: validity in the language of the mail', () => {
  assert.equal(invitationValidityText('nl', 30), '1 maand');
  assert.equal(invitationValidityText('de', 14), '2 Wochen');
  assert.equal(invitationValidityText('xx', 7), '1 week');
  assert.equal(invitationValidityText('nl', 45), '45 days');
});

test('invitation mails: the journey language wins only when the maker set it', () => {
  assert.equal(invitationEmailLanguage({ language_override: true, language_code: 'de' }, 'nl'), 'de');
  assert.equal(invitationEmailLanguage({ language_override: false, language_code: 'de' }, 'nl'), 'nl');
  assert.equal(invitationEmailLanguage('{"language_override":true,"language_code":"fr"}', 'nl'), 'fr');
  assert.equal(invitationEmailLanguage(null, null), 'en');
});

async function organization() {
  const { query } = await import('../src/db/index.js');
  const suffix = crypto.randomBytes(4).toString('hex');
  const id = (await query('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id', [`API key test ${suffix}`, `api-key-test-${suffix}`])).rows[0].id;
  orgIds.push(id);
  return id;
}

dbTest('a key is found by its lookup value', async () => {
  const { query } = await import('../src/db/index.js');
  const orgId = await organization();
  const { apiKey, hash, lookup } = await newApiKey();
  await query('UPDATE organizations SET api_key_hash = $1, api_key_lookup = $2 WHERE id = $3', [hash, lookup, orgId]);
  assert.equal((await findOrganizationByApiKey(apiKey))?.id, orgId);
  assert.equal(await findOrganizationByApiKey('grf_' + '0'.repeat(64)), null);
});

dbTest('a key from before the lookup value is found once with bcrypt and then gets it', async () => {
  const { query } = await import('../src/db/index.js');
  const orgId = await organization();
  const { apiKey, hash } = await newApiKey();
  await query('UPDATE organizations SET api_key_hash = $1, api_key_lookup = NULL WHERE id = $2', [hash, orgId]);
  assert.equal((await findOrganizationByApiKey(apiKey))?.id, orgId);
  const stored = await query('SELECT api_key_lookup FROM organizations WHERE id = $1', [orgId]);
  assert.equal(stored.rows[0].api_key_lookup, apiKeyLookup(apiKey));
});
