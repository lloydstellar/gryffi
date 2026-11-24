/**
 * Tests for reward claims (src/services/rewards.js)
 *
 * The database tests make their own organization and remove it afterwards.
 * They run when GRYFFI_TEST_DB=1:
 *
 *   GRYFFI_TEST_DB=1 npm test
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { parseManualCodes, rewardSettings, syncRewardFromStep, claimRewardCode, rewardAvailability } from '../src/services/rewards.js';

const enabled = process.env.GRYFFI_TEST_DB === '1';
const dbTest = (name, fn) => test(name, { skip: !enabled && 'set GRYFFI_TEST_DB=1 to run' }, fn);

const orgIds = [];

after(async () => {
  if (!enabled) return;
  const { query, default: pool } = await import('../src/db/index.js');
  for (const id of orgIds) await query('DELETE FROM organizations WHERE id = $1', [id]);
  await pool.end?.();
});

test('manual codes are split on lines and commas, without blanks or doubles', () => {
  assert.deepEqual(parseManualCodes('A1, B2\nC3\n\n A1 ,'), ['A1', 'B2', 'C3']);
  assert.deepEqual(parseManualCodes(undefined), []);
});

test('reward settings: random codes by default, max_recipients only when positive', () => {
  assert.equal(rewardSettings({}).isRandomCodes, true);
  assert.equal(rewardSettings({ max_recipients: '3' }).maxRecipients, 3);
  assert.equal(rewardSettings({ max_recipients: '' }).maxRecipients, null);
  assert.equal(rewardSettings({ max_recipients: 0 }).maxRecipients, null);
  assert.deepEqual(rewardSettings({ is_random_codes: true, manual_codes: 'X' }).manualCodes, []);
  assert.deepEqual(rewardSettings({ is_random_codes: false, manual_codes: 'X\nY' }).manualCodes, ['X', 'Y']);
});

async function rewardStep(basicProps) {
  const { query } = await import('../src/db/index.js');
  const suffix = crypto.randomBytes(4).toString('hex');
  const org = (await query('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id', [`Reward test ${suffix}`, `reward-test-${suffix}`])).rows[0].id;
  orgIds.push(org);
  const journey = (await query('INSERT INTO journeys (organization_id, title) VALUES ($1, $2) RETURNING id', [org, 'Reward test'])).rows[0].id;
  const step = (await query("INSERT INTO steps (journey_id, title, type, basic_props) VALUES ($1, 'Reward', 'reward', $2) RETURNING id", [journey, basicProps])).rows[0].id;
  return { orgId: org, journeyId: journey, stepId: step, basicProps };
}

async function claim(step, claimer = {}) {
  const { getClient } = await import('../src/db/index.js');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const reward = await syncRewardFromStep(client, step);
    const result = await claimRewardCode(client, reward, claimer);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

dbTest('the first claim creates the reward, also without an earlier claim', async () => {
  const { query } = await import('../src/db/index.js');
  const step = await rewardStep({ title: 'Badge', is_random_codes: true, code_prefix: 'QA-' });
  assert.deepEqual(await rewardAvailability({ query }, step), { available: true, soldOut: false });
  const first = await claim(step);
  assert.match(first.code, /^QA-[0-9A-F]{8}$/);
  assert.equal(first.position, 1);
  assert.equal((await claim(step)).position, 2);
  const rows = await query('SELECT title FROM rewards WHERE step_id = $1', [step.stepId]);
  assert.deepEqual(rows.rows, [{ title: 'Badge' }]);
});

dbTest('random codes stop at max_recipients', async () => {
  const { query } = await import('../src/db/index.js');
  const step = await rewardStep({ is_random_codes: true, max_recipients: '2' });
  assert.ok(await claim(step));
  assert.ok(await claim(step));
  assert.equal(await claim(step), null);
  assert.deepEqual(await rewardAvailability({ query }, step), { available: false, soldOut: true });
});

dbTest('manual codes are handed out in order, and a removed code is not', async () => {
  const { query } = await import('../src/db/index.js');
  const step = await rewardStep({ is_random_codes: false, manual_codes: 'AAA\nBBB\nCCC' });
  assert.equal((await claim(step)).code, 'AAA');
  step.basicProps = { is_random_codes: false, manual_codes: 'AAA\nCCC' };
  assert.equal((await claim(step)).code, 'CCC');
  assert.equal(await claim(step), null);
  assert.deepEqual(await rewardAvailability({ query }, step), { available: false, soldOut: true });
});
