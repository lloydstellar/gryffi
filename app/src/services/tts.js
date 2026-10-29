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


// Native preset voices per language. Voxtral's preset catalog currently
// only contains English and French voices; its cross-lingual voice
// adaptation reads other languages with an English pronunciation, which
// sounds wrong, so we only enable languages that have a native voice.
// Override per language via TTS_VOXTRAL_VOICE_<LANG> (e.g.
// TTS_VOXTRAL_VOICE_NL) once custom voice profiles with native reference
// audio are created via Mistral's Voices API - then also add the language
// to VOXTRAL_TTS_LANGUAGES below and to the client list.
const NATIVE_VOICES = {
  en: 'gb_oliver_neutral', // calm, even, neutral
  fr: 'fr_marie_neutral'
};

/**
 * Languages read by Voxtral TTS (subset of Gryffi's 14 journey languages).
 * All other languages use the browser's Web Speech API client-side.
 * Keep in sync with SERVER_TTS_LANGUAGES in app/public/js/builder.js.
 */
export const VOXTRAL_TTS_LANGUAGES = ['en', 'fr'];

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

function getVoiceForLanguage(language, defaultVoice) {
  return process.env[`TTS_VOXTRAL_VOICE_${language.toUpperCase()}`]
    || defaultVoice
    || NATIVE_VOICES[language];
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
    promise.finally(() => inFlight.delete(hash));
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
