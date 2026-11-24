/**
 * Tests for evaluateChatResponse (src/services/aiHealth.js): how the daily AI
 * health check judges one chat answer. Pure function: no database or network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateChatResponse } from '../src/services/aiHealth.js';

const answer = (content, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }] });

test('a plain text answer passes', () => {
  const r = evaluateChatResponse(answer('OK'));
  assert.equal(r.ok, true);
  assert.equal(r.detail, 'OK');
});

test('an answer in parts fails as a reasoning model', () => {
  const r = evaluateChatResponse(answer([{ type: 'thinking', thinking: [] }, { type: 'text', text: 'OK' }]));
  assert.equal(r.ok, false);
  assert.match(r.detail, /reasoning model/);
  assert.match(r.detail, /thinking\+text/);
});

test('an answer cut off at the token limit fails', () => {
  const r = evaluateChatResponse(answer('{"ok": tr', 'length'));
  assert.equal(r.ok, false);
  assert.match(r.detail, /token limit/);
});

test('an empty answer or no answer fails', () => {
  assert.equal(evaluateChatResponse(answer('   ')).ok, false);
  assert.equal(evaluateChatResponse({ choices: [] }).ok, false);
  assert.equal(evaluateChatResponse(null).ok, false);
});

test('JSON mode needs valid JSON', () => {
  assert.equal(evaluateChatResponse(answer('{"ok": true}'), { expectJson: true }).ok, true);
  const r = evaluateChatResponse(answer('Sure! {"ok": true}'), { expectJson: true });
  assert.equal(r.ok, false);
  assert.match(r.detail, /No valid JSON/);
});
