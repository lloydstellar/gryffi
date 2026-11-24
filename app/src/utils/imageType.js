/**
 * File type detection for uploads
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

// Signatures of the non-image formats accepted as form attachments
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const OLE_WORD_STREAM = Buffer.from('WordDocument', 'utf16le');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const DOCX_MAIN_PART = Buffer.from('word/document.xml', 'latin1');

const DOCUMENT_FORMATS = {
  pdf: { ext: '.pdf', mime: 'application/pdf' },
  doc: { ext: '.doc', mime: 'application/msword' },
  docx: { ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  txt: { ext: '.txt', mime: 'text/plain' },
  mp3: { ext: '.mp3', mime: 'audio/mpeg' }
};

/**
 * Plain text: no control characters other than tab, newline, form feed and
 * carriage return. Bytes above 0x7f are allowed (UTF-8 or a legacy encoding).
 */
function isPlainText(buffer) {
  for (const byte of buffer) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) return false;
    if (byte === 0x7f) return false;
  }
  return true;
}

/**
 * MP3: an ID3 tag, or an MPEG audio frame header (11 sync bits, layer III).
 */
function isMp3(buffer) {
  if (buffer.length < 4) return false;
  if (buffer.subarray(0, 3).toString('latin1') === 'ID3') return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x06) === 0x02;
}

/**
 * Detect the real format of an uploaded file: the image formats of
 * detectImageType plus PDF, Word (.doc/.docx), plain text and MP3.
 * @param {Buffer} buffer - File content
 * @returns {Promise<{ext: string, mime: string}|null>} Format info, or null when
 *   the content is none of the supported formats
 */
export async function detectFileType(buffer) {
  if (!buffer || buffer.length === 0) return null;
  // Images first: anything sharp can decode is treated as an image, so it
  // always gets the NSFW check, whatever else the file claims to be.
  const image = await detectImageType(buffer);
  if (image) return image;
  if (buffer.subarray(0, 1024).indexOf(PDF_MAGIC) !== -1) return DOCUMENT_FORMATS.pdf;
  if (buffer.subarray(0, 8).equals(OLE_MAGIC)) {
    return buffer.indexOf(OLE_WORD_STREAM) !== -1 ? DOCUMENT_FORMATS.doc : null;
  }
  if (buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    return buffer.indexOf(DOCX_MAIN_PART) !== -1 ? DOCUMENT_FORMATS.docx : null;
  }
  if (isMp3(buffer)) return DOCUMENT_FORMATS.mp3;
  if (isPlainText(buffer)) return DOCUMENT_FORMATS.txt;
  return null;
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
