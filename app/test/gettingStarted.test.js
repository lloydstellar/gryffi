/**
 * Tests for the getting-started card on the dashboard
 * (buildGettingStarted in src/services/tips.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildGettingStarted } = await import('../src/services/tips.js');

const draft = { id: 'j-draft', title: 'Draft', status: 'draft' };
const live = { id: 'j-live', title: 'Live', status: 'published' };
const snapshot = (extra = {}) => ({
  journeys_total: 0, previews_total: 0, journeys_published: 0, invitations_total: 0,
  first_completion_at: null, latest_journey: null, latest_published: null, ...extra
});

test('a new organization starts at creating a journey', () => {
  const gs = buildGettingStarted(snapshot(), 'admin');
  assert.equal(gs.nextKey, 'journey');
  assert.equal(gs.doneCount, 0);
  assert.equal(gs.total, 5);
  assert.equal(gs.journey, null);
});

test('after the wizard the next step is the preview of that journey', () => {
  const gs = buildGettingStarted(snapshot({ journeys_total: 1, latest_journey: draft }), 'admin');
  assert.equal(gs.nextKey, 'preview');
  assert.deepEqual(gs.journey, { id: 'j-draft', title: 'Draft', isDraft: true });
});

test('inviting uses the published journey, also when a newer draft exists', () => {
  const gs = buildGettingStarted(snapshot({
    journeys_total: 2, previews_total: 1, journeys_published: 1, latest_journey: draft, latest_published: live
  }), 'manager');
  assert.equal(gs.nextKey, 'invite');
  assert.deepEqual(gs.journey, { id: 'j-live', title: 'Live', isDraft: false });
  assert.equal(gs.canPublish, true);
});

test('organizations that already invite people skip the preview step', () => {
  const gs = buildGettingStarted(snapshot({
    journeys_total: 1, journeys_published: 1, invitations_total: 3, latest_journey: live, latest_published: live
  }), 'admin');
  assert.equal(gs.nextKey, 'complete');
  assert.equal(gs.steps.find(st => st.key === 'preview').done, true);
});

test('the card is gone when everything is done, when hidden, and for viewers', () => {
  const allDone = snapshot({
    journeys_total: 1, previews_total: 1, journeys_published: 1, invitations_total: 1,
    first_completion_at: '2026-11-10T10:00:00Z', latest_journey: live, latest_published: live
  });
  assert.equal(buildGettingStarted(allDone, 'admin'), null);
  assert.equal(buildGettingStarted(snapshot(), 'admin', { 'getting_started:dismissed': '2026-11-16T10:00:00Z' }), null);
  assert.equal(buildGettingStarted(snapshot(), 'viewer'), null);
});

test('editors see the steps but may not publish', () => {
  const gs = buildGettingStarted(snapshot({ journeys_total: 1, previews_total: 1, latest_journey: draft }), 'member');
  assert.equal(gs.nextKey, 'publish');
  assert.equal(gs.canPublish, false);
});
