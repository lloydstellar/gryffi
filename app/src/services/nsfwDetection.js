/**
 * NSFW Detection Service
 * Checks images for inappropriate content using NudeNet
 * Integrated with the Gryffi upload system
 */

import fs from 'fs';
import { getSetting } from './settings.js';

const NUDENET_URL = process.env.NUDENET_URL || 'http://gryffi-nudenet:8002';
const DETECT_ENDPOINT = `${NUDENET_URL}/detect`;
const HEALTH_ENDPOINT = `${NUDENET_URL}/health`;

// Request timeout (ms)
const REQUEST_TIMEOUT = 30000;

/**
 * Get MIME type from filename extension
 * @param {string} filename
 * @returns {string}
 */
function getMimeType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp'
  };
  return mimeTypes[ext] || 'image/jpeg';
}

/**
 * Check if NudeNet service is available
 * @returns {Promise<boolean>}
 */
export async function isServiceAvailable() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(HEALTH_ENDPOINT, {
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (response.ok) {
      const data = await response.json();
      return data.status === 'healthy' && data.model_loaded === true;
    }
    return false;
  } catch (err) {
    console.warn('[NSFW] NudeNet service not available:', err.message);
    return false;
  }
}

/**
 * Check an image buffer for NSFW content
 * @param {Buffer} imageBuffer - Image file buffer
 * @param {string} filename - Original filename
 * @returns {Promise<{isNsfw: boolean, score: number, reason: string|null, detections: Array}>}
 */
export async function checkImage(imageBuffer, filename = 'image.jpg') {
  try {
    // Create native FormData with Blob (works correctly with native fetch)
    const formData = new FormData();
    const mimeType = getMimeType(filename);
    const blob = new Blob([imageBuffer], { type: mimeType });
    formData.append('file', blob, filename);
    
    // Make request with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    
    const response = await fetch(DETECT_ENDPOINT, {
      method: 'POST',
      body: formData,
      signal: controller.signal
      // Note: Don't set Content-Type header manually - fetch sets it with correct boundary
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[NSFW] Detection API error:', response.status, errorText);
      // Reported through `error`; isImageAllowed() refuses the image then
      return {
        isNsfw: false,
        score: 0,
        reason: null,
        detections: [],
        error: `API error: ${response.status}`
      };
    }
    
    const result = await response.json();
    
    console.log(`[NSFW] Check result for ${filename}: isNsfw=${result.is_nsfw}, score=${result.score}`);
    
    return {
      isNsfw: result.is_nsfw,
      score: result.score,
      reason: result.reason,
      detections: result.detections || []
    };
    
  } catch (err) {
    console.error('[NSFW] Detection error:', err.message);
    // Reported through `error`; isImageAllowed() refuses the image then
    return {
      isNsfw: false,
      score: 0,
      reason: null,
      detections: [],
      error: err.message
    };
  }
}

/**
 * Decide whether an image may be stored. Fails closed: when the check cannot
 * run (service down, error, timeout) the image is refused, so nothing that
 * was not checked ends up on the server.
 * @param {Buffer} imageBuffer - Image file buffer
 * @param {string} filename - Filename (extension is used for the mime type)
 * @returns {Promise<{allowed: boolean, reason: 'nsfw'|'unavailable'|null}>}
 */
export async function isImageAllowed(imageBuffer, filename = 'image.jpg') {
  // The administrator can switch the check off (nsfw.enabled); then every image passes
  if (!(await getSetting('nsfw.enabled'))) {
    return { allowed: true, reason: null };
  }
  const result = await checkImage(imageBuffer, filename);
  if (result.error) {
    console.warn('[NSFW] Check could not run, image refused:', result.error);
    return { allowed: false, reason: 'unavailable' };
  }
  if (result.isNsfw) {
    return { allowed: false, reason: 'nsfw' };
  }
  return { allowed: true, reason: null };
}

/**
 * Check an image file path for NSFW content
 * @param {string} filePath - Path to image file
 * @returns {Promise<{isNsfw: boolean, score: number, reason: string|null, detections: Array}>}
 */
export async function checkImageFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const filename = filePath.split('/').pop();
    return checkImage(buffer, filename);
  } catch (err) {
    console.error('[NSFW] Failed to read file:', err.message);
    return {
      isNsfw: false,
      score: 0,
      reason: null,
      detections: [],
      error: err.message
    };
  }
}

/**
 * Get human-readable NSFW reason for user display
 * Maps technical detection classes to user-friendly messages
 * @param {string} reason - Technical reason from NudeNet
 * @param {string} locale - User locale (en, nl, de, fr, es)
 * @returns {string} - User-friendly message
 */
export function getUserFriendlyReason(reason, locale = 'en') {
  // We use a generic message regardless of technical reason
  // to keep the UI family-friendly
  const messages = {
    en: 'This image appears to contain inappropriate content and cannot be uploaded.',
    nl: 'Deze afbeelding lijkt ongepaste inhoud te bevatten en kan niet worden geüpload.',
    de: 'Dieses Bild scheint unangemessene Inhalte zu enthalten und kann nicht hochgeladen werden.',
    fr: 'Cette image semble contenir du contenu inapproprié et ne peut pas être téléchargée.',
    es: 'Esta imagen parece contener contenido inapropiado y no se puede cargar.'
  };
  
  return messages[locale] || messages.en;
}

export default {
  isServiceAvailable,
  checkImage,
  isImageAllowed,
  checkImageFile,
  getUserFriendlyReason
};
