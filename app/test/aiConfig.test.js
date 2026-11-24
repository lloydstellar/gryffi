/**
 * Tests for resolveAiConfig and messageText (src/services/aiProvider.js):
 * defaults, the OpenAI key rule, that a key only goes to the address it
 * belongs to, and reading the answer of a reasoning model. Pure functions:
 * no database needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiConfig, sameAddress, messageText } from '../src/services/aiProvider.js';

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

test('messageText returns a plain string answer as is', () => {
  assert.equal(messageText({ choices: [{ message: { content: 'Hello there' } }] }), 'Hello there');
});

test('messageText keeps only the text parts of a reasoning answer', () => {
  const data = { choices: [{ message: { content: [
    { type: 'thinking', thinking: [{ type: 'text', text: 'Let me think' }] },
    { type: 'text', text: '{"ok":' },
    { type: 'text', text: 'true}' }
  ] } }] };
  assert.equal(messageText(data), '{"ok":true}');
});

test('messageText gives an empty string when there is no answer', () => {
  assert.equal(messageText({ choices: [{ message: { content: [{ type: 'thinking', thinking: [] }] } }] }), '');
  assert.equal(messageText({}), '');
  assert.equal(messageText(null), '');
});
