/**
 * Tests for the maker login code (utils/loginCode.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_CODE_LENGTH, generateLoginCode } from '../src/utils/loginCode.js';

test('login code has six digits', () => {
  assert.equal(LOGIN_CODE_LENGTH, 6);
  for (let i = 0; i < 1000; i++) {
    assert.match(generateLoginCode(), /^[1-9]\d{5}$/);
  }
});

test('login codes vary', () => {
  const codes = new Set(Array.from({ length: 50 }, generateLoginCode));
  assert.ok(codes.size > 40);
});
