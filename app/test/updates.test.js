/**
 * Tests for the update check (src/setup/updates.js). The check reads the
 * setting updates.check, so those tests only run with GRYFFI_TEST_DB=1.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSettings } from './helpers/settingsSnapshot.js';

const enabled = process.env.GRYFFI_TEST_DB === '1';
const dbTest = (name, fn) => test(name, { skip: !enabled && 'set GRYFFI_TEST_DB=1 to run' }, fn);

const updates = await import('../src/setup/updates.js');
let settings;
let restoreSettings;
const originalVersion = process.env.GRYFFI_VERSION;

const release = (tag, status = 200) => async () => ({
  ok: status === 200,
  status,
  json: async () => ({ tag_name: tag, html_url: `https://github.com/lloydstellar/gryffi/releases/tag/${tag}` })
});

before(async () => {
  if (!enabled) return;
  settings = await import('../src/services/settings.js');
  const { query } = await import('../src/db/index.js');
  restoreSettings = await snapshotSettings(query);
});

after(async () => {
  if (originalVersion === undefined) delete process.env.GRYFFI_VERSION;
  else process.env.GRYFFI_VERSION = originalVersion;
  if (!enabled) return;
  await restoreSettings();
  const { default: pool } = await import('../src/db/index.js');
  await pool.end();
});

test('compares versions by number, not as text', () => {
  assert.equal(updates.isNewerVersion('1.10.0', '1.9.3'), true);
  assert.equal(updates.isNewerVersion('2.0.0', '1.99.99'), true);
  assert.equal(updates.isNewerVersion('1.2.3', '1.2.3'), false);
  assert.equal(updates.isNewerVersion('1.2.2', '1.2.3'), false);
  assert.equal(updates.isNewerVersion('1.3.0', 'dev'), false);
  assert.equal(updates.isNewerVersion(null, '1.0.0'), false);
});

dbTest('reports a newer release', async () => {
  process.env.GRYFFI_VERSION = '1.0.0';
  await settings.setSettings({ 'updates.check': true });
  await updates.checkForUpdate({ fetchImpl: release('v1.1.0') });
  const status = await updates.getUpdateStatus();
  assert.equal(status.available, true);
  assert.equal(status.latest, '1.1.0');
  assert.match(status.url, /releases\/tag\/v1\.1\.0$/);
});

dbTest('keeps the last answer when GitHub fails, and ignores odd tags', async () => {
  process.env.GRYFFI_VERSION = '1.0.0';
  await updates.checkForUpdate({ fetchImpl: release('v1.1.0') });
  await updates.checkForUpdate({ fetchImpl: release('v9.9.9', 500) });
  await updates.checkForUpdate({ fetchImpl: release('nightly') });
  await updates.checkForUpdate({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await updates.getUpdateStatus()).latest, '1.1.0');
});

dbTest('asks nothing and shows nothing when the check is off', async () => {
  process.env.GRYFFI_VERSION = '1.0.0';
  await settings.setSettings({ 'updates.check': false });
  let asked = false;
  await updates.checkForUpdate({ fetchImpl: async () => { asked = true; return release('v2.0.0')(); } });
  const status = await updates.getUpdateStatus();
  assert.equal(asked, false);
  assert.equal(status.available, false);
  assert.equal(status.latest, null);
});

dbTest('a development build never asks', async () => {
  process.env.GRYFFI_VERSION = 'dev';
  await settings.setSettings({ 'updates.check': true });
  let asked = false;
  await updates.checkForUpdate({ fetchImpl: async () => { asked = true; return release('v2.0.0')(); } });
  const status = await updates.getUpdateStatus();
  assert.equal(asked, false);
  assert.equal(status.development, true);
  assert.equal(status.available, false);
});
