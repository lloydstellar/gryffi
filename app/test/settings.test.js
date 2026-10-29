/**
 * Tests for the installation settings (src/services/settings.js)
 *
 * These tests write to the database (instance_settings and its audit table)
 * and put the settings back afterwards. They only run when GRYFFI_TEST_DB=1,
 * preferably against a throwaway database.
 *
 *   GRYFFI_TEST_DB=1 npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSettings } from './helpers/settingsSnapshot.js';

const enabled = process.env.GRYFFI_TEST_DB === '1';

let settings;
let query;
let restoreSettings;
let adminId = null;

before(async () => {
  if (!enabled) return;
  settings = await import('../src/services/settings.js');
  ({ query } = await import('../src/db/index.js'));
  restoreSettings = await snapshotSettings(query);
  adminId = (await query('SELECT id FROM users LIMIT 1')).rows[0]?.id ?? null;
  await query('DELETE FROM instance_settings');
  await query('DELETE FROM instance_settings_audit');
  delete process.env.MISTRAL_MODEL;
  delete process.env.SMTP_PORT;
  settings.invalidateSettingsCache();
});

after(async () => {
  if (!enabled) return;
  await restoreSettings();
  const { default: pool } = await import('../src/db/index.js');
  await pool.end?.();
});

const dbTest = (name, fn) => test(name, { skip: !enabled && 'set GRYFFI_TEST_DB=1 to run' }, fn);

dbTest('uses the default when nothing is set', async () => {
  assert.equal(await settings.getSetting('ai.chatModel'), 'mistral-small-latest');
});

dbTest('falls back to the environment variable', async () => {
  process.env.MISTRAL_MODEL = 'env-model';
  settings.invalidateSettingsCache();
  assert.equal(await settings.getSetting('ai.chatModel'), 'env-model');
});

dbTest('a stored value wins over the environment, and null clears it again', async () => {
  await settings.setSettings({ 'ai.chatModel': 'db-model' }, { userId: adminId });
  assert.equal(await settings.getSetting('ai.chatModel'), 'db-model');
  await settings.setSettings({ 'ai.chatModel': null }, { userId: adminId });
  assert.equal(await settings.getSetting('ai.chatModel'), 'env-model');
});

dbTest('stores secrets encrypted and masks them when described', async () => {
  await settings.setSettings({ 'ai.apiKey': 'sk-test-1234567890abcd' }, { userId: adminId });
  const raw = (await query("SELECT value FROM instance_settings WHERE key = 'ai.apiKey'")).rows[0].value;
  assert.match(raw, /^enc:v1:/);
  assert.ok(!raw.includes('sk-test'));
  assert.equal(await settings.getSetting('ai.apiKey'), 'sk-test-1234567890abcd');

  const described = (await settings.describeSettings()).find((s) => s.key === 'ai.apiKey');
  assert.equal(described.value, '••••abcd');
  assert.equal(described.source, 'database');
});

dbTest('writes masked audit rows, and none for an unchanged value', async () => {
  const before = (await query('SELECT count(*)::int AS n FROM instance_settings_audit')).rows[0].n;
  assert.deepEqual(await settings.setSettings({ 'ai.apiKey': 'sk-test-1234567890abcd' }), []);
  const rows = (await query("SELECT new_value FROM instance_settings_audit WHERE key = 'ai.apiKey'")).rows;
  assert.equal(rows.at(-1).new_value, '"••••abcd"');
  assert.equal((await query('SELECT count(*)::int AS n FROM instance_settings_audit')).rows[0].n, before);
});

dbTest('validates types', async () => {
  await settings.setSettings({ 'nsfw.enabled': 'off' });
  assert.equal(await settings.getSetting('nsfw.enabled'), false);
  await assert.rejects(settings.setSettings({ 'email.smtpPort': 70000 }), /at most 65535/);
  await assert.rejects(settings.setSettings({ 'email.smtpSecurity': 'ssl' }), /one of/);
  await assert.rejects(settings.setSettings({ 'ai.baseUrl': 'ftp://example.com' }), /http/);
  await settings.setSettings({ 'ai.baseUrl': 'http://ollama:11434/v1/' });
  assert.equal(await settings.getSetting('ai.baseUrl'), 'http://ollama:11434/v1');
  await assert.rejects(settings.getSetting('no.such.setting'), /Unknown setting/);
});

dbTest('saves all values or none', async () => {
  await assert.rejects(settings.setSettings({ 'ai.chatModel': 'x-model', 'email.smtpPort': -1 }), /at least 1/);
  assert.equal(await settings.getSetting('ai.chatModel'), 'env-model');
});

dbTest('ignores an environment value of the wrong type', async () => {
  process.env.SMTP_PORT = 'not-a-number';
  settings.invalidateSettingsCache();
  assert.equal(await settings.getSetting('email.smtpPort'), 587);
});

test('maskSecret shows only the last four characters', async () => {
  const { maskSecret } = await import('../src/services/settings.js');
  assert.equal(maskSecret('sk-abcdefgh1234'), '••••1234');
  assert.equal(maskSecret('short'), '••••');
  assert.equal(maskSecret(''), null);
});
