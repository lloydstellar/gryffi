/**
 * After the login a maker goes back to the dashboard page that asked for it,
 * never to another site (services/makerSession.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnTo, takeReturnTo } from '../src/services/makerSession.js';

test('dashboard pages are kept', () => {
  assert.equal(safeReturnTo('/dashboard'), '/dashboard');
  assert.equal(safeReturnTo('/dashboard/partner'), '/dashboard/partner');
  assert.equal(safeReturnTo('/dashboard/analytics?journey=1#steps'), '/dashboard/analytics?journey=1#steps');
});

test('other places and odd values are refused', () => {
  for (const value of ['//evil.example/dashboard', '/\\evil.example', 'https://evil.example/dashboard', '/dashboardx', '/api/partner/code', '/dashboard//evil.example', '/dashboard/a b', '/dashboard\\x', '', null, 42, `/dashboard/${'a'.repeat(600)}`]) {
    assert.equal(safeReturnTo(value), null, String(value).slice(0, 40));
  }
});

test('the target is read once', () => {
  const req = { session: { returnTo: '/dashboard/partner' } };
  assert.equal(takeReturnTo(req), '/dashboard/partner');
  assert.equal(takeReturnTo(req), '/dashboard');
  assert.equal(takeReturnTo({ session: { returnTo: '//evil.example' } }), '/dashboard');
});
