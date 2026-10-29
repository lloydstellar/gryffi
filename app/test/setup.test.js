/**
 * Tests for the first-run setup (src/setup/setup.js): the one-time code and
 * the account validation. The code is stored in the settings table, so the
 * code tests only run with GRYFFI_TEST_DB=1.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSettings } from './helpers/settingsSnapshot.js';

const enabled = process.env.GRYFFI_TEST_DB === '1';
const dbTest = (name, fn) => test(name, { skip: !enabled && 'set GRYFFI_TEST_DB=1 to run' }, fn);

let setup;
let settings;
let query;
let restoreSettings;

before(async () => {
  setup = await import('../src/setup/setup.js');
  if (!enabled) return;
  settings = await import('../src/services/settings.js');
  ({ query } = await import('../src/db/index.js'));
  restoreSettings = await snapshotSettings(query);
});

after(async () => {
  if (!enabled) return;
  await restoreSettings();
  const { default: pool } = await import('../src/db/index.js');
  await pool.end();
});

dbTest('accepts a fresh setup code in any case and with spaces, and only that code', async () => {
  const { code, url } = await setup.createSetupCode();
  assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  assert.ok(url.endsWith(`/setup?code=${code}`));
  assert.equal(await setup.verifySetupCode(code), true);
  assert.equal(await setup.verifySetupCode(code.toLowerCase().replace(/-/g, ' ')), true);
  assert.equal(await setup.verifySetupCode('AAAA-BBBB-CCCC-DDDD'), false);
  assert.equal(await setup.verifySetupCode(''), false);
});

dbTest('a new code replaces the old one', async () => {
  const first = await setup.createSetupCode();
  const second = await setup.createSetupCode();
  assert.equal(await setup.verifySetupCode(first.code), false);
  assert.equal(await setup.verifySetupCode(second.code), true);
});

dbTest('an expired code no longer works', async () => {
  const { code } = await setup.createSetupCode();
  await settings.setSettings({ 'setup.codeExpiresAt': new Date(Date.now() - 1000).toISOString() });
  assert.equal(await setup.verifySetupCode(code), false);
});

dbTest('the code is stored as a hash and kept out of the described settings', async () => {
  const { code } = await setup.createSetupCode();
  const stored = (await query("SELECT value FROM instance_settings WHERE key = 'setup.codeHash'")).rows[0].value;
  assert.ok(!stored.includes(code));
  const described = (await settings.describeSettings()).map((s) => s.key);
  assert.ok(!described.includes('setup.codeHash'));
});

test('validates the organization and admin input', () => {
  const valid = { organizationName: 'Acme', language: 'nl', firstName: 'Ada', lastName: 'Admin', email: 'ada@acme.example', password: 'twelve chars!' };
  assert.doesNotThrow(() => setup.validateAccountInput(valid));
  const cases = [
    [{ organizationName: 'A' }, 'ORG_NAME_REQUIRED'],
    [{ language: 'it' }, 'LANGUAGE_INVALID'],
    [{ firstName: ' ' }, 'NAME_REQUIRED'],
    [{ email: 'not-an-email' }, 'EMAIL_INVALID'],
    [{ password: 'short' }, 'PASSWORD_TOO_SHORT']
  ];
  for (const [change, code] of cases) {
    assert.throws(() => setup.validateAccountInput({ ...valid, ...change }), (err) => err.code === code);
  }
});
