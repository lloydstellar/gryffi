/**
 * Help Service - Gryffi AI Help Assistant
 * Server-side RAG implementation for help documentation
 *
 * This service:
 * - Loads and indexes all help markdown files at startup
 * - Provides semantic search across help documentation
 * - Generates AI responses using Mistral with context from docs
 * - Returns navigation links to relevant parts of the app
 * - Serves the help pages as articles, grouped in categories
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { aiFetch, getAiConfig, isAiConfigured, messageText } from './aiProvider.js';
import redis from '../db/redis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to help documentation (mounted as Docker volume)
const HELP_BASE_PATH = '/help-base';
const LOCALES_PATH = '/app/locales';

// Mistral API configuration

// Cache for loaded help documents
let helpDocsCache = [];
let lastCacheUpdate = null;

// Cache for UI glossary per language
const uiGlossaryCache = {};
// Cache for the English UI text -> translated UI text index per language
const uiTermIndexCache = {};

/**
 * Language names for prompts
 */
const LANGUAGE_NAMES = {
  en: 'English',
  nl: 'Dutch (Nederlands)',
  de: 'German (Deutsch)',
  fr: 'French (Français)',
  es: 'Spanish (Español)'
};

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const AI_TIMEOUT_MS = 25000;

/**
 * One chat completion. A busy provider (429) or a server error gets two more
 * tries, the last one on the fallback model, so a maker who asks a few
 * questions in a row still gets an answer.
 * @param {Array<{role: string, content: string}>} messages
 * @param {{maxTokens: number, temperature?: number, model?: string, timeoutMs?: number, json?: boolean}} options
 * @returns {Promise<string>} the answer text
 * @throws when every try failed or AI is not configured
 */
async function chatCompletion(messages, { maxTokens, temperature = 0.3, model, timeoutMs = AI_TIMEOUT_MS, json = false } = {}) {
  const config = await getAiConfig();
  const first = model || config.chatModel;
  const models = [first, first, config.fallbackModel || first];
  let lastError = null;
  for (let attempt = 0; attempt < models.length; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 800 * attempt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await aiFetch('/chat/completions', {
        body: JSON.stringify({
          model: models[attempt], messages, temperature, max_tokens: maxTokens,
          ...(json ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: controller.signal
      });
      if (response.ok) {
        const text = messageText(await response.json()).trim();
        if (text) return text;
        lastError = new Error('Empty response');
      } else {
        lastError = new Error(`HTTP ${response.status}`);
        if (!RETRY_STATUSES.has(response.status)) break;
      }
    } catch (err) {
      if (err?.name === 'AiNotConfiguredError') throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('AI request failed');
}

/**
 * Load UI glossary from i18n files for a specific language
 * Extracts key UI terms that should be used in help responses
 */
function loadUIGlossary(language) {
  if (uiGlossaryCache[language]) {
    return uiGlossaryCache[language];
  }
  
  try {
    const localePath = path.join(LOCALES_PATH, `${language}.json`);
    if (!fs.existsSync(localePath)) {
      return null;
    }
    
    const localeData = JSON.parse(fs.readFileSync(localePath, 'utf-8'));
    
    // Extract key UI terms for the glossary
    const glossary = {};
    
    // Navigation items
    if (localeData.nav) {
      glossary['Dashboard'] = localeData.nav.dashboard || 'Dashboard';
      glossary['Journeys'] = localeData.nav.journeys || 'Journeys';
      glossary['Guides'] = localeData.nav.guides || 'Guides';
      glossary['Invitations'] = localeData.nav.invitations || 'Invitations';
      glossary['Settings'] = localeData.nav.settings || 'Settings';
      glossary['System Settings'] = localeData.nav.systemSettings || 'System Settings';
      glossary['Participants'] = localeData.nav.participants || 'Participants';
      glossary['Team'] = localeData.nav.team || 'Team';
      glossary['Analytics'] = localeData.nav.analytics || 'Analytics';
    }
    
    // Builder step types
    if (localeData.builder?.stepTypes) {
      glossary['Space'] = localeData.builder.stepTypes.space || 'Space';
      glossary['Space step'] = localeData.builder.stepTypes.space || 'Space';
      glossary['Guide'] = localeData.builder.stepTypes.guide || 'Guide';
      glossary['Guide step'] = localeData.builder.stepTypes.guide || 'Guide';
      glossary['AI Guide'] = localeData.builder.stepTypes.aiGuide || 'AI Guide';
      glossary['Content'] = localeData.builder.stepTypes.content || 'Content';
      glossary['Content step'] = localeData.builder.stepTypes.content || 'Content';
      glossary['Challenge'] = localeData.builder.stepTypes.challenge || 'Challenge';
      glossary['Challenge step'] = localeData.builder.stepTypes.challenge || 'Challenge';
      glossary['Quiz'] = localeData.builder.stepTypes.challenge || 'Quiz';
      glossary['Form'] = localeData.builder.stepTypes.form || 'Form';
      glossary['Form step'] = localeData.builder.stepTypes.form || 'Form';
      glossary['Poll'] = localeData.builder.stepTypes.poll || 'Poll';
      glossary['Poll step'] = localeData.builder.stepTypes.poll || 'Poll';
      glossary['Reward'] = localeData.builder.stepTypes.reward || 'Reward';
      glossary['Reward step'] = localeData.builder.stepTypes.reward || 'Reward';
      glossary['Step'] = localeData.builder.stepTypes.step || 'Step';
    }
    
    // Common actions
    if (localeData.common) {
      glossary['Save'] = localeData.common.save || 'Save';
      glossary['Delete'] = localeData.common.delete || 'Delete';
      glossary['Edit'] = localeData.common.edit || 'Edit';
      glossary['Create'] = localeData.common.create || 'Create';
      glossary['Add'] = localeData.common.add || 'Add';
      glossary['Cancel'] = localeData.common.cancel || 'Cancel';
      glossary['Confirm'] = localeData.common.confirm || 'Confirm';
      glossary['Change'] = localeData.common.change || 'Change';
      glossary['Remove'] = localeData.common.remove || 'Remove';
      glossary['Continue'] = localeData.common.continue || 'Continue';
      glossary['Manage'] = localeData.common.manage || 'Manage';
    }
    
    // Journey actions
    if (localeData.journeys?.actions) {
      glossary['Preview'] = localeData.journeys.actions.preview || 'Preview';
      glossary['Publish'] = localeData.journeys.actions.publish || 'Publish';
      glossary['Unpublish'] = localeData.journeys.actions.unpublish || 'Unpublish';
      glossary['Archive'] = localeData.journeys.actions.archive || 'Archive';
      glossary['Copy'] = localeData.journeys.actions.copy || 'Copy';
    }
    
    // Dashboard actions
    if (localeData.dashboard?.actions) {
      glossary['New Journey'] = localeData.dashboard.actions.newJourney || 'New Journey';
      glossary['Send Invitation'] = localeData.dashboard.actions.sendInvitation || 'Send Invitation';
      glossary['Add Participant'] = localeData.dashboard.actions.addEndUser || 'Add Participant';
    }
    
    // Auth terms
    if (localeData.auth) {
      glossary['Sign In'] = localeData.auth.signIn || 'Sign In';
      glossary['Log In'] = localeData.auth.signIn || 'Log In';
      glossary['Password'] = localeData.auth.password || 'Password';
      glossary['Email'] = localeData.auth.email || 'Email';
    }
    
    // Journey-specific terms
    if (localeData.journeys) {
      glossary['Journey'] = localeData.guides?.stats?.journey || 'Journey';
      glossary['Journeys'] = localeData.nav?.journeys || 'Journeys';
      glossary['Create Journey'] = localeData.journeys.createJourney || 'Create Journey';
      glossary['Draft'] = localeData.journeys.status?.draft || 'Draft';
      glossary['Published'] = localeData.journeys.status?.published || 'Published';
      glossary['Archived'] = localeData.journeys.status?.archived || 'Archived';
    }
    
    // Builder terms
    if (localeData.builder) {
      glossary['Journey Builder'] = localeData.builder.title || localeData.help?.topics?.journeyBuilder || 'Journey Builder';
      glossary['Builder'] = localeData.builder.title || 'Builder';
    }
    
    // Participant terms (the people who follow journeys)
    if (localeData.systemSettings?.users || localeData.dashboard?.stats) {
      glossary['Participant'] = localeData.builder?.automations?.variableCategories?.endUser || 'Participant';
      glossary['Participants'] = localeData.systemSettings?.users?.title || localeData.dashboard?.stats?.endUsers || 'Participants';
    }
    
    // Maker/Team terms
    if (localeData.team) {
      glossary['Maker'] = localeData.team.title?.replace(/s$/, '') || 'Maker';
      glossary['Makers'] = localeData.nav?.team || 'Makers';
    }
    
    // Guides-specific terms
    if (localeData.guides) {
      glossary['AI Guide'] = localeData.guides.title || 'AI Guide';
      glossary['Knowledge Base'] = localeData.guides.knowledgeBase?.title || localeData.guides.detail?.knowledgeBase || 'Knowledge Base';
    }
    
    // System settings terms
    if (localeData.systemSettings) {
      glossary['API tab'] = localeData.systemSettings.tabs?.api || 'API';
      glossary['Themes tab'] = localeData.systemSettings.tabs?.themes || 'Themes';
      glossary['General tab'] = localeData.systemSettings.tabs?.general || 'General';
      glossary['Custom Theme'] = localeData.systemSettings.themes?.customTheme || 'Custom Theme';
      glossary['Create Theme'] = localeData.systemSettings.themes?.createTheme || 'Create Theme';
    }
    
    // Subscription terms
    if (localeData.subscription) {
      glossary['Subscription'] = localeData.subscription.title || 'Subscription';
      glossary['Current Plan'] = localeData.subscription.currentPlan?.title
        || (typeof localeData.subscription.currentPlan === 'string' ? localeData.subscription.currentPlan : 'Current Plan');
    }
    
    // Settings terms
    if (localeData.settings) {
      glossary['Two-Factor Authentication'] = localeData.settings.twoFactor?.title || localeData.settings.security?.twoFactorTitle || 'Two-Factor Authentication';
      glossary['2FA'] = localeData.settings.twoFactor?.title || '2FA';
      glossary['Profile'] = localeData.settings.profile?.title || 'Profile';
      glossary['Security'] = localeData.settings.security?.title || 'Security';
    }
    
    // Sync providers
    if (localeData.systemSettings?.users?.sync) {
      glossary['Microsoft Sync'] = localeData.systemSettings.users.sync.microsoft?.title || 'Microsoft Sync';
      glossary['Google Sync'] = localeData.systemSettings.users.sync.google?.title || 'Google Sync';
      glossary['Google Workspace'] = localeData.systemSettings.users.sync.google?.title || 'Google Workspace';
    }
    
    // Invitations
    if (localeData.invitations) {
      glossary['Invitation'] = localeData.nav?.invitations || 'Invitation';
      glossary['Invitations'] = localeData.nav?.invitations || 'Invitations';
      glossary['Send Invitation'] = localeData.invitations.sendInvitation || localeData.dashboard?.actions?.sendInvitation || 'Send Invitation';
    }
    
    // Knowledge base
    if (localeData.guides?.knowledgeBase) {
      glossary['Knowledge Base'] = localeData.guides.knowledgeBase.title || localeData.guides.detail?.knowledgeBase || 'Knowledge Base';
      glossary['Add Knowledge'] = localeData.guides.knowledgeBase.addKnowledge || 'Add Knowledge';
    }
    
    // Trash/Archive
    glossary['Trash'] = localeData.journeys?.trash?.title || 'Trash';
    glossary['Move to Trash'] = localeData.journeys?.actions?.delete || 'Move to Trash';
    
    uiGlossaryCache[language] = glossary;
    console.log(`[Help Service] Loaded UI glossary for ${language}: ${Object.keys(glossary).length} terms`);
    return glossary;
    
  } catch (error) {
    console.warn(`[Help Service] Could not load glossary for ${language}:`, error.message);
    return null;
  }
}

/**
 * Gryffi's own word for "journey" in a maker language, as the interface uses it
 * (expeditie, Expedition, parcours, expedición)
 * @returns {{singular: string, plural: string}|null}
 */
function getJourneyTerm(language) {
  if (language === 'en') return null;
  try {
    const locale = JSON.parse(fs.readFileSync(path.join(LOCALES_PATH, `${language}.json`), 'utf-8'));
    const singular = locale.guides?.stats?.journey;
    const plural = locale.guides?.stats?.journeys;
    return singular && plural ? { singular, plural } : null;
  } catch {
    return null;
  }
}

/**
 * Format glossary as a string for the AI prompt
 */
/**
 * Every UI text of the interface, from English to another language: the
 * values of the same keys in en.json and <language>.json. Keyed by the
 * lowercased English text; when a text has several translations, the most
 * common one wins.
 */
function loadUITermIndex(language) {
  if (uiTermIndexCache[language]) return uiTermIndexCache[language];
  const index = new Map();
  try {
    const en = JSON.parse(fs.readFileSync(path.join(LOCALES_PATH, 'en.json'), 'utf-8'));
    const target = JSON.parse(fs.readFileSync(path.join(LOCALES_PATH, `${language}.json`), 'utf-8'));
    const counts = new Map();
    (function walk(a, b) {
      for (const [key, value] of Object.entries(a)) {
        const translated = b?.[key];
        if (typeof value === 'string' && typeof translated === 'string') {
          const text = value.trim();
          if (!text || text.length > 60 || text.includes('{{') || text === translated.trim()) continue;
          const options = counts.get(text.toLowerCase()) || new Map();
          options.set(translated.trim(), (options.get(translated.trim()) || 0) + 1);
          counts.set(text.toLowerCase(), options);
        } else if (value && typeof value === 'object' && translated && typeof translated === 'object') {
          walk(value, translated);
        }
      }
    })(en, target);
    for (const [text, options] of counts) {
      index.set(text, [...options.entries()].sort((x, y) => y[1] - x[1])[0][0]);
    }
  } catch (err) {
    console.error('[Help Service] Could not build the UI term index:', err.message);
  }
  uiTermIndexCache[language] = index;
  return index;
}

/**
 * The UI names in the given help pages (in bold or quotes: "Click **Save**")
 * with their translation, so answers use the labels the maker sees
 */
function termsFromDocs(docs, language) {
  const index = loadUITermIndex(language);
  const terms = {};
  for (const doc of docs) {
    for (const match of (doc.content || '').matchAll(/\*\*([^*\n]{2,60})\*\*|"([^"\n]{2,40})"/g)) {
      const term = (match[1] || match[2]).trim().replace(/[.:]$/, '');
      // A plural title ("Floor Plans") uses the singular UI name ("Floor plan")
      const lower = term.toLowerCase();
      const translated = index.get(lower) || (lower.endsWith('s') ? index.get(lower.slice(0, -1)) : null);
      if (translated) terms[term] = translated;
    }
  }
  return terms;
}

// How much of each help page goes to the model: more of the best match
const FIRST_DOC_CHARS = 6000;
const OTHER_DOC_CHARS = 1500;

/**
 * The embedding of a question: from the search just before, or new. Null
 * without a semantic index.
 */
async function questionVector(query) {
  if (queryVectors.has(query)) return queryVectors.get(query);
  if (sectionIndex.length === 0) return null;
  try {
    const { embedding } = await getAiConfig();
    const [vector] = await embedTexts([query], embedding.model);
    rememberQueryVector(query, vector);
    return vector;
  } catch {
    return null;
  }
}

/**
 * The part of a help page that fits in the budget: the whole page when it
 * fits, otherwise its introduction and then its ## parts in order of how well
 * they match the question, shown in the order of the page. Without a question
 * vector the page is cut at the budget, as before.
 */
function relevantParts(doc, text, queryVector, budget) {
  if (text.length <= budget) return text;
  if (!queryVector) return text.substring(0, budget);

  const parts = text.split(/^(?=## )/m).map((part, index) => ({ index, part: part.trim(), heading: index === 0 ? '' : sectionHeading(part) }));
  const similarity = new Map();
  for (const section of sectionIndex) {
    if (section.docId !== doc.id || !section.heading) continue;
    const value = cosine(queryVector, section.vector);
    if (value > (similarity.get(section.heading) ?? -1)) similarity.set(section.heading, value);
  }

  const chosen = new Set([0]);
  let used = parts[0].part.length;
  const ranked = parts.slice(1).sort((a, b) => (similarity.get(b.heading) ?? -1) - (similarity.get(a.heading) ?? -1));
  for (const part of ranked) {
    if (used + part.part.length > budget) continue;
    chosen.add(part.index);
    used += part.part.length;
  }
  return parts
    .filter(part => chosen.has(part.index))
    .map(part => (part.index === 0 ? part.part.substring(0, budget) : part.part))
    .join('\n\n')
    .substring(0, budget);
}

/**
 * The documentation with its UI names (in bold or quotes) replaced by the
 * labels the maker sees, so the model copies the right label
 */
function localizeUiNames(text, terms) {
  if (!terms || Object.keys(terms).length === 0) return text;
  return text.replace(/\*\*([^*\n]{2,60})\*\*|"([^"\n]{2,40})"/g, (match, bold, quoted) => {
    const term = (bold || quoted).trim().replace(/[.:]$/, '');
    const translated = terms[term];
    if (!translated) return match;
    return bold ? `**${translated}**` : `"${translated}"`;
  });
}

function formatGlossaryForPrompt(glossary) {
  if (!glossary || Object.keys(glossary).length === 0) {
    return '';
  }
  
  const terms = Object.entries(glossary)
    .map(([en, translated]) => `${en} = "${translated}"`)
    .join('\n');
  
  return terms;
}

/**
 * Parse frontmatter from markdown content
 * @param {string} content - Raw markdown content
 * @returns {Object} - { frontmatter: Object, body: string }
 */
function parseFrontmatter(content) {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  const frontmatterStr = match[1];
  const body = match[2];
  
  // Simple YAML parsing for our use case
  const frontmatter = {};
  const lines = frontmatterStr.split('\n');
  
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();
      
      // Parse arrays
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(v => v.trim());
      }
      
      frontmatter[key] = value;
    }
  }
  
  return { frontmatter, body };
}

/**
 * Extract navigation links from markdown content
 *
 * Help markdown files use `[[goto:/dashboard/...]]` markers to indicate the
 * relevant in-app route for a topic. We use the first one we find as the
 * "Go to page" button target in the help modal. Legacy `[[show:...]]`
 * markers for screenshots are ignored — the help center no longer renders
 * screenshots.
 *
 * @param {string} content - Markdown content
 * @returns {Object} - { links: [] }
 */
function extractTags(content) {
  const links = [];
  const gotoRegex = /\[\[goto:([^\]]+)\]\]/g;
  let match;
  while ((match = gotoRegex.exec(content)) !== null) {
    links.push(match[1]);
  }
  return { links };
}

/**
 * Screenshots in a help page are Markdown images of the English version:
 * ![description](images/<page>/<name>.en.webp), optionally followed by a
 * numbered list that explains the numbered markers in the image. Other
 * languages sit next to it as <name>.<lang>.webp. The image lines are replaced
 * by a short "[Screenshot: ...]" note, so the AI never sees file paths.
 *
 * @param {string} content - Markdown content
 * @returns {Object} - { content, plainContent, images: [{ base, alt, legend: [{ number, text }] }] }
 *   content keeps a "[Screenshot: ...]" note with the legend; plainContent
 *   leaves screenshots out entirely (for keywords and for other pages in the
 *   AI context, whose screenshots are not shown)
 */
// eslint-disable-next-line security/detect-unsafe-regex -- runs on the help-base files in the repository, never on user input
const IMAGE_BLOCK = /^!\[([^\]]*)\]\((images\/[a-z0-9-]+\/[a-z0-9-]+)\.en\.webp\)[ \t]*\n(?:\n((?:\d+\. .*(?:\n|$))+))?/gm;

function extractImages(content) {
  const images = [];
  const text = content.replace(IMAGE_BLOCK, (block, alt, base, list = '') => {
    // The numbers of the markers run on over the screenshots of one page
    const legend = list.split('\n').map(line => line.match(/^(\d+)\.\s*(.*)$/)).filter(Boolean)
      .map(([, number, text]) => ({ number: Number(number), text: text.trim() }));
    images.push({ base, alt: alt.trim(), legend });
    return `[Screenshot: ${alt.trim()}]\n${list ? '\n' + list : ''}`;
  });
  const plainContent = content.replace(IMAGE_BLOCK, '');
  return { content: text, plainContent, images };
}

/**
 * A help page as an article for the help window: text blocks (Markdown) and
 * screenshot blocks in the order of the page. The title, the [[goto:]] tags,
 * HTML comments and the "Related Features" part are left out; the related
 * pages come from the frontmatter and the "See:" line of that part.
 * @param {string} rawBody - Markdown without frontmatter
 * @param {string[]} frontmatterRelated - related_features from the frontmatter
 * @returns {{ blocks: Array<{type: 'text', text: string}|{type: 'image', index: number}>, related: string[] }}
 */
function articleFromBody(rawBody, frontmatterRelated) {
  const relatedPart = rawBody.match(/^## Related Features?\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  const seeAlso = relatedPart
    ? [...relatedPart[1].matchAll(/^- See:\s*(.+)$/gm)].flatMap(m => m[1].split(',').map(id => id.trim()))
    : [];
  const related = [...new Set([...(Array.isArray(frontmatterRelated) ? frontmatterRelated : []), ...seeAlso])];

  const body = (relatedPart ? rawBody.replace(relatedPart[0], '') : rawBody)
    .replace(/^# .+\n?/m, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\[\[(?:goto|show):[^\]]*\]\][ \t]*$/gm, '')
    .replace(/\[\[(?:goto|show):[^\]]*\]\]/g, '');

  const blocks = [];
  let last = 0;
  let index = 0;
  const addText = (text) => {
    const trimmed = text.replace(/\n{3,}/g, '\n\n').trim();
    if (trimmed) blocks.push({ type: 'text', text: trimmed });
  };
  for (const match of body.matchAll(IMAGE_BLOCK)) {
    addText(body.slice(last, match.index));
    blocks.push({ type: 'image', index: index++ });
    last = match.index + match[0].length;
  }
  addText(body.slice(last));
  return { blocks, related };
}

/**
 * Screenshot URLs of a help page for a language, falling back to English
 * @param {Object} doc - Help document
 * @param {string} language - Maker interface language
 * @returns {Array<{src: string, alt: string, markers: Object}>}
 */
function getHelpImages(doc, language = 'en') {
  return (doc?.images || []).map(({ base, alt }) => {
    const localized = `${base}.${language}.webp`;
    const file = fs.existsSync(path.join(HELP_BASE_PATH, localized)) ? localized : `${base}.en.webp`;
    // Positions of the numbered markers (fractions of the image), written by the
    // screenshot generator next to each image
    let markers = {};
    try {
      markers = JSON.parse(fs.readFileSync(path.join(HELP_BASE_PATH, file.replace(/\.webp$/, '.json')), 'utf-8')).markers || {};
    } catch {
      // no marker file: the image still shows, without highlighting
    }
    return { src: `/help-${file}`, alt, markers };
  });
}

/**
 * Extract keywords from markdown content for search
 * @param {string} content - Markdown content
 * @returns {string[]} - Array of keywords
 */
function extractKeywords(content) {
  // Remove markdown formatting
  const text = content
    .replace(/```[\s\S]*?```/g, '') // Code blocks
    .replace(/\[\[.*?\]\]/g, '') // Custom tags
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links
    .replace(/[#*_`|]/g, '') // Markdown chars
    .replace(/\|.*?\|/g, '') // Table cells
    .toLowerCase();
  
  // Extract words
  const words = text.match(/\b[a-z]{3,}\b/g) || [];
  
  // Remove common stop words
  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'her', 'was', 'one', 'our', 'out', 'his', 'had', 'will', 'each', 'about', 'when', 'this', 'that', 'with', 'from', 'have', 'they', 'been', 'said', 'them', 'than', 'into', 'some', 'could', 'other', 'which', 'their', 'there', 'would', 'these', 'more']);
  
  return [...new Set(words.filter(w => !stopWords.has(w)))];
}

/**
 * Load all help documents from the help-base directory
 * @returns {Promise<Array>} - Array of parsed help documents
 */
async function loadHelpDocuments() {
  const docs = [];
  
  try {
    const files = fs.readdirSync(HELP_BASE_PATH)
      .filter(f => f.endsWith('.md') && !f.startsWith('_'));
    
    for (const file of files) {
      const filePath = path.join(HELP_BASE_PATH, file);
      // Cloud-only passages are marked with <!-- cloud:start/end -->; the
      // Community Edition is published without them, here only the markers go
      const content = fs.readFileSync(filePath, 'utf-8').replace(/<!-- cloud:(start|end) -->\n?/g, '');
      const { frontmatter, body: rawBody } = parseFrontmatter(content);
      const { content: body, plainContent, images } = extractImages(rawBody);
      const { links } = extractTags(body);
      const keywords = extractKeywords(plainContent);
      const words = new Set(tokenize(plainContent));
      const article = articleFromBody(rawBody, frontmatter.related_features);

      // Get feature ID from frontmatter or filename
      const featureId = frontmatter.feature_id || file.replace('.md', '');

      docs.push({
        id: featureId,
        filename: file,
        title: extractTitle(body),
        frontmatter,
        content: body,
        plainContent,
        links,
        images,
        keywords,
        words,
        relatedFeatures: frontmatter.related_features || [],
        article
      });
    }
    
    console.log(`[Help Service] Loaded ${docs.length} help documents`);
  } catch (error) {
    console.error('[Help Service] Error loading help documents:', error.message);
  }
  
  return docs;
}

/**
 * Extract title from markdown content (first H1)
 * @param {string} content - Markdown content
 * @returns {string} - Title or empty string
 */
function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

/**
 * Initialize help cache
 */
export async function initHelpCache({ waitForIndex = false } = {}) {
  helpDocsCache = await loadHelpDocuments();
  lastCacheUpdate = new Date();
  // Embeddings for semantic search are built in the background; until they
  // are ready, searchHelp uses word matching only
  const build = buildSemanticIndex(helpDocsCache).catch(err => {
    console.warn('[Help Service] Semantic index not built:', err.message);
  });
  if (waitForIndex) await build;
  return helpDocsCache.length;
}

// ============================================
// SEMANTIC SEARCH
// Help pages are embedded per section (## heading) with the configured
// embedding model. A question in any language is matched on meaning, so a
// Dutch question finds the English page. Vectors are kept in memory by a hash
// of model and text, so a cache refresh only embeds sections that changed.
// ============================================

const SECTION_MAX_CHARS = 1500;
const EMBED_BATCH_SIZE = 32;
const vectorCache = new Map(); // hash -> vector
let sectionIndex = [];         // [{ docId, intro, heading, vector }]
const queryVectors = new Map();  // question -> its embedding, for the answer after the search
let indexBuild = null;
const INDEX_WAIT_MS = 10000;  // how long a search waits for the index after a start

function splitSections(doc) {
  const parts = doc.plainContent
    .replace(/\[\[[^\]]*\]\]/g, '')
    .split(/^## /m);
  const sections = [];
  parts.forEach((part, i) => {
    const text = (i === 0 ? part : `## ${part}`).replace(/^# .*$/m, '').trim();
    if (text.length < 40) return;
    // The ## heading ties the chunks to the part of the page they come from
    const heading = i === 0 ? '' : sectionHeading(text);
    // Long sections are cut at paragraph boundaries
    let chunk = '';
    for (const paragraph of text.split(/\n{2,}/)) {
      if (chunk && (chunk.length + paragraph.length) > SECTION_MAX_CHARS) {
        sections.push({ heading, text: chunk });
        chunk = '';
      }
      chunk += (chunk ? '\n\n' : '') + paragraph.slice(0, SECTION_MAX_CHARS);
    }
    if (chunk) sections.push({ heading, text: chunk });
  });
  return sections.map((section, i) => ({ docId: doc.id, intro: i === 0, heading: section.heading, text: `${doc.title}\n${section.text}` }));
}

// "## Troubleshooting" -> "troubleshooting": the key of a part of a page
function sectionHeading(text) {
  return (text.match(/^## (.+)$/m)?.[1] || '').replace(/<!--.*?-->/g, '').trim().toLowerCase();
}

function rememberQueryVector(query, vector) {
  queryVectors.set(query, vector);
  if (queryVectors.size > 100) queryVectors.delete(queryVectors.keys().next().value);
}

async function embedTexts(texts, model) {
  const response = await aiFetch('/embeddings', {
    body: JSON.stringify({ model, input: texts })
  }, { purpose: 'embeddings' });
  if (!response.ok) {
    throw new Error(`Embedding request failed with HTTP ${response.status}`);
  }
  const data = await response.json();
  const vectors = (data?.data || []).map(item => item.embedding);
  if (vectors.length !== texts.length) throw new Error('Embedding response has the wrong number of vectors');
  return vectors;
}

async function buildSemanticIndex(docs) {
  if (indexBuild) return indexBuild;
  indexBuild = (async () => {
    if (!(await isAiConfigured())) return;
    const { embedding } = await getAiConfig();
    const sections = docs.flatMap(splitSections).map(section => ({
      ...section,
      hash: crypto.createHash('sha256').update(`${embedding.model}\n${section.text}`).digest('hex')
    }));
    const missing = sections.filter(section => !vectorCache.has(section.hash));
    for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
      const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await embedTexts(batch.map(section => section.text), embedding.model);
      batch.forEach((section, j) => vectorCache.set(section.hash, vectors[j]));
    }
    sectionIndex = sections.map(section => ({ docId: section.docId, intro: section.intro, heading: section.heading, vector: vectorCache.get(section.hash) }));
    if (missing.length) {
      console.log(`[Help Service] Semantic index: ${sections.length} sections (${missing.length} embedded)`);
    }
  })().finally(() => { indexBuild = null; });
  return indexBuild;
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

/**
 * Similarity of the question to each help page, or null when there is no
 * index or no AI provider. A page scores on its best section and on its
 * title and introduction, so a long page does not win on a section that
 * happens to look like the question.
 * @returns {Promise<Map<string, number>|null>}
 */
async function semanticScores(query) {
  if (sectionIndex.length === 0) return null;
  try {
    const { embedding } = await getAiConfig();
    const [queryVector] = await embedTexts([query], embedding.model);
    rememberQueryVector(query, queryVector);
    const best = new Map();
    const intro = new Map();
    for (const section of sectionIndex) {
      const similarity = cosine(queryVector, section.vector);
      if (similarity > (best.get(section.docId) ?? -1)) best.set(section.docId, similarity);
      if (section.intro) intro.set(section.docId, similarity);
    }
    const scores = new Map();
    for (const [docId, similarity] of best) {
      scores.set(docId, 0.5 * similarity + 0.5 * (intro.get(docId) ?? similarity));
    }
    return scores;
  } catch (err) {
    console.warn('[Help Search] Semantic search unavailable:', err.message);
    return null;
  }
}

/**
 * Get or refresh help cache
 */
async function getHelpDocs() {
  // Refresh cache if older than 5 minutes (for development)
  const cacheAge = lastCacheUpdate ? Date.now() - lastCacheUpdate.getTime() : Infinity;
  if (helpDocsCache.length === 0 || cacheAge > 5 * 60 * 1000) {
    await initHelpCache();
  }
  return helpDocsCache;
}

/**
 * Synonym map for common query words
 */
// Verbs that mean the same thing
const VERB_SYNONYMS = {
  make: ['create', 'build', 'add', 'new'],
  create: ['make', 'build', 'add', 'new'],
  build: ['create', 'make', 'construct'],
  delete: ['remove', 'trash', 'erase'],
  remove: ['delete', 'trash', 'erase'],
  edit: ['modify', 'change', 'update'],
  change: ['edit', 'modify', 'update'],
  add: ['create', 'new', 'insert'],
  setup: ['configure', 'settings', 'set'],
  configure: ['setup', 'settings', 'set'],
  share: ['publish', 'invite', 'send', 'public'],
  publish: ['share', 'release', 'deploy'],
  sync: ['synchronize', 'connect', 'integrate'],
  import: ['upload', 'add', 'load'],
  export: ['download', 'save'],
  invite: ['invitation', 'invitations'],
  help: ['guide', 'assistant', 'support']
};

// The words makers use, and the words the help pages use for the same thing.
// Without an AI provider the help search only matches words, so a question
// about "end users", "employees" or a "course" must still find "participants"
// and "journeys". Gryffi's own names in the five maker languages are included,
// so that search works a little in those languages too.
const TERM_GROUPS = [
  [['employee', 'employees', 'staff', 'people', 'learner', 'learners', 'trainee', 'trainees',
    'student', 'students', 'hire', 'hires', 'newcomer', 'newcomers', 'worker', 'workers', 'enduser', 'endusers',
    'deelnemer', 'deelnemers', 'medewerker', 'medewerkers', 'eindgebruiker', 'eindgebruikers', 'teilnehmer', 'endbenutzer',
    'mitarbeiter', 'participante', 'participantes', 'empleado', 'empleados'], ['participant', 'participants']],
  [['course', 'courses', 'training', 'trainings', 'programme', 'program', 'module', 'modules', 'lesson', 'lessons',
    'expeditie', 'expedities', 'expedition', 'expeditionen', 'parcours', 'expedición', 'expediciones', 'cursus'], ['journey', 'journeys']],
  [['chatbot', 'chatbots', 'bot', 'bots', 'chat', 'assistant', 'gids', 'gidsen', 'guía', 'guías'], ['guide', 'guides']],
  [['document', 'documents', 'file', 'files', 'pdf', 'pdfs', 'manual', 'handbook'], ['knowledge', 'source', 'sources', 'upload']],
  [['test', 'tests', 'exam', 'exams', 'assessment', 'quiz', 'quizzes', 'quizvraag'], ['challenge', 'quiz', 'question', 'questions']],
  [['pass', 'passmark', 'mark', 'grade', 'retake', 'retry'], ['passing', 'score', 'attempts']],
  [['survey', 'surveys', 'vote', 'voting', 'opinion', 'peiling', 'umfrage', 'sondage', 'encuesta'], ['poll', 'polls']],
  [['certificate', 'certificates', 'badge', 'badges', 'prize', 'voucher', 'gift', 'beloning', 'belohnung', 'récompense', 'recompensa'], ['reward', 'rewards']],
  [['questionnaire', 'questionnaires', 'formulier', 'formular', 'formulaire', 'formulario'], ['form', 'forms']],
  [['map', 'maps', 'building', 'plattegrond'], ['floor', 'plan', 'plans']],
  [['photo', 'photos', 'picture', 'pictures', 'room', 'location', 'ruimte'], ['space', 'image', 'panorama']],
  [['video', 'videos', 'youtube', 'article', 'text'], ['content']],
  [['finished', 'completed', 'progress', 'statistics', 'stats', 'results', 'insights'], ['analytics', 'completion', 'reports']],
  [['colleague', 'colleagues', 'coworker', 'coworkers', 'editor', 'editors', 'admins', 'beheerder', 'beheerders'], ['maker', 'makers', 'team']],
  [['teams', 'department', 'departments', 'groep', 'groepen', 'gruppe', 'gruppen', 'groupe', 'grupo'], ['group', 'groups']],
  [['colour', 'colours', 'color', 'colors', 'brand', 'branding', 'logo', 'style', 'look', 'thema'], ['theme', 'themes', 'custom']],
  [['translate', 'translation', 'translations', 'vertalen', 'übersetzen', 'traduire', 'traducir'], ['translate', 'copy', 'language']],
  [['anonymous', 'anyone', 'openly', 'login', 'link'], ['public', 'magic']],
  [['azure', 'entra', 'office', 'outlook'], ['microsoft', 'sync']],
  [['gmail'], ['google', 'workspace', 'sync']],
  [['spreadsheet', 'excel', 'sheet'], ['csv', 'import']]
];

const SYNONYMS = { ...VERB_SYNONYMS };
for (const [words, helpWords] of TERM_GROUPS) {
  for (const word of words) {
    SYNONYMS[word] = [...new Set([...(SYNONYMS[word] || []), ...helpWords])];
  }
}

/**
 * Expand query words with synonyms
 */
function expandWithSynonyms(words) {
  const expanded = new Set(words);
  for (const word of words) {
    if (SYNONYMS[word]) {
      SYNONYMS[word].forEach(syn => expanded.add(syn));
    }
  }
  return [...expanded];
}

// Words that say nothing about the topic, in the five maker languages
const STOP_WORDS = new Set(`
  the and for are but not you all can has was one our out how what when where which who why with this that from have
  into some does did your my use using want need there their them then than about would could should will just also
  een het de en van voor met hoe wat waar wie welke kan ik mijn je jij jouw zijn niet ook maar dat die dit deze naar bij
  aan uit over wil moet kunnen worden wordt heb hebben zie mee
  der die das und ich wie was wer wo mit für ein eine einer einen dem den des auf zu ist kann mein meine sie nicht auch
  les des une pour avec comment est que qui dans sur pas mon mes vous je peut faire
  los las una para con como qué que cómo por mis puedo hacer del
`.split(/\s+/).filter(Boolean));

function tokenize(text) {
  return (text.toLowerCase().match(/\p{L}{3,}/gu) || []).filter(word => !STOP_WORDS.has(word));
}

/**
 * Word-match score of one help page (the original scoring, on whole words)
 */
function lexicalScore(doc, queryLower, expandedWords, context, idf, focus = '') {
  let score = 0;
  const titleWords = new Set(tokenize(doc.title));
  const idWords = new Set(doc.id.toLowerCase().split('-'));
  if (doc.title.toLowerCase().includes(queryLower)) score += 100;
  for (const word of expandedWords) {
    // A word in every page (such as "journey") says little about which page fits
    const weight = idf(word);
    if (titleWords.has(word)) score += 40 * weight;
    if (idWords.has(word)) score += 30 * weight;
    if (doc.keywords.includes(word)) score += 15 * weight;
    else if (word.length >= 5 && doc.keywords.some(k => k.length >= 5 && (k.startsWith(word) || word.startsWith(k)))) score += 8 * weight;
    if (doc.words.has(word)) score += 5 * weight;
  }
  if (doc.relatedFeatures.some(r => r.split('-').some(part => expandedWords.includes(part)))) score += 10;
  // The page the maker is on gets a small boost
  if (context && (doc.id.toLowerCase().includes(context.toLowerCase()))) score += 15;
  // The page about what the maker has selected (a quiz step in the builder) a bigger one
  if (focus && doc.id === focus) score += 40;
  return score;
}

/**
 * The help pages are in English and the embedding model matches English best,
 * so a question from a maker who uses another language is translated first,
 * with the small model. Returns the question unchanged when that is not possible.
 */
const englishQuestions = new Map();
async function toEnglish(query, language) {
  const key = `${language}\n${query}`;
  if (englishQuestions.has(key)) return englishQuestions.get(key);
  const term = getJourneyTerm(language);
  const termNote = term ? ` In this software, "${term.singular}" and "${term.plural}" mean journey and journeys.` : '';
  try {
    const { classifierModel } = await getAiConfig();
    const translated = await chatCompletion([
      { role: 'system', content: `Translate the question into English. Reply with the translated question only. Do not add or explain anything.${termNote}` },
      { role: 'user', content: query.slice(0, 500) }
    ], { model: classifierModel, temperature: 0, maxTokens: 80 });
    englishQuestions.set(key, translated);
    if (englishQuestions.size > 200) englishQuestions.delete(englishQuestions.keys().next().value);
    return translated;
  } catch {
    // the weaker search, on the question as asked
    return query;
  }
}

/**
 * Search help documents by query: meaning (embeddings) and word matches.
 * Without an AI provider, or before the index is built, word matches only.
 * @param {string} query - User's search query
 * @param {string} context - Current UI context (e.g., 'builder', 'settings')
 * @param {number} limit - Maximum results to return
 * @param {Object} [options]
 * @param {string} [options.language] - Interface language of the maker; other
 *   than English, the question is translated to English for the search
 * @returns {Promise<Array>} - Matching documents
 */
export async function searchHelp(query, context = '', limit = 5, { language = 'en', focus = '' } = {}) {
  const docs = await getHelpDocs();
  // Right after a start the semantic index is still being built. Wait for it
  // a little: word matching alone finds nothing for a question that is not
  // in English.
  if (indexBuild && sectionIndex.length === 0) {
    await Promise.race([indexBuild.catch(() => {}), new Promise(resolve => setTimeout(resolve, INDEX_WAIT_MS))]);
  }
  const searchQuery = language !== 'en' && sectionIndex.length > 0 ? await toEnglish(query, language) : query;
  const queryLower = searchQuery.toLowerCase().trim();
  const expandedWords = expandWithSynonyms([...new Set([...tokenize(queryLower), ...tokenize(query)])]);
  const semantic = await semanticScores(searchQuery);
  if (searchQuery !== query && queryVectors.has(searchQuery)) rememberQueryVector(query, queryVectors.get(searchQuery));

  // Inverse document frequency: 1 for a word in one page, 0 for a word in all
  const idf = (word) => {
    const count = docs.filter(doc => doc.words.has(word) || doc.id.includes(word)).length;
    return count === 0 ? 1 : Math.log((docs.length + 1) / (count + 1)) / Math.log(docs.length + 1);
  };
  const lexical = docs.map(doc => lexicalScore(doc, queryLower, expandedWords, context, idf, focus));
  const maxLexical = Math.max(1, ...lexical);
  let minSemantic = 0;
  let maxSemantic = 1;
  if (semantic) {
    const values = docs.map(doc => semantic.get(doc.id) ?? 0);
    minSemantic = Math.min(...values);
    maxSemantic = Math.max(...values);
  }

  const scored = docs.map((doc, i) => {
    const lexicalPart = lexical[i] / maxLexical;
    if (!semantic) return { ...doc, score: lexical[i] };
    const similarity = semantic.get(doc.id) ?? minSemantic;
    const semanticPart = maxSemantic > minSemantic ? (similarity - minSemantic) / (maxSemantic - minSemantic) : 0;
    return { ...doc, score: Math.round((0.7 * semanticPart + 0.3 * lexicalPart) * 1000) / 10 };
  });

  const results = scored
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // The question itself stays out of the logs: makers type it and it can hold customer data
  console.log('[Help Search]', semantic ? 'hybrid' : 'words only', '|', results.map(r => `${r.id} ${r.score}`).join(', ') || 'no results');
  return results;
}

/**
 * What the model sometimes adds although the prompt says not to: images,
 * "[Screenshot: ...]" notes and numbers in square brackets (the markers are
 * written as "(3)"; "[3]" would not link to the screenshot)
 * @param {string} text
 * @returns {string}
 */
function cleanAnswer(text) {
  return text
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
    .replace(/\[\((\d{1,2})\)\]/g, '($1)')
    .replace(/\[Screenshot:[^\]\n]*\]/gi, '')
    .replace(/ ?\[\d{1,2}\]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Generate AI response for help query
 * @param {string} query - User's question
 * @param {Array} relevantDocs - Relevant documentation, best match first
 * @param {string} context - Current UI context
 * @param {string} language - Response language
 * @param {Object} makerContext - Role and plan of the maker asking the question
 * @returns {Promise<Object>} - { answer, link, source: {id, title}|null, images };
 *   answer is null when no AI answer could be made (the help window then shows
 *   the article of the best match)
 */
export async function generateHelpResponse(query, relevantDocs, context, language = 'en', makerContext = null, selection = null) {
  const topDoc = relevantDocs[0];
  const sourceOf = (doc) => ({ link: doc?.links[0] || null, source: doc ? { id: doc.id, title: doc.title } : null });
  const base = sourceOf(topDoc);

  if (!(await isAiConfigured())) {
    return { ...base, answer: null, images: [] };
  }

  const languageName = LANGUAGE_NAMES[language] || 'English';

  // The screenshots of the first page, with their numbered markers. Only the
  // screenshots whose numbers the answer uses are shown with it.
  const shownScreenshots = topDoc?.images?.length
    ? `
SCREENSHOTS (from "${topDoc.title}"), with numbered markers:
${topDoc.images.map(img => img.legend.map(item => `(${item.number}) = ${item.text}`).join('\n')).join('\n')}
The screenshots in which your answer uses a number are shown next to your answer. When a step is about one of these elements, put its number in brackets right after the element, for example "Click Save (5)".
Check every number before you write it: the element you name must be exactly the element of that number in the list above. A similar element is not the same (for example "Convert to Public" is not "Convert to Private"). Never use a number that is not in the list, and never use a number from another page.
`
    : '';

  // The UI names in these help pages, with the labels the maker sees
  const docTerms = language !== 'en' ? termsFromDocs(relevantDocs, language) : {};

  // Build context from relevant docs; only the first one, whose screenshots
  // can be shown, keeps its screenshot legends. A long page does not fit: it
  // sends its introduction and the parts that fit the question best.
  const queryVector = await questionVector(query);
  const docsContext = relevantDocs.map((doc, i) => {
    const text = i === 0 ? doc.content : doc.plainContent.replace(/ \(\d{1,2}\)(?=[\s.,;:)]|$)/g, '');
    return `
=== ${doc.title} (${doc.id}) ===
${localizeUiNames(relevantParts(doc, text, queryVector, i === 0 ? FIRST_DOC_CHARS : OTHER_DOC_CHARS), docTerms)}
`;
  }).join('\n\n');

  // Load UI glossary for the target language, plus the UI names used in the
  // help pages of this answer
  const glossary = language !== 'en'
    ? { ...(loadUIGlossary(language) || {}), ...docTerms }
    : null;
  const glossarySection = glossary ? `
UI TERMINOLOGY (use these exact translations for UI elements):
${formatGlossaryForPrompt(glossary)}
` : '';

  // Role and plan: only to say that something needs another role or plan
  const makerLines = [];
  if (makerContext?.role) {
    const roleNames = {
      admin: 'Admin',
      manager: 'Journey Manager',
      member: 'Editor',
      editor: 'Editor',
      viewer: 'Viewer (read-only)'
    };
    makerLines.push(`- Role of the maker: ${roleNames[makerContext.role] || makerContext.role}`);
  }
  const tier = makerContext?.organization?.tier;
  if (tier) makerLines.push(`- Subscription plan: ${tier.displayName || tier.name}`);
  const makerContextSection = makerLines.length ? `
THE MAKER WHO ASKS:
${makerLines.join('\n')}
Mention the role or the plan only when the documentation says the feature needs a role or plan that this maker does not have.
` : '';

  // Gryffi's own word for "journey" in this language (expeditie, Expedition, ...)
  const journeyTerm = getJourneyTerm(language);
  const journeyRule = journeyTerm
    ? `\n7. In ${languageName}, Gryffi calls a journey "${journeyTerm.singular}" (plural "${journeyTerm.plural}"). Always use that word for journey and journeys, also when the documentation says "journey". Only keep "journey" when it is part of an exact UI name from the UI TERMINOLOGY section.`
    : '';

  const systemPrompt = `You are the Gryffi Help Assistant. You help makers (the people who build journeys) use Gryffi.

RULES:
1. Answer ONLY from the documentation below. Never invent buttons, menus, settings or features.
2. If the documentation does not answer the question, say in one sentence that the help documentation does not cover it, and suggest contacting support. If it answers only part of the question, answer that part and say what is not covered.
3. Do not guess or extrapolate beyond what is written. Never say that something is impossible, does not exist or cannot be undone, unless the documentation says so.
4. Always write in ${languageName}, the interface language of the maker: also when the documentation is in English and also when the question is asked in another language.
5. Use the EXACT UI names. The maker sees the interface in ${languageName}: write only the name from the UI TERMINOLOGY section, never the English one, not even in brackets.
6. Only answer about Gryffi.${journeyRule}
8. In the answer, never mention page ids, file names or documentation that is not shown here.
9. Refer to people without gender: "the participant", "they".${language === 'de' ? '\n10. In German, always address the maker formally with "Sie".' : ''}
${glossarySection}${makerContextSection}
THE MAKER IS ON THIS PAGE: "${context || 'dashboard'}"${selection?.stepType ? `\nTHE MAKER HAS THIS STEP TYPE SELECTED IN THE BUILDER: "${selection.stepType}"${selection.tab ? ` (panel tab: "${selection.tab}")` : ''}. Questions such as "how does this work" are about this step type.` : ''}

DOCUMENTATION (ONLY use information from this section):
${docsContext}
${shownScreenshots}
FORMAT:
- Start with the answer itself. No greeting, no "Here's how", and do not repeat the question.
- Never mention the name of the organization.
- For "how do I" questions: numbered steps (1. 2. 3.), one action per step, at most 7 steps.
- For other questions: a few short sentences. Use a list only when it makes the answer clearer.
- Short sentences in plain language, for people who are not technical.
- Use **bold** only for UI names.
- NEVER include URLs, paths, links, [[goto:...]] tags, images or "[Screenshot: ...]" notes.
- End with one last line: "SOURCE: " and the id (in brackets after the title above) of the page your answer mainly comes from, for example "SOURCE: ${topDoc?.id || 'dashboard'}". Write "SOURCE: none" when the documentation does not answer the question.`;

  try {
    const raw = await chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query }
    ], { maxTokens: 900, temperature: 0.2 });

    // The page the answer comes from, named by the model on the last line:
    // the best search match is not always the page that answers the question
    // A SOURCE note is not part of the answer; usually on a line of its own,
    // sometimes at the end of the last line, sometimes with more than one id
    let text = raw.trimEnd();
    let sourceDoc = topDoc;
    const at = text.toUpperCase().lastIndexOf('SOURCE:');
    const note = at === -1 ? '' : text.slice(at + 'SOURCE:'.length).replace(/[*_`()]/g, '').trim();
    if (at !== -1 && note.length <= 120 && /^[a-z0-9\-,. ]*$/i.test(note)) {
      text = text.slice(0, at).replace(/[*_(\s]+$/, '');
      const id = note.split(',')[0].trim().replace(/\.$/, '').toLowerCase();
      sourceDoc = id === 'none' ? null : (relevantDocs.find(doc => doc.id === id) || topDoc);
    }
    const answer = cleanAnswer(text);

    // Only the screenshots the answer points at: a screenshot the answer does
    // not refer to is often about another part of the page
    const used = new Set([...answer.matchAll(/\((\d{1,2})\)/g)].map(m => Number(m[1])));
    const images = getHelpImages(topDoc, language)
      .filter((image, i) => topDoc.images[i].legend.some(item => used.has(item.number)));

    return { ...sourceOf(sourceDoc), answer, images };
  } catch (error) {
    console.error('[Help Service] AI generation error:', error.message);
    return { ...base, answer: null, images: [] };
  }
}

// The help pages per category, in the order of the help window. A page that
// is missing (the Community Edition has no plan pages) is skipped; a page in
// no category goes to "other".
/** The help page about each step type in the builder */
export const STEP_TYPE_ARTICLES = {
  space: 'space-step',
  guide: 'guide-step',
  content: 'content-step',
  challenge: 'challenge-step',
  form: 'form-step',
  poll: 'poll-step',
  reward: 'reward-codes',
  nested_journey: 'subjourney-step'
};

const HELP_CATEGORIES = [
  { key: 'gettingStarted', ids: ['dashboard', 'journey-wizard', 'end-user-experience', 'organization-registration', 'login'] },
  { key: 'journeys', ids: ['journey-builder', 'journey-settings', 'journey-preview', 'public-journeys', 'copy-translate', 'custom-themes', 'image-library', 'trash'] },
  { key: 'steps', ids: ['space-step', 'floor-plans', 'guide-step', 'step-assistant', 'content-step', 'challenge-step', 'quiz-settings', 'form-step', 'form-file-uploads', 'form-email-settings', 'poll-step', 'reward-codes', 'subjourney-step', 'step-pacing'] },
  { key: 'guides', ids: ['ai-guides-overview', 'guide-knowledge-base', 'avatar-cropper', 'ai-credits'] },
  { key: 'participants', ids: ['end-user-management', 'manual-user-entry', 'csv-import', 'end-user-groups', 'microsoft-365-sync', 'google-workspace-sync', 'invitations-overview', 'invitation-options', 'magic-links'] },
  { key: 'analytics', ids: ['analytics-overview', 'reports', 'poll-results', 'form-submissions'] },
  { key: 'team', ids: ['team-management', 'maker-invitations', 'maker-roles', 'admin-role', 'manager-role', 'editor-role', 'viewer-role'] },
  { key: 'account', ids: ['user-settings', 'password-management', 'two-factor-authentication', 'authentication', 'language-settings', 'organization-settings', 'system-settings', 'api-access', 'api-keys'] },
  { key: 'plans', ids: ['subscription-overview', 'usage-limits', 'free-tier', 'professional-tier', 'enterprise-tier', 'custom-tier'] }
];

/**
 * All help pages, grouped in categories, for browsing in the help window
 * @param {string} [language] - Maker interface language of the titles
 * @returns {Promise<Array<{key: string, articles: Array<{id: string, title: string}>}>>}
 */
export async function getHelpTopics(language = 'en') {
  const docs = await getHelpDocs();
  const titles = await helpTitles(language);
  const byId = new Map(docs.map(doc => [doc.id, doc]));
  const listed = new Set(HELP_CATEGORIES.flatMap(category => category.ids));
  const categories = HELP_CATEGORIES.map(category => ({
    key: category.key,
    articles: category.ids.filter(id => byId.has(id)).map(id => ({ id, title: titles.get(id) }))
  }));
  const other = docs.filter(doc => !listed.has(doc.id))
    .map(doc => ({ id: doc.id, title: titles.get(doc.id) }))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (other.length) categories.push({ key: 'other', articles: other });
  return categories.filter(category => category.articles.length > 0);
}

// ============================================
// ARTICLE TRANSLATION
// The help pages are written in English. An article opened in another
// interface language is translated once by the AI and kept in Redis, under a
// hash of its text: a changed page is translated again.
// ============================================

const ARTICLE_CACHE_VERSION = 1;
const ARTICLE_TTL_SECONDS = 180 * 24 * 60 * 60;
const ARTICLE_BATCH_CHARS = 6000;
const ARTICLE_TIMEOUT_MS = 90000;
const articleTranslationsInFlight = new Map();

/**
 * The texts of an article that are translated, in a fixed order: the title,
 * the text blocks, then the legend lines of the screenshots
 */
function articleSegments(doc) {
  return [
    doc.title,
    ...doc.article.blocks.filter(block => block.type === 'text').map(block => block.text),
    ...doc.images.flatMap(image => image.legend.map(item => item.text))
  ];
}

/**
 * Translate a list of Markdown texts with one AI call
 * @returns {Promise<string[]>} the translations, in the same order
 */
async function translateSegments(segments, language, glossary) {
  const languageName = LANGUAGE_NAMES[language];
  const term = getJourneyTerm(language);
  const rules = [
    'Keep all Markdown: headings, lists and their numbering, tables, **bold** and `code`.',
    'Keep code blocks (``` ... ```) and everything in them unchanged.',
    'Keep every number in brackets, such as (3), in the same place: it points at a marker in a screenshot.',
    'Keep URLs, email addresses, file names and technical values (such as client IDs and OAuth scopes) unchanged.',
    'For names of buttons, menus and fields, use the exact translation from the UI TERMINOLOGY list when it has one.',
    'Write plain language with short sentences. Do not add, explain or leave out anything.'
  ];
  if (term) rules.push(`Gryffi calls a journey "${term.singular}" (plural "${term.plural}") in ${languageName}. Use that word.`);
  if (language === 'de') rules.push('Address the reader formally with "Sie".');
  const glossaryText = formatGlossaryForPrompt(glossary);

  const text = await chatCompletion([
    {
      role: 'system',
      content: `You translate help articles of Gryffi, a web application, from English into ${languageName}.
You get a JSON object whose values are Markdown texts, with the keys s1 to s${segments.length}. Reply with only a JSON object with exactly the same keys, each with the translation of its own text. Never merge or split texts.

RULES:
${rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}
${glossaryText ? `\nUI TERMINOLOGY (English = ${languageName}):\n${glossaryText}` : ''}`
    },
    { role: 'user', content: JSON.stringify(Object.fromEntries(segments.map((segment, i) => [`s${i + 1}`, segment]))) }
  ], { maxTokens: 8000, temperature: 0.1, timeoutMs: ARTICLE_TIMEOUT_MS, json: true });

  const reply = JSON.parse(text) || {};
  const translated = segments.map((segment, i) => reply[`s${i + 1}`]);
  if (translated.some((item, i) => typeof item !== 'string' || (!item.trim() && segments[i].trim()))) {
    throw new Error('Translation is missing segments');
  }
  return translated;
}

/**
 * Translate a batch; when the reply does not fit (a text merged, split or
 * missing), translate each half on its own, down to one text per call
 */
async function translateBatch(segments, language, glossary) {
  try {
    return await translateSegments(segments, language, glossary);
  } catch (err) {
    if (segments.length === 1 || err?.name === 'AiNotConfiguredError') throw err;
    const half = Math.ceil(segments.length / 2);
    return [
      ...await translateBatch(segments.slice(0, half), language, glossary),
      ...await translateBatch(segments.slice(half), language, glossary)
    ];
  }
}

/**
 * Texts in another language: from Redis, or translated now (in batches, so a
 * long article fits) and then stored under a hash of the texts
 * @param {string} name - part of the cache key, e.g. the page id
 * @param {string[]} segments - English Markdown texts
 * @param {string} language
 * @param {Object} terms - UI names of these texts with their translation
 * @returns {Promise<string[]|null>} null when they cannot be translated
 */
async function cachedTranslation(name, segments, language, terms) {
  const { chatModel } = await getAiConfig();
  const hash = crypto.createHash('sha256')
    // The UI names belong in the key: when the interface words change, the translation follows
    .update(JSON.stringify([ARTICLE_CACHE_VERSION, chatModel, language, segments, terms || {}]))
    .digest('hex')
    .slice(0, 24);
  const key = `help:translation:${language}:${name}:${hash}`;

  try {
    const cached = JSON.parse(await redis.get(key) || 'null');
    if (Array.isArray(cached) && cached.length === segments.length) return cached;
  } catch (err) {
    console.warn('[Help Service] Article cache unavailable:', err.message);
  }

  // Two makers opening the same article at once share one translation
  if (articleTranslationsInFlight.has(key)) return articleTranslationsInFlight.get(key);
  const work = (async () => {
    const glossary = { ...(loadUIGlossary(language) || {}), ...terms };
    const batches = [];
    let batch = [];
    let size = 0;
    for (const segment of segments) {
      if (batch.length && size + segment.length > ARTICLE_BATCH_CHARS) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(segment);
      size += segment.length;
    }
    if (batch.length) batches.push(batch);

    const results = [];
    for (const part of batches) results.push(...await translateBatch(part, language, glossary));
    try {
      await redis.set(key, JSON.stringify(results), 'EX', ARTICLE_TTL_SECONDS);
    } catch (err) {
      console.warn('[Help Service] Article translation not cached:', err.message);
    }
    return results;
  })();
  articleTranslationsInFlight.set(key, work);
  try {
    return await work;
  } catch (err) {
    console.error(`[Help Service] Translating ${name} into ${language} failed:`, err.message);
    return null;
  } finally {
    articleTranslationsInFlight.delete(key);
  }
}

/**
 * The segments of an article in another language
 * @returns {Promise<string[]|null>}
 */
function translatedSegments(doc, language) {
  const terms = termsFromDocs([doc], language);
  // UI names in bold or quotes get the label the maker sees before translating
  const segments = articleSegments(doc).map(segment => localizeUiNames(segment, terms));
  return cachedTranslation(doc.id, segments, language, terms);
}

/**
 * The titles of all help pages in a language (English when they cannot be
 * translated), translated together in one call and cached
 * @returns {Promise<Map<string, string>>} page id -> title
 */
async function helpTitles(language) {
  const docs = await getHelpDocs();
  const titles = new Map(docs.map(doc => [doc.id, doc.title]));
  if (language === 'en' || !LANGUAGE_NAMES[language] || !(await isAiConfigured())) return titles;
  // The titles get the UI names too, so "Floor Plans" becomes the word the maker sees
  const titleTerms = termsFromDocs(docs.map(doc => ({ content: `**${doc.title}**` })), language);
  const translated = await cachedTranslation('titles', docs.map(doc => doc.title), language, titleTerms);
  if (translated) docs.forEach((doc, i) => titles.set(doc.id, translated[i]));
  return titles;
}

/**
 * Page title in the maker's language, for the source and the related pages
 * of an answer
 * @returns {Promise<(id: string) => string>}
 */
export async function helpTitleLookup(language = 'en') {
  const titles = await helpTitles(language);
  return (id) => titles.get(id) || id;
}

/**
 * One help page as an article in the maker's language, with its screenshots
 * in that language when available. Without AI, or when translating fails,
 * the article is in English (translated: false).
 * @param {string} id - feature_id of the page
 * @param {string} language - Maker interface language
 * @returns {Promise<Object|null>} { id, title, link, blocks, related, translated } or null
 */
export async function getHelpArticle(id, language = 'en') {
  const docs = await getHelpDocs();
  const doc = docs.find(d => d.id === id);
  if (!doc) return null;
  const images = getHelpImages(doc, language);

  let translations = null;
  if (language !== 'en' && LANGUAGE_NAMES[language] && await isAiConfigured()) {
    translations = await translatedSegments(doc, language);
  }
  // Hand out the translated segments in the order of articleSegments()
  const segments = translations || articleSegments(doc);
  let next = 0;
  const take = () => segments[next++];
  const title = take();
  const blocks = doc.article.blocks.map(block => (block.type === 'image' ? block : { type: 'text', text: take() }));
  const legends = doc.images.map(image => image.legend.map(item => ({ number: item.number, text: take() })));

  // The same title as in the list of articles
  const titles = translations ? await helpTitles(language) : null;
  return {
    id: doc.id,
    title: titles?.get(doc.id) || title,
    link: doc.links[0] || null,
    translated: language === 'en' || !!translations,
    blocks: blocks.map(block => (block.type === 'image'
      ? { type: 'image', image: images[block.index], legend: legends[block.index] }
      : block)),
    related: doc.article.related
      .map(relatedId => docs.find(d => d.id === relatedId))
      .filter(Boolean)
      .map(d => ({ id: d.id, title: titles?.get(d.id) || d.title }))
  };
}

let prewarmRunning = false;
const PREWARM_PAUSE_MS = 1000;

/**
 * Translate all help articles and their titles into the other maker
 * languages ahead of time, so no maker waits for a translation. Runs in the
 * background after every start (so after every deploy); what is already in
 * the cache is skipped, so only new or changed pages cost an AI call. A page
 * that fails is translated when a maker opens it.
 */
export async function prewarmHelpTranslations() {
  if (prewarmRunning || !(await isAiConfigured())) return;
  prewarmRunning = true;
  const started = Date.now();
  let ready = 0;
  let failed = 0;
  try {
    const docs = await getHelpDocs();
    for (const language of Object.keys(LANGUAGE_NAMES).filter(code => code !== 'en')) {
      await helpTitles(language);
      for (const doc of docs) {
        const before = Date.now();
        if (await translatedSegments(doc, language)) ready++;
        else failed++;
        // A translation that took time was an AI call: leave room for makers
        if (Date.now() - before > 200) await new Promise(resolve => setTimeout(resolve, PREWARM_PAUSE_MS));
      }
    }
    console.log(`[Help Service] Article translations ready: ${ready}, failed: ${failed} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (err) {
    console.error('[Help Service] Prewarming translations failed:', err.message);
  } finally {
    prewarmRunning = false;
  }
}
