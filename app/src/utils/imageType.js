/**
 * Image type detection for uploads
 *
 * The mimetype and filename of an upload are chosen by the client, so they
 * cannot decide how a file is stored or served. These helpers read the real
 * format from the file content and derive the extension from that.
 */

import sharp from 'sharp';

// Formats accepted for image uploads (media library, floorplans, theme logos)
const IMAGE_FORMATS = {
  jpeg: { ext: '.jpg', mime: 'image/jpeg' },
  png: { ext: '.png', mime: 'image/png' },
  gif: { ext: '.gif', mime: 'image/gif' },
  webp: { ext: '.webp', mime: 'image/webp' }
};

/**
 * Detect the real image format of an uploaded buffer.
 * @param {Buffer} buffer - File content
 * @returns {Promise<{ext: string, mime: string}|null>} Format info, or null when
 *   the content is not a supported image
 */
export async function detectImageType(buffer) {
  if (!buffer || buffer.length === 0) return null;
  try {
    const { format } = await sharp(buffer).metadata();
    return IMAGE_FORMATS[format] || null;
  } catch {
    return null;
  }
}

// Extensions that are safe to show inline in the browser. Anything else is
// served as a download so uploaded HTML/SVG/XML can never run on our origin.
const INLINE_SAFE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.mp4', '.webm', '.mp3', '.wav'
]);

/**
 * Whether a stored file may be served inline (instead of as attachment).
 * @param {string} filePath - Path or filename of the stored file
 * @returns {boolean}
 */
export function isInlineSafeExtension(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return false;
  return INLINE_SAFE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}
