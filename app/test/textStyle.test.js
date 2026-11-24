/**
 * Tests for removeEmDashes (utils/textStyle.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeEmDashes } from '../src/utils/textStyle.js';

test('em dash between words becomes a comma', () => {
  assert.equal(removeEmDashes('You are all set—welcome aboard!'), 'You are all set, welcome aboard!');
  assert.equal(removeEmDashes('Call your manager — an email is not enough.'), 'Call your manager, an email is not enough.');
});

test('en dash with spaces becomes a comma, a range stays', () => {
  assert.equal(removeEmDashes('Lunch – free for all'), 'Lunch, free for all');
  assert.equal(removeEmDashes('Open 9–17'), 'Open 9–17');
});

test('dash at the start or end of a text or tag disappears', () => {
  assert.equal(removeEmDashes('— Robin'), 'Robin');
  assert.equal(removeEmDashes('<p>— Robin</p>'), '<p>Robin</p>');
  assert.equal(removeEmDashes('<p>See you soon —</p>'), '<p>See you soon</p>');
  assert.equal(removeEmDashes('Big or small,—really'), 'Big or small, really');
});

test('HTML entity and untouched input', () => {
  assert.equal(removeEmDashes('A&mdash;B'), 'A, B');
  assert.equal(removeEmDashes('Nothing to change.'), 'Nothing to change.');
  assert.equal(removeEmDashes(''), '');
  assert.equal(removeEmDashes(null), null);
});
