/**
 * Installation checks
 *
 * The setup wizard and the installation settings page test every part of an
 * installation before it is saved: the server itself, the AI provider, email
 * and the optional containers. Each check returns
 *
 *   { ok: boolean, code: string|null, details: object }
 *
 * where `code` names what went wrong (for example AI_AUTH_FAILED). The browser
 * turns the code into a translated message with a tip (setup.errors.<code>),
 * and the documentation has a page per code.
 */
import fs from 'fs/promises';
import path from 'path';
import { query } from '../db/index.js';
import redis from '../db/redis.js';
import { isTokenEncryptionConfigured } from '../services/oauthTokens.js';
import { createSmtpTransport } from '../services/email.js';
import { EMBEDDING_DIMENSIONS } from '../services/aiProvider.js';

const REQUEST_TIMEOUT_MS = 15000;
const MIN_FREE_DISK_BYTES = 2 * 1024 ** 3;
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
const PARSER_URL = process.env.PARSER_URL || 'http://gryffi-parser:8000';
const NUDENET_URL = process.env.NUDENET_URL || 'http://gryffi-nudenet:8002';

// A 1x1 PNG, enough to ask a vision model for a description
const TEST_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const pass = (details = {}) => ({ ok: true, code: null, details });
const fail = (code, details = {}) => ({ ok: false, code, details });

function isLocalHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname);
}

/**
 * Classify a network error from fetch() or a socket into a check code.
 * @param {Error} err
 * @param {string} prefix - AI or SMTP
 * @param {string} hostname
 */
function networkFailure(err, prefix, hostname) {
  const cause = err.cause?.code || err.code || '';
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || cause === 'ETIMEDOUT' || cause === 'UND_ERR_CONNECT_TIMEOUT') {
    return fail(`${prefix}_TIMEOUT`, { host: hostname });
  }
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
    return fail(`${prefix}_HOST_NOT_FOUND`, { host: hostname });
  }
  if (cause === 'ECONNREFUSED' && isLocalHost(hostname)) {
    return fail(`${prefix}_LOCALHOST_IN_CONTAINER`, { host: hostname });
  }
  return fail(`${prefix}_UNREACHABLE`, { host: hostname, reason: cause || err.message });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Checks of the server the wizard runs on. Required checks block the setup,
 * the others are warnings.
 * @param {{requestHost?: string, requestSecure?: boolean}} context - from the wizard's own request
 * @returns {Promise<Array<{name: string, required: boolean} & ReturnType<typeof pass>>>}
 */
export async function checkServer({ requestHost = '', requestSecure = false } = {}) {
  const results = [];
  const add = (name, required, result) => results.push({ name, required, ...result });

  try {
    const vector = await query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    add('database', true, vector.rows.length ? pass() : fail('DATABASE_NO_VECTOR'));
  } catch (err) {
    add('database', true, fail('DATABASE_UNREACHABLE', { reason: err.message }));
  }

  try {
    const pong = await redis.ping();
    add('redis', true, pong === 'PONG' ? pass() : fail('REDIS_UNREACHABLE'));
  } catch (err) {
    add('redis', true, fail('REDIS_UNREACHABLE', { reason: err.message }));
  }

  add('encryptionKey', true, isTokenEncryptionConfigured() ? pass() : fail('ENCRYPTION_KEY_MISSING'));

  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const probe = path.join(UPLOADS_DIR, `.write-check-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    add('uploads', true, pass({ path: UPLOADS_DIR }));
  } catch (err) {
    add('uploads', true, fail('UPLOADS_NOT_WRITABLE', { path: UPLOADS_DIR, reason: err.code || err.message }));
  }

  try {
    const stats = await fs.statfs(UPLOADS_DIR);
    const free = stats.bavail * stats.bsize;
    add('diskSpace', false, free >= MIN_FREE_DISK_BYTES
      ? pass({ freeGb: Math.round(free / 1024 ** 3) })
      : fail('DISK_SPACE_LOW', { freeGb: Math.round((free / 1024 ** 3) * 10) / 10 }));
  } catch (err) {
    add('diskSpace', false, fail('DISK_SPACE_UNKNOWN', { reason: err.message }));
  }

  const appUrl = process.env.APP_URL || '';
  let appHost = '';
  try {
    appHost = new URL(appUrl).host;
  } catch {
    appHost = '';
  }
  add('appUrl', true, appHost && appHost === requestHost
    ? pass({ appUrl })
    : fail('APP_URL_MISMATCH', { appUrl, browserHost: requestHost }));

  const local = isLocalHost(requestHost.split(':')[0]);
  add('https', false, requestSecure || local ? pass() : fail('HTTPS_MISSING'));

  add('parser', false, await checkContainer(`${PARSER_URL}/healthcheck`, 'PARSER_UNAVAILABLE'));
  add('nsfw', false, await checkContainer(`${NUDENET_URL}/health`, 'NSFW_UNAVAILABLE'));

  return results;
}

async function checkContainer(url, code) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok ? pass() : fail(code, { status: response.status });
  } catch (err) {
    return fail(code, { reason: err.cause?.code || err.message });
  }
}

/**
 * Health of the document parser container.
 */
export function checkParser() {
  return checkContainer(`${PARSER_URL}/healthcheck`, 'PARSER_UNAVAILABLE');
}

/**
 * Health of the NSFW detection container.
 */
export function checkNsfw() {
  return checkContainer(`${NUDENET_URL}/health`, 'NSFW_UNAVAILABLE');
}

// ---------------------------------------------------------------------------
// AI provider
// ---------------------------------------------------------------------------

async function aiRequest(baseUrl, apiKey, pathName, body) {
  const url = `${baseUrl.replace(/\/+$/, '')}${pathName}`;
  return fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body && { 'Content-Type': 'application/json' })
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

function statusFailure(status, prefix = 'AI') {
  if (status === 401 || status === 403) return fail(`${prefix}_AUTH_FAILED`, { status });
  if (status === 429) return fail(`${prefix}_RATE_LIMITED`, { status });
  return null;
}

/**
 * Test an OpenAI-compatible chat provider: can we reach it, is the key
 * accepted, and does the chosen model answer?
 * @param {{baseUrl: string, apiKey: string, chatModel?: string}} input
 * @returns {Promise<ReturnType<typeof pass>>} details.models lists the provider's models
 */
export async function checkAiProvider({ baseUrl, apiKey, chatModel }) {
  let url;
  try {
    url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
  } catch {
    return fail('AI_INVALID_URL', { baseUrl });
  }
  if (!apiKey) return fail('AI_KEY_MISSING');

  let models = [];
  try {
    const response = await aiRequest(baseUrl, apiKey, '/models');
    const failure = statusFailure(response.status);
    if (failure) return failure;
    if (response.status === 404) return fail('AI_NOT_OPENAI_COMPATIBLE', { baseUrl });
    if (!response.ok) return fail('AI_UNEXPECTED_RESPONSE', { status: response.status });
    const data = await response.json().catch(() => null);
    models = (data?.data || []).map((m) => m.id).filter(Boolean).sort();
  } catch (err) {
    return networkFailure(err, 'AI', url.hostname);
  }

  if (!chatModel) return pass({ models });

  try {
    const response = await aiRequest(baseUrl, apiKey, '/chat/completions', {
      model: chatModel,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
      max_tokens: 5
    });
    const failure = statusFailure(response.status);
    if (failure) return failure;
    if (!response.ok) {
      const text = await response.text();
      // Gryffi sends max_tokens with every request; some models (reasoning
      // models, for example) refuse it and would fail in the app as well
      if (/max_tokens|unsupported (parameter|value)/i.test(text)) {
        return fail('AI_MODEL_UNSUPPORTED', { model: chatModel });
      }
      if (response.status === 404 || /no such model|unknown model|invalid model|model[^.]{0,60}(not found|does not exist|not exist|is not available|not supported)/i.test(text)) {
        return fail('AI_MODEL_NOT_FOUND', { model: chatModel, models });
      }
      return fail('AI_UNEXPECTED_RESPONSE', { status: response.status });
    }
    return pass({ models, model: chatModel });
  } catch (err) {
    return networkFailure(err, 'AI', url.hostname);
  }
}

/**
 * Test the embedding model and measure its vector length.
 * @param {{baseUrl: string, apiKey: string, model: string}} input
 */
export async function checkEmbeddings({ baseUrl, apiKey, model }) {
  if (!model) return fail('AI_EMBEDDING_MODEL_MISSING');
  if (!apiKey) return fail('AI_KEY_MISSING');
  let hostname = '';
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return fail('AI_INVALID_URL', { baseUrl });
  }
  try {
    const response = await aiRequest(baseUrl, apiKey, '/embeddings', { model, input: ['Gryffi test sentence'] });
    const failure = statusFailure(response.status);
    if (failure) return failure;
    if (!response.ok) return fail('AI_EMBEDDING_FAILED', { model, status: response.status });
    const data = await response.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) return fail('AI_EMBEDDING_FAILED', { model });
    if (vector.length > EMBEDDING_DIMENSIONS) {
      return fail('AI_EMBEDDING_TOO_LARGE', { model, dimensions: vector.length, maximum: EMBEDDING_DIMENSIONS });
    }
    return pass({ model, dimensions: vector.length });
  } catch (err) {
    return networkFailure(err, 'AI', hostname);
  }
}

/**
 * Test the vision model with a tiny image.
 * @param {{baseUrl: string, apiKey: string, model: string}} input
 */
export async function checkVision({ baseUrl, apiKey, model }) {
  if (!model) return fail('AI_VISION_MODEL_MISSING');
  try {
    const response = await aiRequest(baseUrl, apiKey, '/chat/completions', {
      model,
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image in one word.' },
          { type: 'image_url', image_url: { url: TEST_IMAGE_DATA_URL } }
        ]
      }]
    });
    const failure = statusFailure(response.status);
    if (failure) return failure;
    return response.ok ? pass({ model }) : fail('AI_VISION_FAILED', { model, status: response.status });
  } catch (err) {
    return networkFailure(err, 'AI', new URL(baseUrl).hostname);
  }
}

/**
 * Test text-to-speech with one short sentence.
 * @param {{baseUrl: string, apiKey: string, model: string, voice?: string}} input
 * @returns details.audio holds a data URL the wizard can play
 */
export async function checkSpeech({ baseUrl, apiKey, model, voice }) {
  if (!model) return fail('AI_TTS_MODEL_MISSING');
  try {
    const response = await aiRequest(baseUrl, apiKey, '/audio/speech', {
      model,
      input: 'Welcome to Gryffi.',
      ...(voice && { voice }),
      response_format: 'mp3'
    });
    const failure = statusFailure(response.status);
    if (failure) return failure;
    if (!response.ok) return fail('AI_TTS_FAILED', { model, status: response.status });
    let audio;
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      const data = await response.json();
      audio = data?.audio_data;
    } else {
      audio = Buffer.from(await response.arrayBuffer()).toString('base64');
    }
    if (!audio) return fail('AI_TTS_FAILED', { model });
    return pass({ model, audio: `data:audio/mpeg;base64,${audio}` });
  } catch (err) {
    return networkFailure(err, 'AI', new URL(baseUrl).hostname);
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function smtpFailure(err, host, port) {
  const code = err.code || '';
  const text = `${err.message || ''} ${err.response || ''}`;
  if (code === 'EAUTH' || /\b535\b|authentication/i.test(text)) return fail('SMTP_AUTH_FAILED', { host });
  if (/wrong version number|ssl3_get_record|TLS|certificate/i.test(text) || code === 'ETLS') {
    return fail('SMTP_TLS_MISMATCH', { host, port });
  }
  if (code === 'ETIMEDOUT' || (code === 'ECONNECTION' && /timeout/i.test(text))) {
    return fail(port === 25 ? 'SMTP_PORT_25_BLOCKED' : 'SMTP_TIMEOUT', { host, port });
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(text) || code === 'EDNS') return fail('SMTP_HOST_NOT_FOUND', { host });
  if (/ECONNREFUSED/.test(text) || code === 'ECONNREFUSED') {
    if (isLocalHost(host)) return fail('SMTP_LOCALHOST_IN_CONTAINER', { host });
    return fail(port === 25 ? 'SMTP_PORT_25_BLOCKED' : 'SMTP_UNREACHABLE', { host, port });
  }
  return fail('SMTP_UNEXPECTED', { host, reason: err.message });
}

/**
 * Connect to the SMTP server and log in, then send a test message.
 * @param {{host: string, port: number, security: string, user?: string, password?: string, from: string, to: string}} input
 */
export async function checkSmtp({ host, port, security, user, password, from, to }) {
  if (!host) return fail('SMTP_HOST_MISSING');
  const transport = createSmtpTransport({ host, port, security, user, password });
  try {
    await transport.verify();
  } catch (err) {
    transport.close();
    return smtpFailure(err, host, port);
  }
  if (!to) {
    transport.close();
    return pass({ host });
  }
  try {
    await transport.sendMail({
      from,
      to,
      subject: 'Gryffi test email',
      text: 'This is a test email from your Gryffi installation. Email works.'
    });
    return pass({ host, sentTo: to });
  } catch (err) {
    if (/sender|from address|not owned|550|553/i.test(`${err.message} ${err.response || ''}`)) {
      return fail('SMTP_SENDER_REJECTED', { from });
    }
    return smtpFailure(err, host, port);
  } finally {
    transport.close();
  }
}
