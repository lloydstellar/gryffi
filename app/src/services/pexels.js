/**
 * Pexels API Service for Gryffi
 * Provides image search and download functionality
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSetting } from './settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PEXELS_API_URL = 'https://api.pexels.com/v1';

// Base path for media storage
// This maps to data/uploads/organizations/ on the host via Docker volume
const MEDIA_BASE_PATH = path.join(__dirname, '../../uploads/organizations');

/**
 * Search photos on Pexels
 * @param {string} query - Search query
 * @param {number} perPage - Results per page (default 15, max 80)
 * @param {number} page - Page number
 * @param {Object} opts - Additional options
 * @param {string} opts.orientation - portrait | landscape | square
 * @returns {Promise<Object>} - Pexels search results
 */
export async function searchPhotos(query, perPage = 15, page = 1, opts = {}) {
  const apiKey = await getSetting('pexels.apiKey');
  if (!apiKey) {
    console.warn('Pexels API key not configured');
    return { photos: [], total_results: 0, error: 'API key not configured' };
  }

  try {
    let url = `${PEXELS_API_URL}/search?query=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`;
    if (opts.orientation) url += `&orientation=${opts.orientation}`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    let response;
    try {
      response = await fetch(url, {
        headers: {
          'Authorization': apiKey
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Pexels API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Transform to simpler format
    return {
      photos: data.photos.map(photo => ({
        id: photo.id,
        width: photo.width,
        height: photo.height,
        url: photo.url,
        photographer: photo.photographer,
        photographer_url: photo.photographer_url,
        alt: photo.alt || query,
        src: {
          original: photo.src.original,
          large: photo.src.large,      // 940px width
          medium: photo.src.medium,    // 350px height
          small: photo.src.small,      // 130px height
          thumbnail: photo.src.tiny    // 280px width, cropped
        }
      })),
      total_results: data.total_results,
      page: data.page,
      per_page: data.per_page,
      next_page: data.next_page
    };
  } catch (error) {
    console.error('Pexels search error:', error);
    return { photos: [], total_results: 0, error: error.message };
  }
}

/**
 * Get curated photos from Pexels (trending/popular)
 * @param {number} perPage - Results per page
 * @param {number} page - Page number
 * @returns {Promise<Object>} - Curated photos
 */
export async function getCuratedPhotos(perPage = 15, page = 1) {
  const apiKey = await getSetting('pexels.apiKey');
  if (!apiKey) {
    return { photos: [], error: 'API key not configured' };
  }

  try {
    const url = `${PEXELS_API_URL}/curated?per_page=${perPage}&page=${page}`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    let response;
    try {
      response = await fetch(url, {
        headers: {
          'Authorization': apiKey
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Pexels API error: ${response.status}`);
    }

    const data = await response.json();
    
    return {
      photos: data.photos.map(photo => ({
        id: photo.id,
        width: photo.width,
        height: photo.height,
        url: photo.url,
        photographer: photo.photographer,
        photographer_url: photo.photographer_url,
        alt: photo.alt || 'Curated photo',
        src: {
          original: photo.src.original,
          large: photo.src.large,
          medium: photo.src.medium,
          small: photo.src.small,
          thumbnail: photo.src.tiny
        }
      })),
      page: data.page,
      per_page: data.per_page
    };
  } catch (error) {
    console.error('Pexels curated error:', error);
    return { photos: [], error: error.message };
  }
}

// Sizes Pexels offers for a photo (keys of photo.src)
const PEXELS_SIZES = new Set(['original', 'large2x', 'large', 'medium', 'small', 'portrait', 'landscape', 'tiny']);
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20000;

/**
 * Download a photo from Pexels and save to organization's media folder.
 * Only the photo id is taken from the client. The image URL and credits come
 * from the Pexels API itself, and only images.pexels.com is ever fetched, so
 * this cannot be used to make the server fetch other (internal) URLs or to
 * write files outside the organization's folder.
 * @param {string} organizationId - Organization UUID
 * @param {Object} photo - Photo object from the client (only photo.id is used)
 * @param {string} size - Size to download (large, medium, small, ...)
 * @returns {Promise<Object>} - Saved file info
 */
export async function downloadPhoto(organizationId, photo, size = 'large') {
  const photoId = String(photo?.id ?? '');
  if (!organizationId || !/^\d{1,12}$/.test(photoId)) {
    throw new Error('Invalid parameters');
  }
  const apiKey = await getSetting('pexels.apiKey');
  if (!apiKey) {
    throw new Error('Pexels API key not configured');
  }

  const orgPexelsPath = path.join(MEDIA_BASE_PATH, organizationId, 'pexels');
  if (!fs.existsSync(orgPexelsPath)) {
    fs.mkdirSync(orgPexelsPath, { recursive: true });
  }

  const filename = `${photoId}.jpg`; // Pexels always serves JPEG
  const filepath = path.join(orgPexelsPath, filename);
  const url = `/uploads/organizations/${organizationId}/pexels/${filename}`;

  // Photo details from the Pexels API (also the trusted source for credits)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const apiResponse = await fetch(`${PEXELS_API_URL}/photos/${photoId}`, {
      headers: { 'Authorization': apiKey },
      signal: controller.signal
    });
    if (!apiResponse.ok) {
      throw new Error(`Pexels API error: ${apiResponse.status}`);
    }
    const details = await apiResponse.json();
    const info = {
      filename,
      filepath,
      url,
      source: 'pexels',
      pexels_id: photoId,
      photographer: details.photographer,
      photographer_url: details.photographer_url,
      alt: details.alt
    };

    if (fs.existsSync(filepath)) {
      return { ...info, cached: true };
    }

    const imageUrl = new URL(details.src?.[PEXELS_SIZES.has(size) ? size : 'large'] || details.src?.large);
    if (imageUrl.protocol !== 'https:' || imageUrl.hostname !== 'images.pexels.com') {
      throw new Error('Unexpected Pexels image host');
    }

    const imageResponse = await fetch(imageUrl, { signal: controller.signal });
    const finalHost = new URL(imageResponse.url).hostname;
    if (!imageResponse.ok || finalHost !== 'images.pexels.com') {
      throw new Error(`Pexels image download failed: ${imageResponse.status}`);
    }
    if (Number(imageResponse.headers.get('content-length') || 0) > MAX_DOWNLOAD_BYTES) {
      throw new Error('Pexels image too large');
    }

    // Read with a hard size limit, then write the complete file at once
    const chunks = [];
    let received = 0;
    for await (const chunk of imageResponse.body) {
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        throw new Error('Pexels image too large');
      }
      chunks.push(chunk);
    }
    const tempPath = `${filepath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tempPath, Buffer.concat(chunks));
    await fs.promises.rename(tempPath, filepath);

    return { ...info, cached: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ensure media directories exist for an organization
 * @param {string} organizationId - Organization UUID
 */
export function ensureMediaDirectories(organizationId) {
  const orgPath = path.join(MEDIA_BASE_PATH, organizationId);
  const mediaPath = path.join(orgPath, 'media');
  const pexelsPath = path.join(orgPath, 'pexels');

  if (!fs.existsSync(mediaPath)) {
    fs.mkdirSync(mediaPath, { recursive: true });
  }
  if (!fs.existsSync(pexelsPath)) {
    fs.mkdirSync(pexelsPath, { recursive: true });
  }

  return { orgPath, mediaPath, pexelsPath };
}

const STOP_WORDS = new Set([
  'step','new','the','and','for','een','het','van','voor','die','das','der','les','los','une','des','con',
  'stap','avec','avec','dans','sobre','alla','para','naar','avec','sont','avec'
]);

/**
 * Check whether a string contains non-ASCII letters (accents, umlauts, CJK, …)
 */
function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(text);
}

/**
 * Quick title-to-English translation using Mistral (3 s timeout).
 * Returns the original title if translation fails or is unavailable.
 */
async function translateTitleToEnglish(title) {
  try {
    const { translateText } = await import('./translation.js');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const translated = await Promise.race([
      translateText(title, 'en'),
      new Promise((_, rej) => controller.signal.addEventListener('abort', () => rej(new Error('timeout'))))
    ]);
    clearTimeout(timeout);
    return translated || title;
  } catch {
    return title;
  }
}

/**
 * Extract meaningful English keywords from a title.
 * Translates first when non-ASCII characters are detected.
 */
async function extractKeywords(title) {
  if (!title || title.length < 3) return [];
  let text = title;
  if (hasNonAscii(text)) {
    text = await translateTitleToEnglish(text);
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Build contextual Pexels search queries based on step type and title.
 * Returns { terms: string[], orientation?: string }
 */
export async function getSuggestedSearchTerms(stepType, stepTitle) {
  const keywords = await extractKeywords(stepTitle);

  if (stepType === 'avatar' || stepType === 'guide') {
    const portraitTerms = [
      'friendly person face portrait',
      'professional woman headshot smiling',
      'professional man headshot smiling',
      'diverse team member portrait',
      'business woman close up face',
      'business man close up face'
    ];
    return { terms: portraitTerms, orientation: 'portrait' };
  }

  if (stepType === 'space') {
    const locationFallbacks = [
      'modern office interior',
      'corporate lobby reception',
      'meeting room interior',
      'coworking space',
      'office hallway',
      'company building entrance'
    ];
    if (keywords.length > 0) {
      const kw = keywords.slice(0, 3).join(' ');
      return {
        terms: [`${kw} interior room`, `${kw} office`, ...locationFallbacks.slice(0, 4)],
        orientation: 'landscape'
      };
    }
    return { terms: locationFallbacks, orientation: 'landscape' };
  }

  const typeFallbacks = {
    content:   ['business teamwork', 'people learning', 'presentation meeting', 'knowledge sharing'],
    challenge: ['quiz competition', 'thinking lightbulb', 'achievement trophy', 'exam test'],
    form:      ['survey checklist', 'feedback form', 'business document writing'],
    poll:      ['voting opinion', 'survey feedback', 'people discussion'],
    reward:    ['celebration reward', 'trophy achievement', 'gift certificate', 'congratulations']
  };
  const fallbacks = typeFallbacks[stepType] || typeFallbacks.content;

  if (keywords.length > 0) {
    const kw = keywords.slice(0, 3).join(' ');
    return { terms: [kw, `${kw} business`, ...fallbacks.slice(0, 4)] };
  }
  return { terms: fallbacks };
}

/**
 * Legacy synchronous version — only used as fallback
 * @deprecated Use getSuggestedSearchTerms (async) instead
 */
export function getSuggestedSearchTermsSync(stepType, _stepTitle) {
  const baseTerms = {
    space: ['modern office interior', 'meeting room', 'corporate lobby', 'workspace', 'office reception'],
    guide: ['friendly person face portrait', 'professional headshot smiling', 'business person portrait'],
    avatar: ['friendly person face portrait', 'professional woman headshot', 'professional man headshot'],
    content: ['business teamwork', 'presentation meeting', 'learning knowledge'],
    challenge: ['quiz competition', 'thinking lightbulb', 'achievement trophy']
  };
  return baseTerms[stepType] || baseTerms.content;
}

export default {
  searchPhotos,
  getCuratedPhotos,
  downloadPhoto,
  ensureMediaDirectories,
  getSuggestedSearchTerms,
  getSuggestedSearchTermsSync
};
