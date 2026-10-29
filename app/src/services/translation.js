/**
 * Translation Service - Gryffi Journey Translation
 * Uses Mistral AI to translate journey content to different languages
 */

import { aiFetch, getAiConfig, isAiConfigured } from './aiProvider.js';


/**
 * Language names for prompts
 */
const LANGUAGE_NAMES = {
  en: 'English',
  nl: 'Dutch (Nederlands)',
  de: 'German (Deutsch)',
  fr: 'French (Français)',
  es: 'Spanish (Español)',
  it: 'Italian (Italiano)',
  pt: 'Portuguese (Português)',
  da: 'Danish (Dansk)',
  no: 'Norwegian (Norsk)',
  fi: 'Finnish (Suomi)',
  sv: 'Swedish (Svenska)',
  pl: 'Polish (Polski)',
  ro: 'Romanian (Română)',
  tr: 'Turkish (Türkçe)'
};

/**
 * Gryffi product glossary — these terms MUST be translated using the
 * product-specific translation, never a generic dictionary translation.
 * Keyed by target language code; each entry maps the English term (lowercase)
 * to the required product translation.
 */
const GRYFFI_GLOSSARY = {
  nl: {
    'journey': 'Expeditie',       'journeys': 'Expedities',
    'space': 'Ruimte',            'guide': 'Gids',
    'content': 'Inhoud',          'challenge': 'Quiz',
    'form': 'Formulier',          'poll': 'Peiling',
    'reward': 'Beloning',         'sub-journey': 'Sub-expeditie',
    'ai guide': 'AI Gids',        'maker': 'Maker',
    'makers': 'Makers',           'end user': 'Eindgebruiker',
    'end users': 'Eindgebruikers','knowledge base': 'Kennisbank',
    'builder': 'Builder',         'analytics': 'Analyse',
    'step': 'Stap',               'steps': 'Stappen',
  },
  de: {
    'journey': 'Expedition',      'journeys': 'Expeditionen',
    'space': 'Raum',              'guide': 'Begleiter',
    'content': 'Inhalt',          'challenge': 'Quiz',
    'form': 'Formular',           'poll': 'Umfrage',
    'reward': 'Belohnung',        'sub-journey': 'Sub-Expedition',
    'ai guide': 'KI-Begleiter',   'maker': 'Autor',
    'makers': 'Autoren',          'end user': 'Endbenutzer',
    'end users': 'Endbenutzer',   'knowledge base': 'Wissensbasis',
    'builder': 'Builder',         'analytics': 'Einblicke',
    'step': 'Schritt',            'steps': 'Schritte',
  },
  fr: {
    'journey': 'Parcours',        'journeys': 'Parcours',
    'space': 'Espace',            'guide': 'Guide',
    'content': 'Contenu',         'challenge': 'Défi',
    'form': 'Formulaire',         'poll': 'Sondage',
    'reward': 'Récompense',       'sub-journey': 'Sous-parcours',
    'ai guide': 'Guide IA',       'maker': 'Créateur',
    'makers': 'Créateurs',        'end user': 'Utilisateur final',
    'end users': 'Utilisateurs finaux', 'knowledge base': 'Base de connaissances',
    'builder': 'Créateur',        'analytics': 'Analyses',
    'step': 'Étape',              'steps': 'Étapes',
  },
  es: {
    'journey': 'Expedición',      'journeys': 'Expediciones',
    'space': 'Espacio',           'guide': 'Guía',
    'content': 'Contenido',       'challenge': 'Desafío',
    'form': 'Formulario',         'poll': 'Encuesta',
    'reward': 'Recompensa',       'sub-journey': 'Sub-expedición',
    'ai guide': 'Guía de IA',     'maker': 'Creador',
    'makers': 'Creadores',        'end user': 'Usuario final',
    'end users': 'Usuarios finales', 'knowledge base': 'Base de conocimientos',
    'builder': 'Constructor',     'analytics': 'Análisis',
    'step': 'Paso',               'steps': 'Pasos',
  }
};

/**
 * Build the glossary instruction block for a target language.
 * Returns an empty string when no glossary is available for the language.
 */
function buildGlossaryInstruction(targetLang) {
  const glossary = GRYFFI_GLOSSARY[targetLang];
  if (!glossary) return '';
  const lines = Object.entries(glossary)
    .map(([en, loc]) => `  "${en}" → "${loc}"`)
    .join('\n');
  return `\nMANDATORY GLOSSARY — always use these exact translations for the following product-specific terms:\n${lines}\nThese are product terms, NOT generic words. For example "Journey" must NEVER be translated as a travel-related word; use the glossary term above.\n`;
}

/**
 * Literal-protection: URLs and email addresses must NEVER be translated,
 * because the translation breaks the link or the address. Even with explicit
 * prompt instructions, LLMs occasionally rewrite them (e.g. "support@gryffi.com"
 * → "ondersteuning@gryffi.com"). To make this robust we mask URLs and emails
 * with opaque placeholders before sending to the API and restore them
 * afterwards. The placeholder uses the same `{{...}}` shape that the prompt
 * already instructs the model to preserve.
 *
 * Order matters: URL-shaped tokens (incl. `mailto:` and `www.`) are masked
 * before bare email addresses, so a `mailto:foo@bar.com` is captured as a
 * whole and not split into "mailto:" + email.
 */
const URL_RE = /(?:https?:\/\/|mailto:)[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
const TRAILING_PUNCT_RE = /[.,!?;:)\]'"]+$/;
const PROTECT_TOKEN_RE = /\{\{__GRYFFI_PROTECT_(\d+)__\}\}/g;

function makeProtectToken(index) {
  return `{{__GRYFFI_PROTECT_${index}__}}`;
}

/**
 * Replace URLs and email addresses with placeholders that survive translation.
 * @param {string} text
 * @returns {{ masked: string, tokens: string[] }}
 */
function protectLiterals(text) {
  if (text === null || text === undefined) return { masked: text, tokens: [] };
  if (typeof text !== 'string' || text === '') return { masked: text, tokens: [] };

  const tokens = [];
  let masked = text;

  const replaceWith = (regex) => {
    masked = masked.replace(regex, (match) => {
      // Strip sentence-level trailing punctuation so "Visit https://gryffi.com."
      // restores cleanly to "Bezoek https://gryffi.com." instead of swallowing
      // the period into the link.
      let core = match;
      let trail = '';
      const trailMatch = core.match(TRAILING_PUNCT_RE);
      if (trailMatch) {
        trail = trailMatch[0];
        core = core.slice(0, -trail.length);
      }
      if (!core) return match;
      const idx = tokens.length;
      tokens.push(core);
      return makeProtectToken(idx) + trail;
    });
  };

  replaceWith(URL_RE);
  replaceWith(EMAIL_RE);

  return { masked, tokens };
}

/**
 * Restore previously-protected literals in a translated string. Any token
 * the LLM happened to mangle is left as-is so the caller can detect it,
 * but in practice the `{{...}}` form is preserved verbatim by Mistral.
 */
function restoreLiterals(text, tokens) {
  if (!tokens || tokens.length === 0) return text;
  if (text === null || text === undefined || typeof text !== 'string') return text;
  return text.replace(PROTECT_TOKEN_RE, (match, idx) => {
    const i = parseInt(idx, 10);
    return Number.isInteger(i) && i >= 0 && i < tokens.length ? tokens[i] : match;
  });
}

/**
 * Make a translation request to Mistral API
 * @param {string} model - Model to use
 * @param {string} systemPrompt - System prompt
 * @param {string} text - Text to translate
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<{success: boolean, translated?: string, timedOut?: boolean}>}
 */
async function makeTranslationRequest(model, systemPrompt, text, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await aiFetch('/chat/completions', {
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: 0.3,
        max_tokens: Math.max(500, text.length * 2)
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Translation] API error with ${model}:`, response.status, errorText);
      return { success: false };
    }
    
    const data = await response.json();
    const translated = data.choices?.[0]?.message?.content;
    
    if (!translated) {
      console.error(`[Translation] Empty response from ${model}`);
      return { success: false };
    }
    
    return { success: true, translated: translated.trim() };
    
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      return { success: false, timedOut: true };
    }
    console.error(`[Translation] Error with ${model}:`, error.message);
    return { success: false };
  }
}

/**
 * Translate a single text using Mistral AI
 * Uses primary model first, falls back to faster model on timeout
 * @param {string} text - Text to translate
 * @param {string} targetLang - Target language code
 * @param {string} sourceLang - Source language code (optional, defaults to auto-detect)
 * @returns {Promise<string>} - Translated text
 */
export async function translateText(text, targetLang, sourceLang = 'auto') {
  if (!(await isAiConfigured())) {
    console.warn('[Translation] No AI provider configured');
    return text;
  }
  const { chatModel, fallbackModel } = await getAiConfig();
  
  if (!text || text.trim() === '') {
    return text;
  }
  
  const targetLanguageName = LANGUAGE_NAMES[targetLang] || targetLang;
  const sourceLanguageName = sourceLang !== 'auto' ? LANGUAGE_NAMES[sourceLang] || sourceLang : 'the source language';
  
  const { masked, tokens } = protectLiterals(text);

  const glossaryBlock = buildGlossaryInstruction(targetLang);
  const systemPrompt = `You are a professional translator for the Gryffi platform. Translate the following text from ${sourceLanguageName} to ${targetLanguageName}.
${glossaryBlock}
CRITICAL RULES:
1. Return ONLY the translated text, nothing else
2. Preserve all formatting, line breaks, and special characters
3. Do NOT add quotes, explanations, or notes
4. Keep HTML tags intact if present
5. Preserve placeholders like {{name}}, {variable}, or {{__GRYFFI_PROTECT_N__}} EXACTLY as they appear (do not translate, rename, or remove them)
6. NEVER translate, localise, or modify URLs, web addresses, or email addresses; copy them verbatim
7. If the text is already in the target language, return it unchanged
8. Maintain the same tone and style as the original`;

  // Try primary model first with 10 second timeout
  const startTime = Date.now();
  console.log(`[Translation] Starting translation with primary model: ${chatModel}`);
  
  const primaryResult = await makeTranslationRequest(chatModel, systemPrompt, masked, 10000);
  const primaryDuration = Date.now() - startTime;
  
  if (primaryResult.success) {
    console.log(`[Translation] ✓ Primary model completed in ${primaryDuration}ms`);
    return restoreLiterals(primaryResult.translated, tokens);
  }
  
  // If primary timed out, try fallback model
  if (primaryResult.timedOut) {
    console.warn(`[Translation] ⏱ Primary model (${chatModel}) TIMED OUT after ${primaryDuration}ms`);
    
    if (fallbackModel !== chatModel) {
      console.log(`[Translation] → Switching to fallback model: ${fallbackModel}`);
      const fallbackStart = Date.now();
      const fallbackResult = await makeTranslationRequest(fallbackModel, systemPrompt, masked, 10000);
      const fallbackDuration = Date.now() - fallbackStart;
      
      if (fallbackResult.success) {
        console.log(`[Translation] ✓ Fallback model completed in ${fallbackDuration}ms (total: ${Date.now() - startTime}ms)`);
        return restoreLiterals(fallbackResult.translated, tokens);
      }
      
      if (fallbackResult.timedOut) {
        console.error(`[Translation] ✗ Fallback model (${fallbackModel}) ALSO TIMED OUT after ${fallbackDuration}ms`);
        console.error(`[Translation] ✗ Both models failed! Total time: ${Date.now() - startTime}ms`);
      }
    } else {
      console.warn('[Translation] No different fallback model configured, skipping retry');
    }
  } else {
    console.error(`[Translation] ✗ Primary model failed (not timeout) after ${primaryDuration}ms`);
  }
  
  // Return original text if all attempts failed
  console.warn(`[Translation] Returning original text after ${Date.now() - startTime}ms`);
  return text;
}

/**
 * Translate multiple texts in a single batch request
 * More efficient than individual calls for multiple texts
 * @param {string[]} texts - Array of texts to translate
 * @param {string} targetLang - Target language code
 * @param {string} sourceLang - Source language code (optional)
 * @returns {Promise<string[]>} - Array of translated texts
 */
export async function translateBatch(texts, targetLang, sourceLang = 'auto') {
  console.log(`[Translation] translateBatch called with ${texts.length} texts, target: ${targetLang}`);
  if (!(await isAiConfigured())) {
    console.warn('[Translation] No AI provider configured');
    return texts;
  }
  const { chatModel } = await getAiConfig();
  
  // Filter out empty texts but keep track of their positions
  const textsWithIndices = texts.map((text, index) => ({ text, index, isEmpty: !text || text.trim() === '' }));
  const nonEmptyTexts = textsWithIndices.filter(t => !t.isEmpty);
  
  if (nonEmptyTexts.length === 0) {
    return texts;
  }
  
  const targetLanguageName = LANGUAGE_NAMES[targetLang] || targetLang;
  const sourceLanguageName = sourceLang !== 'auto' ? LANGUAGE_NAMES[sourceLang] || sourceLang : 'the source language';
  
  // Mask URLs and emails per text so the model cannot translate or rewrite
  // them. Each entry keeps its own token list because token indices are
  // local to the masked text.
  const protectedTexts = nonEmptyTexts.map(t => protectLiterals(t.text));

  // Create numbered list for batch translation
  const numberedInput = protectedTexts.map((p, i) => `[${i + 1}] ${p.masked}`).join('\n---\n');
  
  const glossaryBlock = buildGlossaryInstruction(targetLang);
  const systemPrompt = `You are a professional translator for the Gryffi platform. Translate each numbered text from ${sourceLanguageName} to ${targetLanguageName}.
${glossaryBlock}
CRITICAL RULES:
1. Return translations in the EXACT same numbered format: [1] translated text
2. Preserve the separator "---" between items
3. Do NOT add explanations, notes, or extra content
4. Preserve all HTML tags, placeholders like {{name}}, {variable}, and any token of the form {{__GRYFFI_PROTECT_N__}} EXACTLY as they appear (do not translate, rename, or remove them)
5. NEVER translate, localise, or modify URLs, web addresses, or email addresses; copy them verbatim
6. Keep the same tone and style as the original
7. If a text is already in the target language, return it unchanged

INPUT FORMAT:
[1] text one
---
[2] text two

OUTPUT FORMAT (same structure):
[1] translated text one
---
[2] translated text two`;

  try {
    console.log(`[Translation] Calling the AI provider with model: ${chatModel}`);
    console.log(`[Translation] Input length: ${numberedInput.length} chars`);
    
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout for batch
    
    const response = await aiFetch('/chat/completions', {
      body: JSON.stringify({
        model: chatModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: numberedInput }
        ],
        temperature: 0.3,
        max_tokens: Math.max(1000, numberedInput.length * 2)
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    console.log(`[Translation] Mistral API response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Translation] Batch API error:', response.status, errorText);
      const err = new Error(`Translation API error: ${response.status}`);
      err.statusCode = response.status;
      err.apiResponse = errorText;
      throw err;
    }
    
    const data = await response.json();
    const translatedContent = data.choices?.[0]?.message?.content;
    
    console.log(`[Translation] Received translation response, length: ${translatedContent?.length || 0} chars`);
    
    if (!translatedContent) {
      console.error('[Translation] Empty batch response from API');
      throw new Error('Translation API returned empty response');
    }
    
    // Parse the numbered output
    const translatedTexts = parseNumberedOutput(translatedContent, nonEmptyTexts.length);
    
    console.log(`[Translation] Parsed ${translatedTexts.length} translated texts`);
    
    // Reconstruct the full array with empty strings in their original positions.
    // Restore protected literals (URLs, emails) per item using the per-text
    // token list captured before sending to the API.
    const result = [...texts];
    nonEmptyTexts.forEach((item, i) => {
      if (translatedTexts[i]) {
        result[item.index] = restoreLiterals(translatedTexts[i], protectedTexts[i].tokens);
      }
    });
    
    return result;
    
  } catch (error) {
    console.error('[Translation] Batch error:', error.message);
    if (error.statusCode) {
      throw error;
    }
    const wrappedError = new Error(`Translation batch failed: ${error.message}`);
    wrappedError.statusCode = error.statusCode || 500;
    throw wrappedError;
  }
}

/**
 * Parse numbered output from batch translation
 * @param {string} output - The raw output from the API
 * @param {number} expectedCount - Expected number of items
 * @returns {string[]} - Array of translated texts
 */
function parseNumberedOutput(output, expectedCount) {
  const results = [];
  
  // Split by separator
  const parts = output.split(/---+/);
  
  for (const part of parts) {
    // Match [number] content pattern
    const match = part.match(/\[(\d+)\]\s*([\s\S]*)/);
    if (match) {
      const index = parseInt(match[1], 10) - 1;
      const content = match[2].trim();
      if (index >= 0 && index < expectedCount) {
        results[index] = content;
      }
    }
  }
  
  // Fill any missing indices with empty strings
  for (let i = 0; i < expectedCount; i++) {
    if (results[i] === undefined) {
      results[i] = '';
    }
  }
  
  return results;
}

/**
 * Translate journey content with progress callback
 * @param {Object} journeyData - Journey data with steps, paths, resources
 * @param {string} targetLang - Target language code
 * @param {string} sourceLang - Source language code (optional)
 * @param {Function} onProgress - Callback for progress updates (0-100)
 * @returns {Promise<Object>} - Translated journey data
 */
export async function translateJourneyContent(journeyData, targetLang, sourceLang = 'auto', onProgress = () => {}) {
  console.log(`[Translation] translateJourneyContent called, target: ${targetLang}`);
  const { journey, steps, paths, resources } = journeyData;
  console.log(`[Translation] Journey: ${journey.title}, Steps: ${steps.length}, Paths: ${paths.length}, Resources: ${resources.length}`);
  
  // Collect all translatable content with references
  const translations = [];
  
  // Journey level
  if (journey.title) {
    translations.push({ type: 'journey', field: 'title', value: journey.title });
  }
  if (journey.description) {
    translations.push({ type: 'journey', field: 'description', value: journey.description });
  }
  
  // Steps
  steps.forEach((step, stepIndex) => {
    // Step title
    if (step.title) {
      translations.push({ type: 'step', index: stepIndex, field: 'title', value: step.title });
    }
    
    const basicProps = typeof step.basic_props === 'string' 
      ? JSON.parse(step.basic_props) 
      : (step.basic_props || {});
    
    // Type-specific fields
    switch (step.type) {
      case 'space':
        if (basicProps.description) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.description', value: basicProps.description });
        }
        break;
        
      case 'guide':
        if (basicProps.greeting) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.greeting', value: basicProps.greeting });
        }
        break;
        
      case 'content':
        if (basicProps.body) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.body', value: basicProps.body });
        }
        // Also translate media_description (used when media_type is 'image' or 'video')
        if (basicProps.media_description) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.media_description', value: basicProps.media_description });
        }
        break;
        
      case 'challenge':
        // Two challenge formats exist in the wild and both must be translated:
        //
        //   1. Multi-question format (current):
        //        basic_props.questions[i].question
        //        basic_props.questions[i].options[j].text
        //
        //   2. Legacy single-question format (older journeys):
        //        basic_props.question
        //        basic_props.options[j].text
        //
        // The player normalises legacy steps on the fly (see builder.js
        // case 'challenge' fallback), so we leave the structure intact and
        // translate the fields in place. Without this branch, legacy
        // challenge steps would silently keep their source-language text
        // after a copy-translate.
        if (basicProps.questions && Array.isArray(basicProps.questions) && basicProps.questions.length > 0) {
          basicProps.questions.forEach((question, qIndex) => {
            if (question.question) {
              translations.push({ 
                type: 'step', 
                index: stepIndex, 
                field: `basic_props.questions.${qIndex}.question`, 
                value: question.question 
              });
            }
            if (question.options && Array.isArray(question.options)) {
              question.options.forEach((option, oIndex) => {
                if (option && option.text) {
                  translations.push({ 
                    type: 'step', 
                    index: stepIndex, 
                    field: `basic_props.questions.${qIndex}.options.${oIndex}.text`, 
                    value: option.text 
                  });
                }
              });
            }
          });
        } else {
          if (basicProps.question) {
            translations.push({ 
              type: 'step', 
              index: stepIndex, 
              field: 'basic_props.question', 
              value: basicProps.question 
            });
          }
          if (basicProps.options && Array.isArray(basicProps.options)) {
            basicProps.options.forEach((option, oIndex) => {
              if (option && option.text) {
                translations.push({ 
                  type: 'step', 
                  index: stepIndex, 
                  field: `basic_props.options.${oIndex}.text`, 
                  value: option.text 
                });
              }
            });
          }
        }
        // Also translate advanced_props for challenge (pass/fail messages)
        const challengeAdvancedProps = typeof step.advanced_props === 'string' 
          ? JSON.parse(step.advanced_props || '{}') 
          : (step.advanced_props || {});
        if (challengeAdvancedProps.pass_message) {
          translations.push({ 
            type: 'step', 
            index: stepIndex, 
            field: 'advanced_props.pass_message', 
            value: challengeAdvancedProps.pass_message 
          });
        }
        if (challengeAdvancedProps.fail_message) {
          translations.push({ 
            type: 'step', 
            index: stepIndex, 
            field: 'advanced_props.fail_message', 
            value: challengeAdvancedProps.fail_message 
          });
        }
        break;
        
      case 'poll':
        if (basicProps.question) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.question', value: basicProps.question });
        }
        if (basicProps.options && Array.isArray(basicProps.options)) {
          basicProps.options.forEach((option, oIndex) => {
            if (option.text) {
              translations.push({ 
                type: 'step', 
                index: stepIndex, 
                field: `basic_props.options.${oIndex}.text`, 
                value: option.text 
              });
            }
          });
        }
        break;
        
      case 'form':
        if (basicProps.description) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.description', value: basicProps.description });
        }
        if (basicProps.email_subject) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.email_subject', value: basicProps.email_subject });
        }
        if (basicProps.fields && Array.isArray(basicProps.fields)) {
          basicProps.fields.forEach((field, fIndex) => {
            if (field.label) {
              translations.push({ 
                type: 'step', 
                index: stepIndex, 
                field: `basic_props.fields.${fIndex}.label`, 
                value: field.label 
              });
            }
            if (field.options) {
              translations.push({ 
                type: 'step', 
                index: stepIndex, 
                field: `basic_props.fields.${fIndex}.options`, 
                value: field.options 
              });
            }
          });
        }
        // Also translate advanced_props for form (confirmation message)
        const formAdvancedProps = typeof step.advanced_props === 'string' 
          ? JSON.parse(step.advanced_props || '{}') 
          : (step.advanced_props || {});
        if (formAdvancedProps.confirmation_message) {
          translations.push({ 
            type: 'step', 
            index: stepIndex, 
            field: 'advanced_props.confirmation_message', 
            value: formAdvancedProps.confirmation_message 
          });
        }
        break;
        
      case 'reward':
        if (basicProps.title) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.title', value: basicProps.title });
        }
        if (basicProps.description) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.description', value: basicProps.description });
        }
        if (basicProps.redemption_location) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.redemption_location', value: basicProps.redemption_location });
        }
        if (basicProps.terms_conditions) {
          translations.push({ type: 'step', index: stepIndex, field: 'basic_props.terms_conditions', value: basicProps.terms_conditions });
        }
        break;
    }
  });
  
  // Paths
  paths.forEach((path, pathIndex) => {
    if (path.label) {
      translations.push({ type: 'path', index: pathIndex, field: 'label', value: path.label });
    }
    if (path.description) {
      translations.push({ type: 'path', index: pathIndex, field: 'description', value: path.description });
    }
  });
  
  // Resources
  resources.forEach((resource, resourceIndex) => {
    if (resource.name) {
      translations.push({ type: 'resource', index: resourceIndex, field: 'name', value: resource.name });
    }
    if (resource.description) {
      translations.push({ type: 'resource', index: resourceIndex, field: 'description', value: resource.description });
    }
  });
  
  console.log(`[Translation] Collected ${translations.length} translatable items`);
  
  if (translations.length === 0) {
    console.log('[Translation] No content to translate');
    onProgress(100, 'no_content');
    return journeyData;
  }
  
  // Translate in batches
  // Mistral rate limit: 6 requests/second, so we use larger batches and longer delays
  const BATCH_SIZE = 20; // Larger batches = fewer API calls
  const DELAY_BETWEEN_BATCHES = 500; // 500ms = max 2 requests/second (well under limit)
  const totalBatches = Math.ceil(translations.length / BATCH_SIZE);
  console.log(`[Translation] Will process ${totalBatches} batches of max ${BATCH_SIZE} items (rate limit: ${DELAY_BETWEEN_BATCHES}ms delay)`);
  
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, translations.length);
    const batch = translations.slice(start, end);
    
    console.log(`[Translation] Processing batch ${batchIndex + 1}/${totalBatches} (${batch.length} items)`);
    
    const textsToTranslate = batch.map(t => t.value);
    
    let translatedTexts = null;
    let retries = 0;
    const MAX_RETRIES = 3;
    
    while (retries < MAX_RETRIES && translatedTexts === null) {
      try {
        translatedTexts = await translateBatch(textsToTranslate, targetLang, sourceLang);
      } catch (err) {
        retries++;
        if (retries < MAX_RETRIES) {
          const backoffDelay = 2000 * retries;
          console.warn(`[Translation] Batch ${batchIndex + 1} failed (${err.message}), retry ${retries}/${MAX_RETRIES} after ${backoffDelay}ms`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        } else {
          console.error(`[Translation] Batch ${batchIndex + 1} failed after ${MAX_RETRIES} retries: ${err.message}`);
          const translationError = new Error(`Translation failed after ${MAX_RETRIES} retries: ${err.message}`);
          translationError.statusCode = err.statusCode;
          translationError.batch = batchIndex + 1;
          throw translationError;
        }
      }
    }
    
    console.log(`[Translation] Batch ${batchIndex + 1} completed`);
    
    // Apply translations back
    batch.forEach((item, i) => {
      item.translated = translatedTexts[i];
    });
    
    // Report progress
    const progress = Math.round(((batchIndex + 1) / totalBatches) * 80);
    console.log(`[Translation] Reporting progress: ${progress}%`);
    onProgress(progress, 'translating');
    
    // Delay between batches to respect rate limits (500ms = max 2 req/s)
    if (batchIndex < totalBatches - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
    }
  }
  
  console.log('[Translation] All batches completed, applying translations');
  
  // Apply translations to the journey data
  const translatedJourney = { ...journey };
  const translatedSteps = steps.map(s => ({
    ...s,
    basic_props: typeof s.basic_props === 'string' ? JSON.parse(s.basic_props) : { ...(s.basic_props || {}) },
    advanced_props: typeof s.advanced_props === 'string' ? JSON.parse(s.advanced_props || '{}') : { ...(s.advanced_props || {}) }
  }));
  const translatedPaths = paths.map(p => ({ ...p }));
  const translatedResources = resources.map(r => ({ ...r }));
  
  for (const item of translations) {
    if (!item.translated) continue;
    
    if (item.type === 'journey') {
      translatedJourney[item.field] = item.translated;
    } else if (item.type === 'step') {
      const step = translatedSteps[item.index];
      setNestedValue(step, item.field, item.translated);
    } else if (item.type === 'path') {
      translatedPaths[item.index][item.field] = item.translated;
    } else if (item.type === 'resource') {
      translatedResources[item.index][item.field] = item.translated;
    }
  }
  
  onProgress(90, 'finishing');
  
  return {
    journey: translatedJourney,
    steps: translatedSteps,
    paths: translatedPaths,
    resources: translatedResources
  };
}

/**
 * Set a nested value in an object using dot notation
 * @param {Object} obj - Object to modify
 * @param {string} path - Dot-notation path (e.g., 'basic_props.questions.0.text')
 * @param {any} value - Value to set
 */
function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const index = parseInt(part, 10);
    
    if (!isNaN(index)) {
      current = current[index];
    } else {
      if (current[part] === undefined) {
        current[part] = {};
      }
      current = current[part];
    }
  }
  
  const lastPart = parts[parts.length - 1];
  const lastIndex = parseInt(lastPart, 10);
  
  if (!isNaN(lastIndex)) {
    current[lastIndex] = value;
  } else {
    current[lastPart] = value;
  }
}

/**
 * Get supported languages for translation
 * @returns {Object[]} - Array of language objects with code and name
 */
export function getSupportedLanguages() {
  return Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({
    code,
    name
  }));
}

export default { 
  translateText, 
  translateBatch, 
  translateJourneyContent,
  getSupportedLanguages,
  LANGUAGE_NAMES 
};
