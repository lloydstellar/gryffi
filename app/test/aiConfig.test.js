/**
 * Tests for resolveAiConfig (src/services/aiProvider.js): defaults, the OpenAI
 * key rule, and that a key only goes to the address it belongs to. Pure
 * functions: no database needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiConfig, sameAddress } from '../src/services/aiProvider.js';

const MISTRAL = 'https://api.mistral.ai/v1';

test('embeddings use the chat provider and mistral-embed by default', () => {
  const { embedding } = resolveAiConfig({ 'ai.baseUrl': MISTRAL, 'ai.apiKey': 'chat-key' });
  assert.deepEqual(embedding, { baseUrl: MISTRAL, apiKey: 'chat-key', model: 'mistral-embed' });
});

test('a separate key without an address means OpenAI, as before', () => {
  const { embedding } = resolveAiConfig({ 'ai.baseUrl': MISTRAL, 'ai.apiKey': 'chat-key', 'ai.embeddingApiKey': 'openai-key' });
  assert.deepEqual(embedding, { baseUrl: 'https://api.openai.com/v1', apiKey: 'openai-key', model: 'text-embedding-3-small' });
});

test('the chat key never goes to another embedding address', () => {
  const { embedding } = resolveAiConfig({
    'ai.baseUrl': MISTRAL, 'ai.apiKey': 'chat-key', 'ai.embeddingBaseUrl': 'https://embeddings.example.com/v1'
  });
  assert.equal(embedding.baseUrl, 'https://embeddings.example.com/v1');
  assert.equal(embedding.apiKey, null);
});

test('the chat key is used when the embedding address is the chat address', () => {
  const { embedding } = resolveAiConfig({
    'ai.baseUrl': MISTRAL, 'ai.apiKey': 'chat-key', 'ai.embeddingBaseUrl': `${MISTRAL}/`, 'ai.embeddingModel': 'my-embed'
  });
  assert.equal(embedding.apiKey, 'chat-key');
  assert.equal(embedding.model, 'my-embed');
});

test('addresses compare without case and trailing slash', () => {
  assert.equal(sameAddress('https://API.example.com/v1/', 'https://api.example.com/v1'), true);
  assert.equal(sameAddress('https://api.example.com/v1', 'https://attacker.example/v1'), false);
  assert.equal(sameAddress(null, ''), true);
});
