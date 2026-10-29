/**
 * Smoke test of a fresh Gryffi installation, in a real browser
 *
 *   node smoke.mjs <gryffi url> <setup code> <mocks url>
 *
 * Walks through the setup wizard, logs in, creates and publishes a journey,
 * invites a participant, takes the magic link from the email and opens the
 * journey as that participant. Run by run.sh, which starts Gryffi and the
 * stand-in AI and mail services (mocks.mjs) first.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const [base, code, mocksUrl] = process.argv.slice(2);
if (!base || !code || !mocksUrl) {
  console.error('Usage: node smoke.mjs <gryffi url> <setup code> <mocks url>');
  process.exit(2);
}

const ADMIN = { email: 'admin@example.com', password: 'smoke test password 1' };
// Not an example.com address: Gryffi does not send mail to reserved test domains.
// All mail of the smoke test goes to the stand-in mail server.
const PARTICIPANT = 'participant@company.com';
const SHOTS = process.env.SMOKE_SCREENSHOTS || 'screenshots';
const pageErrors = [];

function step(text) {
  console.log(`- ${text}`);
}

function watch(page, who) {
  page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`));
}

/** fetch() inside the page, so it uses the maker's session */
async function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }, { method, path, body });
}

async function waitForMagicLink() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const messages = await (await fetch(`${mocksUrl}/messages`)).json();
    for (const message of messages) {
      // Quoted-printable mail splits long lines with "=\n" and encodes "=" as "=3D"
      const text = message.raw.replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
      const link = text.match(/https?:\/\/[^\s"'<>]+\/e\/[A-Za-z0-9_-]+/);
      if (link && text.includes(PARTICIPANT)) return link[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('no invitation email with a magic link arrived');
}

async function run() {
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const maker = await browser.newPage({ locale: 'en-US' });
  watch(maker, 'maker');

  step('setup wizard: server checks');
  await maker.goto(`${base}/setup?code=${code}`);
  await maker.waitForSelector('#serverChecks .setup-check--ok');
  await maker.click('#nextButton');

  step('setup wizard: organization and admin');
  await maker.fill('#organizationName', 'Smoke Test Company');
  await maker.selectOption('#language', 'en');
  await maker.click('#nextButton');
  await maker.fill('#firstName', 'Ada');
  await maker.fill('#lastName', 'Admin');
  await maker.fill('#email', ADMIN.email);
  await maker.fill('#password', ADMIN.password);
  await maker.fill('#passwordConfirm', ADMIN.password);
  await maker.click('#nextButton');

  step('setup wizard: AI provider');
  await maker.selectOption('#aiProvider', 'other');
  await maker.fill('#aiBaseUrl', 'http://mocks:4011/v1');
  await maker.fill('#aiApiKey', 'smoke-key');
  await maker.fill('#aiChatModel', 'smoke-chat');
  await maker.click('[data-test="ai"]');
  await maker.waitForSelector('[data-result="ai"].setup-result--ok');
  await maker.fill('#aiEmbeddingModel', 'smoke-embed');
  await maker.click('[data-test="embeddings"]');
  await maker.waitForSelector('[data-result="embeddings"].setup-result--ok');
  await maker.click('#nextButton');

  step('setup wizard: email');
  await maker.fill('#smtpHost', 'mocks');
  await maker.fill('#smtpPort', '2525');
  await maker.selectOption('#smtpSecurity', 'none');
  await maker.fill('#smtpUser', 'smoke');
  await maker.fill('#smtpPassword', 'smoke');
  await maker.fill('#emailFrom', 'Gryffi <gryffi@example.com>');
  await maker.click('[data-test="email"]');
  await maker.waitForSelector('[data-result="email"].setup-result--ok');
  await maker.click('#nextButton');

  step('setup wizard: install');
  await maker.click('#nextButton');
  await maker.click('#installButton');
  await maker.waitForSelector('#installResult a.setup-button', { timeout: 120000 });
  await maker.screenshot({ path: `${SHOTS}/1-installed.png`, fullPage: true });

  step('log in');
  await maker.click('#installResult a.setup-button');
  await maker.waitForURL(/\/login/);
  await maker.fill('#password', ADMIN.password);
  await Promise.all([maker.waitForURL(/\/dashboard/), maker.click('button[type="submit"]')]);

  step('the wizard is gone');
  const setupAgain = await maker.request.get(`${base}/setup`, { maxRedirects: 0 });
  if (setupAgain.status() !== 404) throw new Error(`/setup answers ${setupAgain.status()} after the installation`);

  step('create a journey in the builder');
  await maker.goto(`${base}/dashboard/journeys/new`);
  await maker.fill('input[name="title"]', 'Smoke test journey');
  await Promise.all([maker.waitForURL(/\/dashboard\/builder\//), maker.click('form button[type="submit"]')]);
  const journeyId = maker.url().split('/').pop().split(/[?#]/)[0];
  await maker.waitForLoadState('networkidle');
  await maker.screenshot({ path: `${SHOTS}/2-builder.png` });

  step('add a content step and publish');
  const created = await api(maker, 'POST', '/api/steps', {
    journey_id: journeyId,
    type: 'content',
    title: 'Welcome to the smoke test',
    is_start: true,
    is_end: true
  });
  if (!created.data?.success) throw new Error(`creating a step failed: ${JSON.stringify(created)}`);
  const published = await api(maker, 'PUT', `/api/journeys/${journeyId}`, { title: 'Smoke test journey', status: 'published' });
  if (!published.data?.success) throw new Error(`publishing failed: ${JSON.stringify(published)}`);

  step('invite a participant');
  const participant = await api(maker, 'POST', '/api/end-users', { email: PARTICIPANT, first_name: 'Pat', last_name: 'Participant' });
  const participantId = participant.data?.endUser?.id || participant.data?.end_user?.id || participant.data?.user?.id || participant.data?.id;
  if (!participantId) throw new Error(`adding the participant failed: ${JSON.stringify(participant)}`);
  const invited = await api(maker, 'POST', '/api/invitations', { journey_id: journeyId, end_user_ids: [participantId] });
  if (!invited.data?.success) throw new Error(`the invitation failed: ${JSON.stringify(invited)}`);

  step('open the magic link from the email as the participant');
  const link = await waitForMagicLink();
  const learnerContext = await browser.newContext({ locale: 'en-US' });
  const learner = await learnerContext.newPage();
  watch(learner, 'participant');
  await learner.goto(link);
  await learner.waitForSelector('text=Welcome to the smoke test', { timeout: 30000 });
  await learner.screenshot({ path: `${SHOTS}/3-player.png`, fullPage: true });

  await browser.close();
  if (pageErrors.length) throw new Error(`errors in the browser:\n  ${pageErrors.join('\n  ')}`);
  console.log('\nSmoke test passed.');
}

run().catch((err) => {
  console.error(`\nSmoke test FAILED: ${err.message}`);
  process.exit(1);
});
