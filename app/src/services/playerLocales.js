/**
 * Player Locales Service
 * Loads player-specific translations for the journey player interface.
 * These translations support additional languages beyond the 5 base languages.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLAYER_LOCALES_PATH = path.join(__dirname, '../../player-locales');

const localeCache = new Map();

const SUPPORTED_PLAYER_LANGUAGES = [
  'en', 'nl', 'de', 'fr', 'es',
  'it', 'pt', 'da', 'no', 'fi', 'sv', 'pl', 'ro', 'tr'
];

/**
 * Load player locale for a given language code
 * @param {string} lang - Language code (e.g., 'en', 'nl', 'it')
 * @returns {Object} - Player translations object
 */
export function getPlayerLocale(lang) {
  if (!SUPPORTED_PLAYER_LANGUAGES.includes(lang)) {
    lang = 'en';
  }
  
  if (localeCache.has(lang)) {
    return localeCache.get(lang);
  }
  
  try {
    const localePath = path.join(PLAYER_LOCALES_PATH, `${lang}.json`);
    const content = fs.readFileSync(localePath, 'utf8');
    const locale = JSON.parse(content);
    localeCache.set(lang, locale);
    return locale;
  } catch (err) {
    console.warn(`Failed to load player locale for ${lang}, falling back to English:`, err.message);
    if (lang !== 'en') {
      return getPlayerLocale('en');
    }
    return { player: {} };
  }
}

/**
 * Translate function for server-rendered pages that end users see, such as
 * the pages of a magic link. Keys are relative to player.*, {{name}} is
 * filled in, a missing key falls back to English.
 * @param {string} lang - Player language code
 * @returns {(key: string, vars?: object) => string}
 */
export function getPlayerT(lang) {
  const lookup = (locale, key) => key.split('.').reduce((node, part) => node?.[part], locale?.player);
  const locale = getPlayerLocale(lang);
  return (key, vars = {}) => {
    const text = lookup(locale, key) ?? lookup(getPlayerLocale('en'), key) ?? key;
    return String(text).replace(/\{\{(\w+)\}\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? '') : match);
  };
}

/**
 * Preload all player locales into cache
 */
export function preloadPlayerLocales() {
  for (const lang of SUPPORTED_PLAYER_LANGUAGES) {
    try {
      getPlayerLocale(lang);
    } catch (err) {
      console.warn(`Failed to preload player locale ${lang}:`, err.message);
    }
  }
  console.log(`Preloaded ${localeCache.size} player locales`);
}

export { SUPPORTED_PLAYER_LANGUAGES };
