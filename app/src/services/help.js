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
      glossary['Journey Builder'] = localeData.builder.title || 'Journey Builder';
      glossary['Builder'] = localeData.builder.title || 'Builder';
    }
    
    // End user terms
    if (localeData.systemSettings?.users || localeData.dashboard?.stats) {
      glossary['End User'] = localeData.systemSettings?.users?.title?.replace(/s$/, '') || 'End User';
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
      glossary['Knowledge Base'] = localeData.guides.knowledgeBase?.title || 'Knowledge Base';
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
      glossary['Current Plan'] = localeData.subscription.currentPlan?.title || 'Current Plan';
    }
    
    // Settings terms
    if (localeData.settings) {
      glossary['Two-Factor Authentication'] = localeData.settings.twoFactor?.title || 'Two-Factor Authentication';
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
      glossary['Send Invitation'] = localeData.invitations.sendInvitation || 'Send Invitation';
    }
    
    // Knowledge base
    if (localeData.guides?.knowledgeBase) {
      glossary['Knowledge Base'] = localeData.guides.knowledgeBase.title || 'Knowledge Base';
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
 * Format glossary as a string for the AI prompt
 */
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
      const { frontmatter, body } = parseFrontmatter(content);
      const { links } = extractTags(body);
      const keywords = extractKeywords(body);

      // Get feature ID from frontmatter or filename
      const featureId = frontmatter.feature_id || file.replace('.md', '');

      docs.push({
        id: featureId,
        filename: file,
        title: extractTitle(body),
        frontmatter,
        content: body,
        links,
        keywords,
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
export async function initHelpCache() {
  helpDocsCache = await loadHelpDocuments();
  lastCacheUpdate = new Date();
  return helpDocsCache.length;
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
const SYNONYMS = {
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
  share: ['publish', 'invite', 'send'],
  publish: ['share', 'release', 'deploy'],
  user: ['enduser', 'participant', 'member'],
  sync: ['synchronize', 'connect', 'integrate'],
  import: ['upload', 'add', 'load'],
  export: ['download', 'save'],
  help: ['guide', 'assistant', 'support'],
  question: ['quiz', 'challenge', 'form'],
};

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

/**
 * Search help documents by query
 * @param {string} query - User's search query
 * @param {string} context - Current UI context (e.g., 'builder', 'settings')
 * @param {number} limit - Maximum results to return
 * @returns {Promise<Array>} - Matching documents
 */
export async function searchHelp(query, context = '', limit = 5) {
  const docs = await getHelpDocs();
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.match(/\b[a-z]{2,}\b/g) || [];
  const expandedWords = expandWithSynonyms(queryWords);
  
  console.log('[Help Search] Query:', query, '| Words:', queryWords, '| Expanded:', expandedWords);
  
  // Score each document
  const scored = docs.map(doc => {
    let score = 0;
    const titleLower = doc.title.toLowerCase();
    const idLower = doc.id.toLowerCase();
    
    // Title match (highest weight)
    if (titleLower.includes(queryLower)) {
      score += 100;
    }
    
    // Title word matches
    for (const word of expandedWords) {
      if (titleLower.includes(word)) {
        score += 40;
      }
    }
    
    // Feature ID match
    for (const word of expandedWords) {
      if (idLower.includes(word)) {
        score += 30;
      }
    }
    
    // Context boost - prioritize docs related to current UI section
    if (context) {
      const contextLower = context.toLowerCase();
      if (idLower.includes(contextLower) || doc.keywords.includes(contextLower)) {
        score += 50;
      }
    }
    
    // Keyword matches (using expanded words with synonyms)
    for (const word of expandedWords) {
      if (doc.keywords.includes(word)) {
        score += 15;
      }
      // Partial keyword match
      if (doc.keywords.some(k => k.includes(word) || word.includes(k))) {
        score += 8;
      }
    }
    
    // Content match (lower weight for full-text)
    for (const word of queryWords) {
      if (doc.content.toLowerCase().includes(word)) {
        score += 5;
      }
    }
    
    // Related features boost
    if (doc.relatedFeatures.some(r => expandedWords.some(w => r.includes(w)))) {
      score += 20;
    }
    
    return { ...doc, score };
  });
  
  // Sort by score and return top results
  const results = scored
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  console.log('[Help Search] Top results:', results.map(r => ({ id: r.id, score: r.score })));
  
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
  
  // Build context from relevant docs
  const docsContext = relevantDocs.map(doc => `
=== ${doc.title} (${doc.id}) ===
${doc.content.substring(0, 2000)}
`).join('\n\n');

  // Load UI glossary for the target language
  const glossary = language !== 'en' ? loadUIGlossary(language) : null;
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
  
  const systemPrompt = `You are the Gryffi Help Assistant, helping users understand and use the Gryffi platform.

CRITICAL RULES - YOU MUST FOLLOW THESE:
1. Answer ONLY based on the provided documentation below - NEVER make up or invent information
2. If the answer is NOT explicitly in the documentation, you MUST say that you don't have information about this topic in the help documentation
3. Do NOT guess, assume, or extrapolate beyond what is written in the docs
4. If unsure, always err on the side of saying "I don't have specific information about this"
5. RESPOND IN ${languageName.toUpperCase()} - translate from English docs as needed
6. When referring to UI elements (buttons, menus, settings), use the EXACT translations from the UI TERMINOLOGY section below
${glossarySection}${makerContextSection}
CURRENT CONTEXT:
The user is currently in the "${context || 'dashboard'}" section of Gryffi.

DOCUMENTATION (ONLY use information from this section):
${docsContext}

RESPONSE FORMAT:
- Start with a brief intro sentence
- For "how to" questions: use numbered steps (1. 2. 3. etc.)
- Keep each step clear and actionable
- NEVER include URLs, links, paths, or [[goto:...]] / [[show:...]] tags
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
  searchHelp,
  generateHelpResponse,
  getHelpTopics
};
