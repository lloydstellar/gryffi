/**
 * Tests for email delivery (src/services/email.js): SMTP against a minimal
 * local SMTP server, and Nuntly with a stubbed fetch. Settings are read through
 * the database, so these tests only run with GRYFFI_TEST_DB=1.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSettings } from './helpers/settingsSnapshot.js';
import net from 'node:net';

const enabled = process.env.GRYFFI_TEST_DB === '1';
const dbTest = (name, fn) => test(name, { skip: !enabled && 'set GRYFFI_TEST_DB=1 to run' }, fn);

let smtpServer;
let smtpPort;
const received = [];

/** A tiny SMTP server: accepts every message and keeps the raw DATA. */
function startSmtpServer() {
  return new Promise((resolve) => {
    smtpServer = net.createServer((socket) => {
      let inData = false;
      let data = '';
      let buffer = '';
      socket.write('220 test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              received.push(data);
              data = '';
              socket.write('250 OK queued\r\n');
            } else {
              data += `${line}\n`;
            }
          } else if (/^(EHLO|HELO)/i.test(line)) {
            socket.write('250 test\r\n');
          } else if (/^DATA/i.test(line)) {
            inData = true;
            socket.write('354 go ahead\r\n');
          } else if (/^QUIT/i.test(line)) {
            socket.end('221 bye\r\n');
          } else {
            socket.write('250 OK\r\n');
          }
        }
      });
    });
    smtpServer.listen(0, '127.0.0.1', () => {
      smtpPort = smtpServer.address().port;
      resolve();
    });
  });
}

let email;
let settings;
let query;
let restoreSettings;

before(async () => {
  if (!enabled) return;
  await startSmtpServer();
  settings = await import('../src/services/settings.js');
  email = await import('../src/services/email.js');
  ({ query } = await import('../src/db/index.js'));
  restoreSettings = await snapshotSettings(query);
  await query("DELETE FROM instance_settings WHERE key LIKE 'email.%'");
});

after(async () => {
  if (!enabled) return;
  await restoreSettings();
  smtpServer.close();
  const { default: pool } = await import('../src/db/index.js');
  await pool.end();
});

dbTest('is not configured without a provider key or host', async () => {
  delete process.env.NUNTLY_API_KEY;
  settings.invalidateSettingsCache();
  assert.equal(await email.isEmailConfigured(), false);
  await assert.rejects(email.sendEmail({ to: 'person@mail-test.nl', subject: 'Hi', customBody: 'Hello' }), /not configured/);
});

dbTest('sends through SMTP when that is the provider', async () => {
  await settings.setSettings({
    'email.provider': 'smtp',
    'email.smtpHost': '127.0.0.1',
    'email.smtpPort': smtpPort,
    'email.smtpSecurity': 'none',
    'email.from': 'Gryffi Test <noreply@mail-test.nl>'
  });
  assert.equal(await email.isEmailConfigured(), true);
  const result = await email.sendEmail({ to: 'person@mail-test.nl', subject: 'SMTP check', customBody: 'Hello over SMTP', replyTo: 'help@mail-test.nl' });
  assert.equal(result.success, true);
  const raw = received.at(-1);
  assert.match(raw, /Subject: SMTP check/);
  assert.match(raw, /From: Gryffi Test <noreply@mail-test.nl>/);
  assert.match(raw, /Reply-To: help@mail-test.nl/);
  assert.match(raw, /Hello over SMTP/);
});

dbTest('sends through the Nuntly API when that is the provider', async () => {
  await settings.setSettings({ 'email.provider': 'nuntly', 'email.nuntlyApiKey': 'nuntly-test-key' });
  const originalFetch = globalThis.fetch;
  let call = null;
  globalThis.fetch = async (url, init) => {
    call = { url, init };
    return new Response(JSON.stringify({ data: { id: 'msg_123' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await email.sendEmail({ to: 'person@mail-test.nl', subject: 'API check', customBody: 'Hello over HTTP', idempotencyKey: 'key-1' });
    assert.equal(result.emailId, 'msg_123');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(call.url, 'https://api.nuntly.com/emails');
  assert.equal(call.init.headers.Authorization, 'Bearer nuntly-test-key');
  assert.equal(call.init.headers['Idempotency-Key'], 'key-1');
  const body = JSON.parse(call.init.body);
  assert.equal(body.subject, 'API check');
  assert.equal(body.from, 'Gryffi Test <noreply@mail-test.nl>');
});

dbTest('logs instead of sending to reserved test domains', async () => {
  const before = received.length;
  await settings.setSettings({ 'email.provider': 'smtp' });
  const result = await email.sendEmail({ to: 'someone@example.com', subject: 'Skip', customBody: 'x' });
  assert.equal(result.skipped, 'reserved_test_domain');
  assert.equal(received.length, before);
});

dbTest('shows "Powered by Gryffi" unless the administrator switches it off', async () => {
  await settings.setSettings({ 'branding.poweredBy': true });
  const render = () => email.renderEmail({ to: 'person@mail-test.nl', subject: 'Hi', customBody: 'Hello', customText: 'Hello\n\nPowered by Gryffi' });

  const shown = await render();
  assert.match(shown.html, /Powered by/);
  assert.match(shown.text, /Powered by Gryffi/);

  await settings.setSettings({ 'branding.poweredBy': false });
  const hidden = await render();
  assert.doesNotMatch(hidden.html, /Powered by|powered-by/);
  assert.doesNotMatch(hidden.text, /Powered by Gryffi/);
  assert.match(hidden.html, /Hello/);
});
