/**
 * Text-to-Speech Service (Mistral Voxtral TTS)
 *
 * Generates natural speech for journey steps via Mistral's /v1/audio/speech
 * endpoint (EU-hosted, same platform as the existing Mistral integration).
 *
 * Architecture: journey step text is static, so audio is generated once per
 * (model, voice, language, text) combination and cached as an MP3 file on
 * disk. Subsequent requests are served straight from the cache, keeping API
 * usage minimal. The client falls back to the browser's Web Speech API for
 * unsupported languages or when this service is unavailable.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { aiFetch, getAiConfig, isAiConfigured } from './aiProvider.js';
import { getSetting } from './settings.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// Native preset voices per language (Voxtral 3, checked against the voice
// list of the Mistral account on 16 November 2026). Languages outside Gryffi's
// 14 journey languages are left out. Danish, Finnish and Swedish have no preset
// voice: an English voice would read them with an English pronunciation, so
// they keep the browser voice until a cloned native voice exists. Override per
// language via TTS_VOXTRAL_VOICE_<LANG> (e.g. TTS_VOXTRAL_VOICE_DA once a
// cloned voice is made with Mistral's Voices API); add the language here and to
// SERVER_TTS_LANGUAGES in app/public/js/builder.js as well.
const NATIVE_VOICES = {
  en: 'gb_oliver_neutral', // Oliver, calm, even, neutral
  fr: 'fr_marie_neutral',  // Marie, composed, steady
  nl: 'voice_3145',        // Lotte
  de: 'voice_481',         // Heidi
  es: 'voice_483',         // Elena
  it: 'voice_482',         // Lorenzo
  pt: 'voice_480',         // Gabriela (Brazilian, like the Portuguese player texts)
  no: 'voice_3134',        // Lars
  pl: 'voice_3154',        // Leon
  ro: 'voice_3155',        // Irina
  tr: 'voice_3138'         // Oran
};

/**
 * Languages read by Voxtral TTS (11 of Gryffi's 14 journey languages).
 * Danish, Finnish and Swedish use the browser's Web Speech API client-side.
 * Keep in sync with SERVER_TTS_LANGUAGES in app/public/js/builder.js.
 */
export const VOXTRAL_TTS_LANGUAGES = Object.keys(NATIVE_VOICES);

// Voxtral has a ~300 word soft limit per request; the client chunks text at
// sentence boundaries (~1100 chars) well below this hard cap.
export const MAX_TTS_INPUT_LENGTH = 2000;

const REQUEST_TIMEOUT_MS = 45000;
const CACHE_DIR = path.join(__dirname, '../../uploads/tts-cache');

// Deduplicate concurrent generation of the same audio (e.g. a group of
// users starting the same journey step at the same time).
const inFlight = new Map();

/**
 * Whether speech can be generated: the AI provider is configured and has a TTS model.
 * @returns {Promise<boolean>}
 */
export async function isTtsConfigured() {
  if (!(await isAiConfigured()) || !(await getSetting('ai.speech'))) return false;
  return !!(await getAiConfig()).ttsModel;
}

export function isTtsLanguageSupported(language) {
  return VOXTRAL_TTS_LANGUAGES.includes(String(language || '').toLowerCase());
}

export function getTtsCacheDir() {
  return CACHE_DIR;
}

/**
 * The voice for a language: an override per language, the native preset, and
 * only then the general voice from the settings. A single general voice must
 * not win over a native one, or one voice would read every language with its
 * own pronunciation.
 */
function getVoiceForLanguage(language, defaultVoice) {
  return process.env[`TTS_VOXTRAL_VOICE_${language.toUpperCase()}`]
    || NATIVE_VOICES[language]
    || defaultVoice;
}

class TtsError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Return the cache filename for the given text+language, generating the
 * audio via Voxtral if it isn't cached yet.
 * @returns {Promise<{fileName: string, cached: boolean}>}
 */
export async function getOrCreateTtsAudio(text, language) {
  const lang = String(language || '').toLowerCase();

  if (!(await isTtsConfigured())) {
    throw new TtsError('TTS_NOT_CONFIGURED', 'No AI provider with a speech model is configured', 503);
  }
  if (!isTtsLanguageSupported(lang)) {
    throw new TtsError('TTS_LANGUAGE_UNSUPPORTED', `Language '${lang}' is not supported by Voxtral TTS`, 422);
  }

  // Normalize whitespace before hashing to maximize cache hits
  const input = String(text || '').replace(/\s+/g, ' ').trim();
  if (!input) {
    throw new TtsError('TTS_EMPTY_TEXT', 'No text provided', 422);
  }
  if (input.length > MAX_TTS_INPUT_LENGTH) {
    throw new TtsError('TTS_TEXT_TOO_LONG', `Text exceeds ${MAX_TTS_INPUT_LENGTH} characters`, 413);
  }

  const { ttsModel, ttsVoice } = await getAiConfig();
  const voice = getVoiceForLanguage(lang, ttsVoice);
  const hash = crypto
    .createHash('sha256')
    .update([ttsModel, voice, lang, input].join('\u0000'))
    .digest('hex');
  const fileName = `${hash}.mp3`;
  const filePath = path.join(CACHE_DIR, fileName);

  if (fs.existsSync(filePath)) {
    return { fileName, cached: true };
  }

  let promise = inFlight.get(hash);
  if (!promise) {
    promise = synthesize(input, voice, ttsModel, filePath);
    inFlight.set(hash, promise);
    // The caller awaits `promise` itself; this branch only cleans up, and must not
    // leave a second, unhandled rejection behind when the request fails.
    promise.finally(() => inFlight.delete(hash)).catch(() => {});
  }
  await promise;

  return { fileName, cached: false };
}

/**
 * Call Voxtral and write the resulting MP3 atomically to the cache.
 */
async function synthesize(input, voice, model, filePath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await aiFetch('/audio/speech', {
      body: JSON.stringify({
        model,
        input,
        voice,
        response_format: 'mp3'
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      // Mistral's moderation sometimes blocks harmless text (in November 2026 a
      // sentence about colleagues with ADHD or dyslexia, as hate and
      // discrimination). The speech endpoint takes no guardrail settings, so the
      // player falls back to the browser voice; the log line shows how often.
      if (response.status === 403 && errBody.includes('guardrail')) {
        console.warn(`[TTS] Mistral moderation blocked a text (${input.length} characters)`);
        throw new TtsError('TTS_BLOCKED', 'Voxtral TTS request blocked by Mistral moderation', 502);
      }
      throw new TtsError(
        'TTS_UPSTREAM_ERROR',
        `Voxtral TTS request failed (${response.status}): ${errBody.slice(0, 300)}`,
        502
      );
    }

    // The API returns JSON with base64 audio_data; handle raw audio bytes
    // as well in case the response format changes.
    let audioBuffer;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      if (!data?.audio_data) {
        throw new TtsError('TTS_UPSTREAM_ERROR', 'Voxtral TTS response missing audio_data', 502);
      }
      audioBuffer = Buffer.from(data.audio_data, 'base64');
    } else {
      audioBuffer = Buffer.from(await response.arrayBuffer());
    }

    if (audioBuffer.length < 100) {
      throw new TtsError('TTS_UPSTREAM_ERROR', 'Voxtral TTS returned empty audio', 502);
    }

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, audioBuffer);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new TtsError('TTS_TIMEOUT', 'Voxtral TTS request timed out', 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared Express handler used by the player, public player and dashboard
 * TTS endpoints (each performs its own authorization first).
 * Body: { text, language } -> { success, url }
 */
export async function handleTtsRequest(req, res) {
  const { text, language } = req.body || {};

  try {
    const { fileName } = await getOrCreateTtsAudio(text, language);
    res.json({ success: true, url: `/tts-audio/${fileName}` });
  } catch (err) {
    if (err instanceof TtsError) {
      // Expected conditions (unsupported language, not configured, upstream
      // down): the client silently falls back to the Web Speech API.
      if (err.code === 'TTS_UPSTREAM_ERROR' || err.code === 'TTS_TIMEOUT') {
        console.warn('[TTS]', err.message);
      }
      return res.status(err.httpStatus).json({ success: false, error: err.code });
    }
    console.error('[TTS] Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'TTS_ERROR' });
  }
}

/**
 * Remove cached audio files that haven't been modified in `maxAgeDays`.
 * Unchanged steps simply regenerate on the next listen; this keeps the
 * cache directory from growing without bound. Called by the scheduler.
 */
export function cleanupTtsCache(maxAgeDays = 60) {
  let removed = 0;
  try {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(CACHE_DIR)) {
      const filePath = path.join(CACHE_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        // Also remove stray .tmp files from interrupted writes
        if (stat.mtimeMs < cutoff || (file.endsWith('.tmp') && stat.mtimeMs < Date.now() - 60 * 60 * 1000)) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch {
        // File may have been removed concurrently - ignore
      }
    }
    if (removed > 0) {
      console.log(`[TTS] Cache cleanup removed ${removed} file(s) older than ${maxAgeDays} days`);
    }
  } catch (err) {
    console.error('[TTS] Cache cleanup error:', err);
  }
  return removed;
}
