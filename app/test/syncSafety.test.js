/**
 * Tests for the deletion limit of directory sync
 * (tooManySyncDeletions in src/utils/syncSafety.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tooManySyncDeletions } = await import('../src/utils/syncSafety.js');

test('nothing to remove is never too many', () => {
  assert.equal(tooManySyncDeletions(100, 0), false);
  assert.equal(tooManySyncDeletions(0, 0), false);
});

test('up to 3 removals always go through, also in a small directory', () => {
  assert.equal(tooManySyncDeletions(5, 1), false);
  assert.equal(tooManySyncDeletions(5, 3), false);
  assert.equal(tooManySyncDeletions(4, 3), false);
});

test('more than 3 removals and more than 10% are blocked', () => {
  assert.equal(tooManySyncDeletions(5, 4), true);
  assert.equal(tooManySyncDeletions(30, 4), true);
  assert.equal(tooManySyncDeletions(100, 11), true);
});

test('more than 3 removals within 10% go through', () => {
  assert.equal(tooManySyncDeletions(100, 10), false);
  assert.equal(tooManySyncDeletions(40, 4), false);
});
