/**
 * Tests for the AI provider (src/services/aiProvider.js) against a local fake
 * OpenAI-compatible server. Settings are read through the database, so these
 * tests only run with GRYFFI_TEST_DB=1 (see settings.test.js).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSettings } from './helpers/settingsSnapshot.js';
import http from 'node:http';

const enabled = process.env.GRYFFI_TEST_DB === '1';
const dbTest = (name, fn) => test(name, { skip: !enabled && 'set GRYFFI_TEST_DB=1 to run' }, fn);

let server;
let baseUrl;
let requests = [];
let embeddingLength = 768;

let ai;
let settings;
let query;
let restoreSettings;

before(async () => {
  if (!enabled) return;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/chat/completions')) {
        res.end(JSON.stringify({ model: 'fake-chat', choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      } else if (req.url.endsWith('/embeddings')) {
        res.end(JSON.stringify({ data: [{ embedding: Array(embeddingLength).fill(0.5) }] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  settings = await import('../src/services/settings.js');
  ai = await import('../src/services/aiProvider.js');
  ({ query } = await import('../src/db/index.js'));
  restoreSettings = await snapshotSettings(query);
  await query("DELETE FROM instance_settings WHERE key LIKE 'ai.%'");
  await settings.setSettings({ 'ai.baseUrl': baseUrl, 'ai.apiKey': 'test-key', 'ai.chatModel': 'fake-chat', 'ai.embeddingModel': 'fake-embed' });
});

after(async () => {
  if (!enabled) return;
  await restoreSettings();
  server.close();
  const { default: pool } = await import('../src/db/index.js');
  await pool.end();
});

dbTest('sends chat requests to the configured provider with its key', async () => {
  requests = [];
  const config = await ai.getAiConfig();
  const response = await ai.aiFetch('/chat/completions', {
    body: JSON.stringify({ model: config.chatModel, messages: [{ role: 'user', content: 'ping' }] })
  });
  const data = await response.json();
  assert.equal(data.choices[0].message.content, 'pong');
  assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].auth, 'Bearer test-key');
  assert.equal(requests[0].body.model, 'fake-chat');
});

dbTest('pads embeddings to the column length', async () => {
  embeddingLength = 768;
  const vector = await ai.createEmbedding('hello');
  assert.equal(vector.length, ai.EMBEDDING_DIMENSIONS);
  assert.equal(vector[767], 0.5);
  assert.equal(vector[768], 0);
  assert.equal(requests.at(-1).body.model, 'fake-embed');
});

dbTest('refuses embeddings longer than the column', async () => {
  embeddingLength = 3072;
  await assert.rejects(ai.createEmbedding('hello'), /3072 dimensions; at most 1536/);
  embeddingLength = 768;
});

dbTest('uses a separate embedding provider when one is set', async () => {
  await settings.setSettings({ 'ai.embeddingBaseUrl': baseUrl.replace('/v1', '/embed/v1'), 'ai.embeddingApiKey': 'embed-key' });
  requests = [];
  await ai.createEmbedding('hello');
  assert.equal(requests[0].path, '/embed/v1/embeddings');
  assert.equal(requests[0].auth, 'Bearer embed-key');
  await settings.setSettings({ 'ai.embeddingBaseUrl': null, 'ai.embeddingApiKey': null });
});

dbTest('reports not configured when AI is switched off', async () => {
  await settings.setSettings({ 'ai.enabled': false });
  assert.equal(await ai.isAiConfigured(), false);
  await assert.rejects(ai.aiFetch('/chat/completions', { body: '{}' }), ai.AiNotConfiguredError);
  await settings.setSettings({ 'ai.enabled': true });
  assert.equal(await ai.isAiConfigured(), true);
});
