/**
 * Image Analysis Service
 * Provides AI-generated descriptions of images and videos for Step Assistants
 * Uses Mistral's vision capabilities and YouTube API for video metadata
 * Includes NSFW detection and automatic removal of inappropriate content
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/index.js';
import { aiFetch, getAiConfig, isAiConfigured } from './aiProvider.js';
import { getSetting } from './settings.js';
import { checkImageFile } from './nsfwDetection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// NSFW detection. The analysis prompt asks the model to answer with this
// marker for nudity or sexual content. A refusal at the start of the answer
// counts too. Words elsewhere in a description do not: a slide with the text
// "no explicit content" is a normal image. The model's verdict alone never
// removes an image: NudeNet has to agree (isNsfwConfirmed).
const NSFW_MARKER = 'NSFW_CONTENT';
const NSFW_REFUSAL_PREFIXES = [
  'i cannot describe', 'i cannot analyze', 'i cannot analyse', 'i cannot process',
  "i can't describe", "i can't analyze", "i can't analyse", "i can't process",
  'i am unable to', "i'm unable to", 'i am not able to', "i'm not able to", 'i must refuse'
];


/**
 * Generate SHA256 hash of a URL for caching/deduplication
 */
function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

// Maximum dimensions for images sent to Mistral Vision API
const MAX_IMAGE_WIDTH = 2048;
const MAX_IMAGE_HEIGHT = 2048;
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB max for base64 payload

/**
 * Resize an image buffer if it exceeds maximum dimensions or file size
 * Uses sharp for efficient image processing
 */
async function resizeImageIfNeeded(buffer, _imageUrl) {
  try {
    const sharp = (await import('sharp')).default;
    
    // Get image metadata
    const metadata = await sharp(buffer).metadata();
    const originalSize = buffer.length;
    
    console.log(`[ImageAnalysis] Original: ${metadata.width}x${metadata.height}, ${(originalSize / 1024 / 1024).toFixed(2)}MB`);
    
    // Check if resize is needed
    const needsResize = 
      metadata.width > MAX_IMAGE_WIDTH || 
      metadata.height > MAX_IMAGE_HEIGHT ||
      originalSize > MAX_IMAGE_SIZE_BYTES;
    
    if (!needsResize) {
      console.log('[ImageAnalysis] Image size OK, no resize needed');
      return buffer;
    }
    
    console.log('[ImageAnalysis] Resizing large image for API...');
    
    // Calculate new dimensions maintaining aspect ratio
    let newWidth = metadata.width;
    let newHeight = metadata.height;
    
    if (metadata.width > MAX_IMAGE_WIDTH) {
      newWidth = MAX_IMAGE_WIDTH;
      newHeight = Math.round(metadata.height * (MAX_IMAGE_WIDTH / metadata.width));
    }
    
    if (newHeight > MAX_IMAGE_HEIGHT) {
      newHeight = MAX_IMAGE_HEIGHT;
      newWidth = Math.round(newWidth * (MAX_IMAGE_HEIGHT / newHeight));
    }
    
    // For 360-degree panoramas (very wide), extract center portion
    // These typically have aspect ratio > 3:1
    const aspectRatio = metadata.width / metadata.height;
    if (aspectRatio > 3) {
      console.log('[ImageAnalysis] Detected panorama (aspect ratio:', aspectRatio.toFixed(2) + '), extracting multiple regions...');
      
      // For panoramas, extract 3 sections and create a composite description
      // We'll use the center section for the main analysis
      const sectionWidth = Math.min(metadata.width / 3, MAX_IMAGE_WIDTH);
      const centerX = Math.round((metadata.width - sectionWidth) / 2);
      
      const resizedBuffer = await sharp(buffer)
        .extract({
          left: centerX,
          top: 0,
          width: Math.round(sectionWidth),
          height: metadata.height
        })
        .resize(Math.min(Math.round(sectionWidth), MAX_IMAGE_WIDTH), null, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();
      
      console.log(`[ImageAnalysis] Extracted panorama center: ${resizedBuffer.length / 1024}KB`);
      return resizedBuffer;
    }
    
    // Standard resize for non-panorama images
    const resizedBuffer = await sharp(buffer)
      .resize(newWidth, newHeight, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    
    console.log(`[ImageAnalysis] Resized to ${newWidth}x${newHeight}, ${(resizedBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    
    return resizedBuffer;
    
  } catch (error) {
    console.error('[ImageAnalysis] Resize failed, using original:', error.message);
    return buffer;
  }
}

/**
 * Validate that an external URL is safe to fetch (SSRF protection).
 * Blocks private/internal IP ranges, metadata endpoints, and non-HTTPS URLs.
 */
function isUrlSafeToFetch(urlString) {
  try {
    const parsed = new URL(urlString);
    
    if (parsed.protocol !== 'https:') {
      return false;
    }
    
    const hostname = parsed.hostname.toLowerCase();
    
    // Block known metadata endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return false;
    }
    
    // Block localhost and loopback
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      return false;
    }
    
    // Block private IP ranges (RFC 1918) and link-local
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (a === 10) return false;                         // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return false;  // 172.16.0.0/12
      if (a === 192 && b === 168) return false;            // 192.168.0.0/16
      if (a === 169 && b === 254) return false;            // 169.254.0.0/16
      if (a === 0) return false;                           // 0.0.0.0/8
    }
    
    return true;
  } catch {
    return false;
  }
}

// Roots that local media URLs may resolve to (maker input must never escape them)
const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');
const PUBLIC_MEDIA_ROOT = path.resolve(__dirname, '../../public/media');

/**
 * Map a local media URL (/uploads/... or /media/...) to a file path inside the
 * uploads or public media directory. Returns null for anything else,
 * including "../" tricks that would point outside those directories.
 */
function resolveLocalMediaPath(url) {
  if (typeof url !== 'string') return null;
  let root;
  let relative;
  if (url.startsWith('/uploads/')) {
    root = UPLOADS_ROOT;
    relative = url.slice('/uploads/'.length);
  } else if (url.startsWith('/media/')) {
    root = PUBLIC_MEDIA_ROOT;
    relative = url.slice('/media/'.length);
  } else {
    return null;
  }
  const resolved = path.resolve(root, decodeURIComponent(relative.split('?')[0]));
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

const EXTERNAL_IMAGE_TIMEOUT_MS = 15000;
const EXTERNAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const EXTERNAL_IMAGE_MAX_REDIRECTS = 3;

function isPrivateAddress(address) {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
}

/**
 * Fetch an external image (maker-supplied URL) without reaching internal
 * services: every redirect hop is checked again, the host must resolve to
 * public addresses only, and time and size are bounded.
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function fetchExternalImage(imageUrl) {
  const dns = await import('dns');
  let url = imageUrl;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTERNAL_IMAGE_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= EXTERNAL_IMAGE_MAX_REDIRECTS; hop++) {
      if (!isUrlSafeToFetch(url)) {
        throw new Error('URL blocked by security policy: only public HTTPS URLs are allowed');
      }
      const addresses = await dns.promises.lookup(new URL(url).hostname, { all: true });
      if (addresses.length === 0 || addresses.some(a => isPrivateAddress(a.address))) {
        throw new Error('URL blocked by security policy: host resolves to a private address');
      }
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        url = new URL(response.headers.get('location'), url).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status}`);
      }
      if (Number(response.headers.get('content-length') || 0) > EXTERNAL_IMAGE_MAX_BYTES) {
        throw new Error('Image too large');
      }
      const chunks = [];
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > EXTERNAL_IMAGE_MAX_BYTES) throw new Error('Image too large');
        chunks.push(chunk);
      }
      return { buffer: Buffer.concat(chunks), contentType: response.headers.get('content-type') || 'image/jpeg' };
    }
    throw new Error('Too many redirects');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convert image URL to base64 data URL
 * Supports both external URLs and local file paths
 * Automatically resizes large images for API compatibility
 */
async function imageUrlToBase64(imageUrl) {
  try {
    let buffer;
    let mimeType = 'image/jpeg';
    
    // Handle local media URLs - read directly from filesystem
    // Supports both old (/media/) and new (/uploads/) URL structures
    const isLocalMedia = imageUrl.startsWith('/media/') || imageUrl.startsWith('/uploads/');
    
    if (isLocalMedia) {
      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');
      
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      
      // Map to a file inside the uploads / public media directory only
      const localPath = resolveLocalMediaPath(imageUrl);
      
      if (!localPath || !fs.existsSync(localPath)) {
        throw new Error(`Local file not found: ${localPath}`);
      }
      
      buffer = fs.readFileSync(localPath);
      
      // Determine mime type from extension
      const ext = path.extname(imageUrl).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
      };
      mimeType = mimeTypes[ext] || 'image/jpeg';
      
    } else {
      const external = await fetchExternalImage(imageUrl);
      buffer = external.buffer;
      
      // Determine mime type from response
      mimeType = external.contentType.split(';')[0];
    }
    
    // Resize if needed (for large images/panoramas)
    buffer = await resizeImageIfNeeded(buffer, imageUrl);
    
    // After resize, always use JPEG for consistency
    const base64 = buffer.toString('base64');
    mimeType = 'image/jpeg'; // Resized images are converted to JPEG
    
    return {
      base64,
      mimeType,
      dataUrl: `data:${mimeType};base64,${base64}`
    };
    
  } catch (error) {
    console.error('[ImageAnalysis] Failed to convert image to base64:', error.message);
    throw error;
  }
}

/**
 * Detect if an image is likely a 360-degree panorama based on dimensions
 */
async function isPanoramaImage(imageUrl) {
  try {
    // Support both old (/media/) and new (/uploads/) URL structures
    const isLocalMedia = imageUrl.startsWith('/media/') || imageUrl.startsWith('/uploads/');
    if (!isLocalMedia) {
      return false;
    }
    
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const sharp = (await import('sharp')).default;
    
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    
    const localPath = resolveLocalMediaPath(imageUrl);
    if (!localPath || !fs.existsSync(localPath)) {
      return false;
    }
    
    const metadata = await sharp(localPath).metadata();
    const aspectRatio = metadata.width / metadata.height;
    
    // 360-degree panoramas typically have aspect ratio > 3:1
    return aspectRatio > 3;
  } catch {
    return false;
  }
}

/**
 * Analyze an image using Mistral Vision API
 * Returns a description in English
 */
async function analyzeImageWithMistral(imageUrl) {
  if (!(await isAiConfigured())) {
    throw new Error('No AI provider configured');
  }
  const { visionModel } = await getAiConfig();
  
  console.log('[ImageAnalysis] Converting image to base64:', imageUrl.substring(0, 100));
  
  // Check if this is a panorama image
  const isPanorama = await isPanoramaImage(imageUrl);
  
  // Convert image to base64 (with automatic resize)
  const { dataUrl } = await imageUrlToBase64(imageUrl);
  
  console.log('[ImageAnalysis] Sending to Mistral Vision API...');
  
  // Adjust prompt for panoramas
  const promptText = isPanorama 
    ? `First check: if the image shows nudity or sexual content, reply with exactly NSFW_CONTENT and nothing else.

This is a section from a 360-degree panoramic photo. Describe what you see in this space/location for an AI assistant that needs to help users understand what they're experiencing. 

Focus on:
- The type of location/space (office, lobby, conference room, outdoor area, etc.)
- Main features and objects visible
- The general atmosphere and style
- Any notable details that help identify or characterize this location

Start your description with "[360° Panorama]" to indicate this is an interactive panoramic view. Keep the description concise but comprehensive (2-4 sentences). Write in English.`
    : `First check: if the image shows nudity or sexual content, reply with exactly NSFW_CONTENT and nothing else.

Describe this image in detail for an AI assistant that needs to help users understand what they're seeing. 
              
Focus on:
- Main subjects and objects visible
- Setting/environment/location
- Colors, mood, and atmosphere
- Any text visible in the image
- Actions or activities shown
- Notable details that might be relevant for learning/training context

Keep the description concise but comprehensive (2-4 sentences). Write in English.`;
  
  const response = await aiFetch('/chat/completions', {
    body: JSON.stringify({
      model: visionModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: promptText
            },
            {
              type: 'image_url',
              image_url: {
                url: dataUrl
              }
            }
          ]
        }
      ],
      max_tokens: 500,
      temperature: 0.3 // Lower temperature for more consistent descriptions
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ImageAnalysis] Mistral API error:', response.status, errorText);
    
    // Check if this is a content policy violation (often 400 error for NSFW)
    if (response.status === 400 && (
      errorText.includes('policy') || 
      errorText.includes('content') || 
      errorText.includes('inappropriate') ||
      errorText.includes('unsafe')
    )) {
      // Return a description that will trigger NSFW detection
      return {
        description: 'I cannot analyze this image as it violates content guidelines.',
        model: visionModel,
        usage: null
      };
    }
    
    throw new Error(`Mistral API error: ${response.status}`);
  }
  
  const data = await response.json();
  const description = data.choices?.[0]?.message?.content;
  
  if (!description) {
    throw new Error('No description returned from Mistral');
  }
  
  console.log('[ImageAnalysis] Description generated:', description.substring(0, 100) + '...');
  
  return {
    description: description.trim(),
    model: visionModel,
    usage: data.usage
  };
}

/**
 * Check if a response indicates NSFW content
 */
function isNsfwResponse(description) {
  if (!description) return false;
  if (description.trim().toUpperCase().startsWith(NSFW_MARKER)) return true;
  const text = description.trim().toLowerCase().replace(/^sorry[,.!]?\s*/, '');
  return NSFW_REFUSAL_PREFIXES.some(prefix => text.startsWith(prefix));
}

/**
 * Ask NudeNet about an image the model flagged. Models sometimes flag plain or
 * abstract images, so only NudeNet's verdict removes one. When NudeNet cannot
 * look (no local file, a YouTube video, the service is off or down), the image
 * stays: it was already checked by NudeNet at upload.
 */
async function isNsfwConfirmed(url) {
  const filePath = resolveLocalMediaPath(url);
  if (!filePath || !fs.existsSync(filePath)) return false;
  const result = await checkImageFile(filePath);
  if (result.error) {
    console.warn('[ImageAnalysis] NudeNet could not check a flagged image, kept:', result.error);
    return false;
  }
  return result.isNsfw === true;
}

/**
 * Delete a media file from the filesystem (only inside the media directories)
 */
async function deleteMediaFile(url) {
  const filePath = resolveLocalMediaPath(url);
  if (!filePath) return false;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('[ImageAnalysis] Deleted NSFW file:', filePath);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[ImageAnalysis] Error deleting file:', err.message);
    return false;
  }
}

/**
 * Extract YouTube video ID from various URL formats
 */
function extractYouTubeVideoId(url) {
  if (!url) return null;
  
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * Fetch YouTube video metadata using oEmbed (no API key required)
 */
async function fetchYouTubeMetadata(videoId) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    
    const response = await fetch(oembedUrl);
    if (!response.ok) {
      throw new Error(`YouTube oEmbed error: ${response.status}`);
    }
    
    const data = await response.json();
    
    return {
      title: data.title || '',
      channel: data.author_name || '',
      thumbnailUrl: data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
    };
  } catch (error) {
    console.error('[ImageAnalysis] Failed to fetch YouTube metadata:', error.message);
    return null;
  }
}

/**
 * Analyze a YouTube video - fetch metadata and optionally analyze thumbnail
 */
async function analyzeYouTubeVideo(videoUrl) {
  const videoId = extractYouTubeVideoId(videoUrl);
  
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }
  
  console.log('[ImageAnalysis] Fetching YouTube metadata for:', videoId);
  
  const metadata = await fetchYouTubeMetadata(videoId);
  
  if (!metadata) {
    throw new Error('Failed to fetch YouTube metadata');
  }
  
  // Create description from YouTube metadata
  let description = `YouTube video: "${metadata.title}"`;
  if (metadata.channel) {
    description += ` by ${metadata.channel}`;
  }
  
  // Optionally analyze the thumbnail for more visual context
  try {
    const thumbnailAnalysis = await analyzeImageWithMistral(metadata.thumbnailUrl);
    description += `\n\nVideo thumbnail shows: ${thumbnailAnalysis.description}`;
  } catch (err) {
    console.warn('[ImageAnalysis] Failed to analyze YouTube thumbnail:', err.message);
    // Continue without thumbnail analysis
  }
  
  return {
    description,
    videoTitle: metadata.title,
    videoChannel: metadata.channel,
    model: (await getAiConfig()).visionModel
  };
}

/**
 * Get or create media analysis for a URL
 * Uses caching to avoid re-analyzing the same image
 */
export async function getOrCreateAnalysis(url, _mediaType = 'image') {
  if (!url) return null;
  
  const urlHash = hashUrl(url);
  
  // Check if analysis already exists
  const existing = await query(
    'SELECT * FROM media_analyses WHERE url_hash = $1',
    [urlHash]
  );
  
  if (existing.rows.length > 0) {
    const analysis = existing.rows[0];
    
    // Return if completed
    if (analysis.status === 'completed') {
      console.log('[ImageAnalysis] Using cached analysis for:', url.substring(0, 50));
      return analysis;
    }
    
    // If still processing, return null (will be available later)
    if (analysis.status === 'processing') {
      console.log('[ImageAnalysis] Analysis in progress for:', url.substring(0, 50));
      return null;
    }
    
    // If failed previously, try again
    if (analysis.status === 'failed') {
      console.log('[ImageAnalysis] Retrying failed analysis for:', url.substring(0, 50));
    }
  }
  
  return null;
}

/**
 * Queue an image/video for analysis (async, non-blocking)
 * This is called after media upload
 */
export async function queueAnalysis(url, mediaType = 'image') {
  if (!url) return;
  // Image analysis can be switched off, for example when the provider has no vision model
  if (!(await getSetting('ai.imageAnalysis'))) return;
  
  const urlHash = hashUrl(url);
  
  // Check if already analyzed or in progress
  const existing = await query(
    'SELECT status FROM media_analyses WHERE url_hash = $1',
    [urlHash]
  );
  
  if (existing.rows.length > 0) {
    const status = existing.rows[0].status;
    // A removed image, or one kept without a description, is not analysed again
    if (['completed', 'processing', 'nsfw_removed', 'not_described'].includes(status)) {
      console.log('[ImageAnalysis] Analysis already exists/in progress:', urlHash.substring(0, 16));
      return;
    }
  }
  
  // Create or update record to 'processing' status
  await query(`
    INSERT INTO media_analyses (url_hash, original_url, media_type, status, created_at)
    VALUES ($1, $2, $3, 'processing', NOW())
    ON CONFLICT (url_hash) DO UPDATE SET
      status = 'processing',
      updated_at = NOW()
  `, [urlHash, url, mediaType]);
  
  // Process asynchronously (don't await)
  processAnalysis(url, urlHash, mediaType).catch(err => {
    console.error('[ImageAnalysis] Background analysis failed:', err.message);
  });
  
  console.log('[ImageAnalysis] Queued for analysis:', url.substring(0, 50));
}

/**
 * Process the actual analysis (called asynchronously)
 */
async function processAnalysis(url, urlHash, mediaType) {
  try {
    let result;
    
    if (mediaType === 'youtube') {
      result = await analyzeYouTubeVideo(url);
    } else {
      result = await analyzeImageWithMistral(url);
    }
    
    // Flagged by the model: kept without a description, unless NudeNet agrees.
    // Then the file and the media library entry go.
    if (isNsfwResponse(result.description) && !(await isNsfwConfirmed(url))) {
      console.log('[ImageAnalysis] Flagged by the model, not by NudeNet; kept without description:', url);
      await query(`
        UPDATE media_analyses SET
          description = NULL,
          model_used = $1,
          status = 'not_described',
          error_message = 'Flagged by the model, not confirmed by NudeNet',
          analyzed_at = NOW(),
          updated_at = NOW()
        WHERE url_hash = $2
      `, [result.model, urlHash]);
      return;
    }
    if (isNsfwResponse(result.description)) {
      console.log('[ImageAnalysis] NSFW content confirmed by NudeNet for:', url);
      
      const deleted = await deleteMediaFile(url);
      
      await query(`
        UPDATE media_analyses SET
          description = $1,
          model_used = $2,
          status = 'nsfw_removed',
          error_message = 'NSFW content detected and removed',
          analyzed_at = NOW(),
          updated_at = NOW()
        WHERE url_hash = $3
      `, [result.description, result.model, urlHash]);
      
      await query('DELETE FROM media WHERE url = $1', [url]);
      
      console.log(`[ImageAnalysis] NSFW content removed: ${url}, file deleted: ${deleted}`);
      return;
    }
    
    // Update database with result
    await query(`
      UPDATE media_analyses SET
        description = $1,
        video_title = $2,
        video_channel = $3,
        model_used = $4,
        status = 'completed',
        analyzed_at = NOW(),
        updated_at = NOW()
      WHERE url_hash = $5
    `, [
      result.description,
      result.videoTitle || null,
      result.videoChannel || null,
      result.model,
      urlHash
    ]);
    
    console.log('[ImageAnalysis] Analysis completed for:', url.substring(0, 50));
    
  } catch (error) {
    console.error('[ImageAnalysis] Analysis failed:', error.message);
    
    // Update database with error
    await query(`
      UPDATE media_analyses SET
        status = 'failed',
        error_message = $1,
        updated_at = NOW()
      WHERE url_hash = $2
    `, [error.message, urlHash]);
  }
}

/**
 * Detect media type from URL
 */
export function detectMediaType(url) {
  if (!url) return null;
  
  // YouTube
  if (extractYouTubeVideoId(url)) {
    return 'youtube';
  }
  
  // Video files
  if (/\.(mp4|webm|ogg|mov)$/i.test(url)) {
    return 'video';
  }
  
  // Images
  if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url)) {
    return 'image';
  }
  
  // Pexels images
  if (url.includes('pexels.com') || url.includes('images.pexels.com')) {
    return 'image';
  }
  
  // Local uploads are typically images (both old and new URL structure)
  if (url.startsWith('/media/') || url.startsWith('/uploads/')) {
    return 'image';
  }
  
  return 'image'; // Default to image
}

/**
 * Get analysis description for a URL (for Step Assistant context)
 * Returns null if not yet analyzed
 */
export async function getAnalysisDescription(url) {
  if (!url) return null;
  
  const urlHash = hashUrl(url);
  
  const result = await query(
    'SELECT description, video_title, video_channel, media_type FROM media_analyses WHERE url_hash = $1 AND status = $2',
    [urlHash, 'completed']
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const analysis = result.rows[0];
  
  // For YouTube, include title/channel in a structured way
  if (analysis.media_type === 'youtube' && analysis.video_title) {
    return `Video: "${analysis.video_title}"${analysis.video_channel ? ` by ${analysis.video_channel}` : ''}. ${analysis.description || ''}`;
  }
  
  return analysis.description;
}

/**
 * Analyze multiple URLs at once (for batch processing)
 */
export async function analyzeMultipleUrls(urls) {
  const results = {};
  
  for (const url of urls) {
    if (!url) continue;
    
    const mediaType = detectMediaType(url);
    await queueAnalysis(url, mediaType);
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

export default {
  getOrCreateAnalysis,
  queueAnalysis,
  detectMediaType,
  getAnalysisDescription,
  analyzeMultipleUrls,
  extractYouTubeVideoId
};
