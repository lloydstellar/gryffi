/**
 * Tests for the route length used by the step indicator
 * (longestRouteLength in src/services/journeyLength.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { longestRouteLength } = await import('../src/services/journeyLength.js');

const step = (id, extra = {}) => ({ id, is_start: false, is_end: false, ...extra });
const path = (from, to) => ({ from_step_id: from, to_step_id: to });

test('a linear journey counts every step', () => {
  const steps = [step('a', { is_start: true }), step('b'), step('c', { is_end: true })];
  assert.equal(longestRouteLength(steps, [path('a', 'b'), path('b', 'c')]), 3);
});

test('a branch counts the longest route', () => {
  const steps = [step('a', { is_start: true }), step('b'), step('c'), step('d', { is_end: true })];
  assert.equal(longestRouteLength(steps, [path('a', 'b'), path('b', 'd'), path('a', 'd'), path('b', 'c'), path('c', 'd')]), 4);
});

test('a loop does not run forever and an end step stops the route', () => {
  const steps = [step('a', { is_start: true }), step('b'), step('c', { is_end: true })];
  assert.equal(longestRouteLength(steps, [path('a', 'b'), path('b', 'a'), path('b', 'c'), path('c', 'a')]), 3);
});

test('without a start step all steps count, without steps nothing', () => {
  assert.equal(longestRouteLength([step('a'), step('b')], []), 2);
  assert.equal(longestRouteLength([], []), 0);
});
