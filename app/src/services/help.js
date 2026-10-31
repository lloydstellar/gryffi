/**
 * Help Service - Gryffi AI Help Assistant
 * Server-side RAG implementation for help documentation
 *
 * This service:
 * - Loads and indexes all help markdown files at startup
 * - Provides semantic search across help documentation
 * - Generates AI responses using Mistral with context from docs
 * - Returns navigation links to relevant parts of the app
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { aiFetch, getAiConfig, isAiConfigured } from './aiProvider.js';

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
      glossary['Add End User'] = localeData.dashboard.actions.addEndUser || 'Add End User';
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
    
    // End user terms
    if (localeData.systemSettings?.users || localeData.dashboard?.stats) {
      glossary['End User'] = localeData.systemSettings?.users?.title?.replace(/s$/, '') || localeData.builder?.automations?.variableCategories?.endUser || 'End User';
      glossary['End Users'] = localeData.systemSettings?.users?.title || localeData.dashboard?.stats?.endUsers || 'End Users';
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
      glossary['Users tab'] = localeData.systemSettings.tabs?.users || 'Users';
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
      const translated = index.get(term.toLowerCase());
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
 * Screenshot URLs of a help page for a language, falling back to English
 * @param {Object} doc - Help document
 * @param {string} language - Maker interface language
 * @returns {Array<{src: string, alt: string, markers: Object}>}
 */
export function getHelpImages(doc, language = 'en') {
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
        relatedFeatures: frontmatter.related_features || []
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

/**
 * One help page by its id, or null
 */
export async function getHelpDoc(id) {
  return (await getHelpDocs()).find(doc => doc.id === id) || null;
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
// about "participants" or a "course" must still find "end users" and
// "journeys". Gryffi's own names in the five maker languages are included,
// so that search works a little in those languages too.
const TERM_GROUPS = [
  [['participant', 'participants', 'employee', 'employees', 'staff', 'people', 'learner', 'learners', 'trainee', 'trainees',
    'student', 'students', 'hire', 'hires', 'newcomer', 'newcomers', 'worker', 'workers', 'enduser', 'endusers',
    'deelnemer', 'deelnemers', 'medewerker', 'medewerkers', 'eindgebruiker', 'eindgebruikers', 'teilnehmer', 'mitarbeiter',
    'participante', 'participantes', 'empleado', 'empleados'], ['end', 'user', 'users']],
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
function lexicalScore(doc, queryLower, expandedWords, context, idf) {
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
  return score;
}

/**
 * The help pages are in English and the embedding model matches English best,
 * so a question from a maker who uses another language is translated first.
 * Returns the question unchanged when that is not possible.
 */
async function toEnglish(query, language) {
  const term = getJourneyTerm(language);
  const termNote = term ? ` In this software, "${term.singular}" and "${term.plural}" mean journey and journeys.` : '';
  // One retry: a failed translation falls back to the weaker search
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { chatModel } = await getAiConfig();
      const response = await aiFetch('/chat/completions', {
        body: JSON.stringify({
          model: chatModel,
          messages: [
            { role: 'system', content: `Translate the question into English. Reply with the translated question only. Do not add or explain anything.${termNote}` },
            { role: 'user', content: query.slice(0, 500) }
          ],
          temperature: 0,
          max_tokens: 80
        })
      });
      if (response.ok) {
        const data = await response.json();
        const translated = data.choices?.[0]?.message?.content?.trim();
        if (translated) return translated;
      }
    } catch {
      // try again, then give up
    }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400));
  }
  return query;
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
export async function searchHelp(query, context = '', limit = 5, { language = 'en' } = {}) {
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
  const lexical = docs.map(doc => lexicalScore(doc, queryLower, expandedWords, context, idf));
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

  console.log('[Help Search]', semantic ? 'hybrid' : 'words only', '|', query, searchQuery !== query ? `(${searchQuery})` : '', '|', results.map(r => `${r.id} ${r.score}`).join(', '));
  return results;
}

/**
 * Generate AI response for help query
 * @param {string} query - User's question
 * @param {Array} relevantDocs - Relevant documentation
 * @param {string} context - Current UI context
 * @param {string} language - Response language
 * @param {Object} makerContext - Information about the maker asking the question
 * @returns {Promise<Object>} - AI response with answer, link, source
 */
export async function generateHelpResponse(query, relevantDocs, context, language = 'en', makerContext = null) {
  if (!(await isAiConfigured())) {
    console.warn('[Help Service] No AI provider configured');
    return {
      answer: getStaticFallback(query, relevantDocs, language),
      link: relevantDocs[0]?.links[0] || null,
      source: relevantDocs[0]?.id || null
    };
  }

  const { chatModel } = await getAiConfig();
  
  const languageName = LANGUAGE_NAMES[language] || 'English';
  
  // The screenshots of the first document are shown below the answer
  const shownScreenshots = relevantDocs[0]?.images?.length
    ? `
SCREENSHOTS SHOWN BELOW YOUR ANSWER (from "${relevantDocs[0].title}"), with numbered markers:
${relevantDocs[0].images.map(img => img.legend.map(item => `(${item.number}) = ${item.text}`).join('\n')).join('\n')}
In the documentation of "${relevantDocs[0].title}", a number in brackets such as (3) points at that marker. When a step of your answer is about one of these elements, put its number in brackets right after the element, exactly like the documentation, for example "Click Save (5)". Use only the numbers listed above, and only for the element they belong to.
`
    : '';

  // The UI names in these help pages, with the labels the maker sees
  const docTerms = language !== 'en' ? termsFromDocs(relevantDocs, language) : {};

  // Build context from relevant docs; only the first one, whose screenshots
  // are shown, keeps its screenshot legends. A long page does not fit: it
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
  if (glossary) {
    console.log(`[Help Service] Using UI glossary for ${language} with ${Object.keys(glossary).length} terms`);
  }
  const glossarySection = glossary ? `
UI TERMINOLOGY (use these exact translations for UI elements):
${formatGlossaryForPrompt(glossary)}
` : '';

  // Build maker context section for personalized responses
  let makerContextSection = '';
  if (makerContext) {
    const parts = [];
    if (makerContext.name) {
      parts.push(`- Maker name: ${makerContext.name}`);
    }
    if (makerContext.role) {
      const roleNames = {
        admin: 'Admin (full access)',
        manager: 'Manager (can manage journeys and users)',
        creator: 'Creator (can create journeys)',
        viewer: 'Viewer (read-only access)'
      };
      parts.push(`- Maker role: ${roleNames[makerContext.role] || makerContext.role}`);
    }
    if (makerContext.organization?.name) {
      parts.push(`- Organization: ${makerContext.organization.name}`);
    }
    if (makerContext.organization?.country) {
      parts.push(`- Country: ${makerContext.organization.country}`);
    }
    if (makerContext.organization?.tier) {
      const tierName = makerContext.organization.tier.displayName || makerContext.organization.tier.name;
      parts.push(`- Current subscription plan: ${tierName}`);
    }
    
    if (parts.length > 0) {
      makerContextSection = `
MAKER & ORGANIZATION CONTEXT:
${parts.join('\n')}

Use this information to give personalized answers. For example:
- If a feature requires a higher tier plan than what the organization has, mention they would need to upgrade
- If the maker has a viewer role and asks about creating content, mention they need elevated permissions
- Reference the organization name when appropriate to make the response more personal
`;
    }
  }
  
  // Gryffi's own word for "journey" in this language (expeditie, Expedition, ...)
  const journeyTerm = getJourneyTerm(language);
  const journeyRule = journeyTerm
    ? `\n7. In ${languageName}, Gryffi calls a journey "${journeyTerm.singular}" (plural "${journeyTerm.plural}"). Always use that word for journey and journeys, also when the documentation says "journey". Only keep "journey" when it is part of an exact UI name from the UI TERMINOLOGY section.`
    : '';

  const systemPrompt = `You are the Gryffi Help Assistant, helping users understand and use the Gryffi platform.

CRITICAL RULES - YOU MUST FOLLOW THESE:
1. Answer ONLY based on the provided documentation below - NEVER make up or invent information
2. If the answer is NOT explicitly in the documentation, you MUST say that you don't have information about this topic in the help documentation
3. Do NOT guess, assume, or extrapolate beyond what is written in the docs
4. If unsure, always err on the side of saying "I don't have specific information about this"
5. RESPOND IN ${languageName.toUpperCase()} - translate from English docs as needed
6. When referring to UI elements (buttons, menus, settings), use the EXACT translations from the UI TERMINOLOGY section below. The maker sees the interface in ${languageName}: write only the translated name, never the English one, not even in brackets${journeyRule}
${glossarySection}${makerContextSection}
CURRENT CONTEXT:
The user is currently in the "${context || 'dashboard'}" section of Gryffi.

DOCUMENTATION (ONLY use information from this section):
${docsContext}
${shownScreenshots}
RESPONSE FORMAT:
- Start with a brief intro sentence
- For "how to" questions: use numbered steps (1. 2. 3. etc.)
- Keep each step clear and actionable
- NEVER include URLs, links, paths, or [[goto:...]] / [[show:...]] tags
- NEVER include images, image syntax or "[Screenshot: ...]" notes: the screenshots are shown below your answer
- NEVER mention specific page URLs like /dashboard/... or /settings/...
- Just describe the action using the translated UI terms (e.g. "Ga naar Instellingen" not "Go to Settings")
- Be helpful and friendly
- Use simple language suitable for non-technical users
- Maximum 4-6 steps for instructions
- If the documentation does not contain the answer, respond with a message like "This topic is not yet covered in the help documentation. Please contact support for assistance."`;

  try {
    const response = await aiFetch('/chat/completions', {
      body: JSON.stringify({
        model: chatModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ],
        temperature: 0.3, // Lower for more factual responses
        max_tokens: 300
      })
    });
    
    if (!response.ok) {
      console.error('[Help Service] Mistral API error:', response.status);
      throw new Error('API error');
    }
    
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || '';

    // Only use the link from the TOP matching document so we never point the
    // maker to an unrelated part of the app.
    let link = null;
    let source = null;
    if (relevantDocs.length > 0) {
      const topDoc = relevantDocs[0];
      source = topDoc.id;
      if (topDoc.links.length > 0) {
        link = topDoc.links[0];
      }
    }

    return { answer, link, source };

  } catch (error) {
    console.error('[Help Service] AI generation error:', error.message);
    const topDoc = relevantDocs[0];
    return {
      answer: getStaticFallback(query, relevantDocs, language),
      link: topDoc?.links[0] || null,
      source: topDoc?.id || null
    };
  }
}

/**
 * Static fallback when AI is unavailable
 */
function getStaticFallback(query, docs, language) {
  if (docs.length === 0) {
    const messages = {
      en: "I couldn't find specific information about that. Try browsing the help topics or contact support.",
      nl: "Ik kon geen specifieke informatie hierover vinden. Probeer de hulponderwerpen te bekijken of neem contact op met support.",
      de: "Ich konnte keine spezifischen Informationen dazu finden. Versuchen Sie, die Hilfethemen zu durchsuchen oder kontaktieren Sie den Support.",
      fr: "Je n'ai pas trouvé d'informations spécifiques à ce sujet. Essayez de parcourir les rubriques d'aide ou contactez le support.",
      es: "No pude encontrar información específica sobre eso. Intente explorar los temas de ayuda o contacte con soporte."
    };
    return messages[language] || messages.en;
  }
  
  // Return excerpt from best matching doc
  const topDoc = docs[0];
  const excerpt = topDoc.content
    .replace(/^---[\s\S]*?---\n/, '') // Remove frontmatter
    .replace(/\[\[.*?\]\]/g, '') // Remove tags
    .replace(/^#+\s+.+$/gm, '') // Remove headings
    .replace(/\|.*?\|/g, '') // Remove tables
    .trim()
    .substring(0, 300);
  
  return excerpt + '...';
}

/**
 * Get list of all help topics for browse mode
 */
export async function getHelpTopics() {
  const docs = await getHelpDocs();

  return docs.map(doc => ({
    id: doc.id,
    title: doc.title
  })).sort((a, b) => a.title.localeCompare(b.title));
}

export default {
  initHelpCache,
  getHelpDoc,
  searchHelp,
  generateHelpResponse,
  getHelpTopics,
  getHelpImages
};
