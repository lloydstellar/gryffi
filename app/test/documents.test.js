/**
 * Tests for reading knowledge files (parseDocument in src/services/knowledge.js)
 * and the NSFW switch (isImageAllowed in src/services/nsfwDetection.js).
 * Both read settings through the database: run with GRYFFI_TEST_DB=1.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSettings } from './helpers/settingsSnapshot.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const enabled = process.env.GRYFFI_TEST_DB === '1';
const dbTest = (name, fn) => test(name, { skip: !enabled && 'set GRYFFI_TEST_DB=1 to run' }, fn);

let dir;
let knowledge;
let nsfw;
let settings;
let query;
let restoreSettings;

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gryffi-docs-'));
  settings = await import('../src/services/settings.js');
  knowledge = await import('../src/services/knowledge.js');
  nsfw = await import('../src/services/nsfwDetection.js');
  ({ query } = await import('../src/db/index.js'));
  restoreSettings = await snapshotSettings(query);
});

after(async () => {
  if (!enabled) return;
  await restoreSettings();
  await fs.rm(dir, { recursive: true, force: true });
  const { default: pool } = await import('../src/db/index.js');
  await pool.end();
});

dbTest('reads plain text without the parser, dropping a byte order mark', async () => {
  const file = path.join(dir, 'hours.txt');
  await fs.writeFile(file, '﻿The office opens at eight.\n');
  const result = await knowledge.parseDocument(file, 'text/plain');
  assert.equal(result.success, true);
  assert.equal(result.text, 'The office opens at eight.');
});

dbTest('reads a spreadsheet as CSV text per sheet', async () => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Room', 'Floor'], ['Canteen', 1]]), 'Rooms');
  const file = path.join(dir, 'rooms.xlsx');
  await fs.writeFile(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const result = await knowledge.parseDocument(file, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(result.success, true);
  assert.equal(result.text, 'Rooms\nRoom,Floor\nCanteen,1');
});

dbTest('refuses PDF with a clear code when the parser is switched off', async () => {
  await settings.setSettings({ 'documents.parserEnabled': false });
  const file = path.join(dir, 'policy.pdf');
  await fs.writeFile(file, '%PDF-1.4\n%%EOF\n');
  const result = await knowledge.parseDocument(file, 'application/pdf');
  assert.deepEqual(result, { success: false, error: 'DOCUMENT_PARSER_DISABLED' });
  const message = knowledge.formatKnowledgeError(result.error, (key) => `t:${key}`);
  assert.equal(message, 't:guides.detail.parserDisabled');
});

dbTest('lets every image through when the NSFW check is switched off', async () => {
  await settings.setSettings({ 'nsfw.enabled': false });
  assert.deepEqual(await nsfw.isImageAllowed(Buffer.from('not really an image')), { allowed: true, reason: null });
});

// Expects no NudeNet container to be reachable, as in the test environment
dbTest('refuses images when the NSFW check is on but cannot run', async () => {
  await settings.setSettings({ 'nsfw.enabled': true });
  const result = await nsfw.isImageAllowed(Buffer.from('not really an image'));
  assert.equal(result.allowed, false);
});
