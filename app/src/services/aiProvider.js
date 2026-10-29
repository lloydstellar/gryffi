/**
 * AI provider
 *
 * Every request to the AI provider goes through this module: chat completions,
 * embeddings and speech. The provider is any API in the OpenAI format: Mistral,
 * OpenAI, Azure OpenAI, OpenRouter, Ollama or vLLM. Address, key and models come
 * from the installation settings (services/settings.js), which fall back to the
 * MISTRAL_* environment variables that Gryffi Cloud uses.
 */
import { getSettings } from './settings.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

// Length of knowledge_chunks.embedding. Shorter embeddings are padded with
// zeros, which leaves cosine similarity unchanged; longer ones do not fit.
export const EMBEDDING_DIMENSIONS = 1536;

const SETTING_KEYS = [
  'ai.enabled', 'ai.baseUrl', 'ai.apiKey', 'ai.chatModel', 'ai.fallbackModel', 'ai.classifierModel',
  'ai.visionModel', 'ai.embeddingBaseUrl', 'ai.embeddingApiKey', 'ai.embeddingModel', 'ai.ttsModel', 'ai.ttsVoice'
];

/**
 * Raised when an AI request is made while no provider is configured.
 */
export class AiNotConfiguredError extends Error {
  constructor(message = 'No AI provider is configured') {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}

/**
 * Whether two API addresses are the same, ignoring case and a trailing slash.
 */
export function sameAddress(a, b) {
  const norm = (value) => String(value || '').trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The AI configuration that follows from a set of settings. The app, the
 * setup tests and `gryffi doctor` all use this, so they agree on defaults.
 * A key is only sent to the address it belongs to: embeddings at another
 * address than chat never get the chat key.
 * @param {Object<string, *>} s - values of SETTING_KEYS
 */
export function resolveAiConfig(s) {
  // A separate embedding key without its own address means OpenAI, as it did
  // before these settings existed (OPENAI_API_KEY).
  const separateOpenAiKey = !!s['ai.embeddingApiKey'] && !s['ai.embeddingBaseUrl'];
  const embeddingBaseUrl = s['ai.embeddingBaseUrl'] || (separateOpenAiKey ? OPENAI_BASE_URL : s['ai.baseUrl']);
  return {
    enabled: s['ai.enabled'] !== false,
    baseUrl: s['ai.baseUrl'],
    apiKey: s['ai.apiKey'],
    chatModel: s['ai.chatModel'],
    fallbackModel: s['ai.fallbackModel'] || s['ai.chatModel'],
    classifierModel: s['ai.classifierModel'] || s['ai.chatModel'],
    visionModel: s['ai.visionModel'],
    ttsModel: s['ai.ttsModel'],
    ttsVoice: s['ai.ttsVoice'],
    embedding: {
      baseUrl: embeddingBaseUrl,
      apiKey: s['ai.embeddingApiKey'] || (sameAddress(embeddingBaseUrl, s['ai.baseUrl']) ? s['ai.apiKey'] : null),
      model: s['ai.embeddingModel'] || (separateOpenAiKey ? 'text-embedding-3-small' : 'mistral-embed')
    }
  };
}

/**
 * The current AI configuration.
 * @returns {Promise<{enabled: boolean, baseUrl: string, apiKey: string|null, chatModel: string,
 *   fallbackModel: string, classifierModel: string, visionModel: string, ttsModel: string,
 *   ttsVoice: string|null, embedding: {baseUrl: string, apiKey: string|null, model: string}}>}
 */
export async function getAiConfig() {
  return resolveAiConfig(await getSettings(SETTING_KEYS));
}

/**
 * The settings getAiConfig() reads, for callers that combine them with values
 * that are not saved yet (the setup tests).
 */
export const AI_SETTING_KEYS = Object.freeze([...SETTING_KEYS]);

/**
 * Whether AI requests can be made: AI is switched on and a key is set.
 * Local providers such as Ollama accept any key; the setup wizard fills one in.
 * @returns {Promise<boolean>}
 */
export async function isAiConfigured() {
  const config = await getAiConfig();
  return config.enabled && !!config.apiKey && !!config.baseUrl;
}

/**
 * Send a POST request to the AI provider, like fetch() with the address and
 * authorization filled in.
 * @param {string} path - API path after the base URL, e.g. '/chat/completions'
 * @param {RequestInit} init - body (a JSON string), signal and any extra headers
 * @param {{purpose?: 'chat'|'embeddings'}} [options] - embeddings may use their own provider
 * @returns {Promise<Response>}
 */
export async function aiFetch(path, init = {}, { purpose = 'chat' } = {}) {
  const config = await getAiConfig();
  const target = purpose === 'embeddings' ? config.embedding : config;
  if (!config.enabled || !target.apiKey || !target.baseUrl) {
    throw new AiNotConfiguredError();
  }
  return fetch(`${target.baseUrl}${path}`, {
    ...init,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
      Authorization: `Bearer ${target.apiKey}`
    }
  });
}

/**
 * Embed one text with the configured embedding model, padded to EMBEDDING_DIMENSIONS.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function createEmbedding(text) {
  const config = await getAiConfig();
  const response = await aiFetch('/embeddings', {
    body: JSON.stringify({ model: config.embedding.model, input: [text] })
  }, { purpose: 'embeddings' });
  if (!response.ok) {
    throw new Error(`Embedding request failed with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('Embedding response has no vector');
  }
  if (embedding.length > EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding model ${config.embedding.model} returns ${embedding.length} dimensions; at most ${EMBEDDING_DIMENSIONS} fit`);
  }
  while (embedding.length < EMBEDDING_DIMENSIONS) embedding.push(0);
  return embedding;
}
