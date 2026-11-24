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

dbTest('the verification code email escapes the name and uses the requested language', async () => {
  await settings.setSettings({ 'email.provider': 'nuntly', 'email.nuntlyApiKey': 'nuntly-test-key' });
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: { id: 'msg_456' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    // A public journey lets anyone type a name; it must not become HTML in our email
    await email.sendVerificationCodeEmail({
      to: 'person@mail-test.nl',
      firstName: '<a href="https://evil.test">Click here</a>',
      journeyTitle: 'Safety & <b>you</b>',
      verificationCode: '123456',
      language: 'pl'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(body.subject, 'Twój kod weryfikacyjny: Safety & <b>you</b>');
  assert.doesNotMatch(body.html, /<a href="https:\/\/evil\.test">/);
  assert.match(body.html, /Cześć &lt;a href=&quot;https:\/\/evil\.test&quot;&gt;Click here&lt;\/a&gt;,/);
  assert.match(body.html, /„Safety &amp; &lt;b&gt;you&lt;\/b&gt;”/);
  assert.match(body.html, /123456/);
  assert.match(body.text, /Cześć <a href="https:\/\/evil\.test">Click here<\/a>,/);
});

dbTest('the email layout escapes variables in plain and HTML bodies', async () => {
  const variables = {
    first_name: '<img src=x onerror=alert(1)>',
    email: 'person@mail-test.nl',
    user_name: 'Sam <b>Bold</b>',
    user_first_name: 'Sam <b>Bold</b>',
    journey_title: 'Safety & <b>you</b>',
    company_name: '"Acme"',
    custom_link: 'https://app.mail-test.nl/e/abc?x=1&y=2',
    custom_link_text: '<i>Start</i>'
  };

  // Plain text body, as automation emails send it
  const plain = await email.renderEmail({
    to: 'person@mail-test.nl',
    subject: 'Hi {first_name}',
    customBody: 'Hello {first_name}\nPrice: $& {{journey_title}}',
    variables
  });
  assert.doesNotMatch(plain.html, /<img src=x|<b>Bold<\/b>|<i>Start<\/i>/);
  assert.match(plain.html, /Hello &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(plain.html, /Price: \$&amp; Safety &amp; &lt;b&gt;you&lt;\/b&gt;/);
  assert.match(plain.html, /href="https:\/\/app\.mail-test\.nl\/e\/abc\?x=1&amp;y=2"/);
  assert.match(plain.html, /alt="&quot;Acme&quot;"/);
  assert.match(plain.text, /Hello <img src=x onerror=alert\(1\)>/);
  assert.equal(plain.subject, 'Hi <img src=x onerror=alert(1)>');

  // HTML body, as the reward and form emails send it: the maker's markup stays
  const html = await email.renderEmail({
    to: 'person@mail-test.nl',
    subject: 'Reward',
    customBody: '<p style="color: {{primaryColor}};">Well done {user_name}</p>',
    isHtmlBody: true,
    variables
  });
  assert.match(html.html, /<p style="color: #[0-9a-fA-F]{6};">Well done Sam &lt;b&gt;Bold&lt;\/b&gt;<\/p>/);
  assert.match(html.text, /Well done Sam <b>Bold<\/b>/);

  // One pass: a value that looks like a placeholder is not filled in
  const nested = await email.renderEmail({
    to: 'person@mail-test.nl',
    subject: 'x',
    customBody: 'Name: {first_name}',
    variables: { first_name: '{email}', email: 'secret@mail-test.nl' }
  });
  assert.match(nested.html, /Name: \{email\}/);
  assert.doesNotMatch(nested.html, /Name: secret/);
});

dbTest('the invitation email escapes the name and title but keeps its own markup', async () => {
  await settings.setSettings({ 'email.provider': 'nuntly', 'email.nuntlyApiKey': 'nuntly-test-key' });
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: { id: 'msg_789' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await email.sendInvitationEmail({
      to: 'person@mail-test.nl',
      firstName: '<a href="https://evil.test">Sam</a>',
      journeyTitle: 'Safety & <b>you</b>',
      companyName: 'Acme',
      magicLink: 'https://app.mail-test.nl/e/abc?x=1&y=2',
      validityText: '1 week',
      language: 'en'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(body.subject, "You're invited to Safety & <b>you</b>");
  assert.doesNotMatch(body.html, /<a href="https:\/\/evil\.test">|<b>you<\/b>/);
  assert.match(body.html, /Hello &lt;a href=&quot;https:\/\/evil\.test&quot;&gt;Sam&lt;\/a&gt;,/);
  assert.match(body.html, /"<strong>Safety &amp; &lt;b&gt;you&lt;\/b&gt;<\/strong>" at Acme/);
  assert.match(body.html, /href="https:\/\/app\.mail-test\.nl\/e\/abc\?x=1&amp;y=2"/);
  assert.match(body.text, /Hello <a href="https:\/\/evil\.test">Sam<\/a>,/);
  assert.match(body.text, /participate in "Safety & <b>you<\/b>" at Acme/);
});

dbTest('security mail has no unsubscribe link or List-Unsubscribe header', async () => {
  const args = { to: 'person@mail-test.nl', subject: 'Hi', customBody: 'Hello', unsubscribeEmail: 'maker@mail-test.nl' };

  const invite = await email.renderEmail(args);
  assert.match(invite.html, /mailto:maker@mail-test\.nl/);
  assert.match(invite.text, /Unsubscribe: mailto:maker@mail-test\.nl/);
  assert.ok(invite.headers['List-Unsubscribe']);

  const code = await email.renderEmail({ ...args, transactional: true, unsubscribeUrl: 'https://app.mail-test.nl/u/1' });
  assert.doesNotMatch(code.html, /mailto:|Unsubscribe|u\/1/);
  assert.doesNotMatch(code.text, /Unsubscribe/);
  assert.deepEqual(code.headers, {});
});
