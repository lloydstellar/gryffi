/**
 * AI health check
 *
 * A handful of very small real calls to the configured AI provider, to notice
 * early when something no longer works the way Gryffi expects. On 13 November
 * 2026 mistral-large-latest turned into a reasoning model: answers came back
 * as [thinking, text] parts and the thinking used up the token budget, so the
 * journey wizard, guide chat and translations failed without anyone noticing.
 *
 * checkAiHealth() runs the calls; evaluateChatResponse() judges one chat
 * answer and has no side effects (unit tested). The daily job that mails the
 * operator lives in cloud/jobs.js.
 */
import { aiFetch, getAiConfig, isAiConfigured, createEmbedding, messageText } from './aiProvider.js';

// Each call may take this long before it counts as failed
const CALL_TIMEOUT_MS = 30000;

// 32x32 PNG: a green square on white, for the image analysis model
const TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAPUlEQVR42mP8//8/Ay0BEwONwagFoxZQDlhwScj32pJk0MPiw6NxMGrBqAWjFoxaMHQtYBxtF41aMGoBAwB30wk7VvgPtgAAAABJRU5ErkJggg==';

/**
 * Judge one /chat/completions answer.
 * @param {Object} data - parsed response body
 * @param {{expectJson?: boolean}} [options] - the answer must be valid JSON
 * @returns {{ok: boolean, detail: string}}
 */
export function evaluateChatResponse(data, { expectJson = false } = {}) {
  const choice = data?.choices?.[0];
  if (!choice) return { ok: false, detail: 'No answer in the response' };
  const content = choice.message?.content;
  if (Array.isArray(content)) {
    const types = content.map(part => part?.type).join('+');
    return { ok: false, detail: `The model answers in parts (${types}): a reasoning model. Its thinking uses the token budgets of Gryffi; pin a model version without reasoning.` };
  }
  if (choice.finish_reason === 'length') {
    return { ok: false, detail: 'The answer was cut off at the token limit (finish_reason: length)' };
  }
  const text = messageText(data).trim();
  if (!text) return { ok: false, detail: 'Empty answer' };
  if (expectJson) {
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, detail: `No valid JSON in JSON mode: ${text.slice(0, 80)}` };
    }
  }
  return { ok: true, detail: text.slice(0, 60) };
}

/**
 * One chat call with a small prompt and a small budget.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function chatCheck(model, messages, { json = false } = {}) {
  // No temperature: the call should behave like the app's own calls (a
  // reasoning model refuses temperature 0 with its own error)
  const body = { model, messages, max_tokens: 200 };
  if (json) body.response_format = { type: 'json_object' };
  const response = await aiFetch('/chat/completions', {
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  });
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status}: ${(await response.text()).slice(0, 160)}` };
  }
  return evaluateChatResponse(await response.json(), { expectJson: json });
}

/**
 * Run a check and time it; an exception counts as a failure.
 */
async function timed(name, model, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    return { name, model, ...result, ms: Date.now() - started };
  } catch (err) {
    const detail = err?.name === 'TimeoutError' ? `No answer within ${CALL_TIMEOUT_MS / 1000} s` : (err?.message || String(err));
    return { name, model, ok: false, detail, ms: Date.now() - started };
  }
}

/**
 * Check the AI features Gryffi relies on.
 * @returns {Promise<{ok: boolean, configured: boolean, checks: Array<{name: string, model: string, ok: boolean, detail: string, ms: number}>}>}
 */
export async function checkAiHealth() {
  if (!(await isAiConfigured())) {
    return { ok: false, configured: false, checks: [{ name: 'configuration', model: '-', ok: false, detail: 'AI is switched off or has no API key', ms: 0 }] };
  }
  const config = await getAiConfig();
  const checks = [];

  // Guide chat, help, translation: plain text
  checks.push(await timed('chat', config.chatModel, () => chatCheck(config.chatModel, [
    { role: 'user', content: 'Reply with the single word OK.' }
  ])));

  // Journey wizard: JSON mode
  checks.push(await timed('json', config.chatModel, () => chatCheck(config.chatModel, [
    { role: 'user', content: 'Return this JSON object and nothing else: {"ok": true}' }
  ], { json: true })));

  // Fallback model (translation retries with it)
  if (config.fallbackModel && config.fallbackModel !== config.chatModel) {
    checks.push(await timed('fallback', config.fallbackModel, () => chatCheck(config.fallbackModel, [
      { role: 'user', content: 'Reply with the single word OK.' }
    ])));
  }

  // Knowledge base of AI guides
  checks.push(await timed('embeddings', config.embedding?.model || '-', async () => {
    const vector = await createEmbedding('Gryffi health check');
    return vector.some(v => v !== 0)
      ? { ok: true, detail: `${vector.length} dimensions` }
      : { ok: false, detail: 'The embedding vector is all zeros' };
  }));

  // Image descriptions
  if (config.visionModel) {
    checks.push(await timed('vision', config.visionModel, () => chatCheck(config.visionModel, [
      { role: 'user', content: [
        { type: 'text', text: 'What colour is the square in this image? Answer in one word.' },
        { type: 'image_url', image_url: TEST_IMAGE }
      ] }
    ])));
  }

  return { ok: checks.every(c => c.ok), configured: true, checks };
}
