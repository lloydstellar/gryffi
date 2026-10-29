/**
 * Knowledge Engine Service - Gryffi
 * 
 * Handles document processing, chunking, embedding generation, and RAG retrieval
 * for AI guide knowledge bases.
 * 
 * Architecture:
 * - Each AI guide has its own isolated knowledge base
 * - Documents are processed via Unstructured.io parser container
 * - Text is chunked and embedded for semantic search
 * - RAG retrieval provides relevant context to AI responses
 */

import { query } from '../db/index.js';
import { getOrganizationUsageWithLimits } from './subscription.js';
import { createEmbedding, isAiConfigured } from './aiProvider.js';
import { getSetting } from './settings.js';
import * as XLSX from 'xlsx';
import fs from 'fs/promises';
import path from 'path';

const PARSER_URL = process.env.PARSER_URL || 'http://gryffi-parser:8000';

// Chunk configuration
const CHUNK_SIZE = 500; // characters per chunk
const CHUNK_OVERLAP = 50; // overlap between chunks

// RAG retrieval quality
// Higher threshold = fewer but more relevant chunks (less noise, less hallucination risk).
// Lower threshold = more chunks but more noise (model may anchor on weakly-related text).
// Tuned to 0.40: well above random similarity (~0.0-0.2 for unrelated text), below the
// 0.5+ that strongly-related chunks score, so we still get useful matches without flooding
// the prompt with marginally-relevant content.
// Override with KNOWLEDGE_SIMILARITY_THRESHOLD env var if needed (e.g. 0.35 for recall-heavy
// guides, 0.50 for precision-heavy guides).
const SIMILARITY_THRESHOLD = parseFloat(process.env.KNOWLEDGE_SIMILARITY_THRESHOLD || '0.40');

// Supported file types
const SUPPORTED_FILE_TYPES = {
  // Documents
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  // Images (for OCR)
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Create a new knowledge source entry
 * Supports both guide_step_id (legacy) and guide_id (central guides)
 */
export async function createKnowledgeSource({
  guideStepId = null,
  guideId = null,
  organizationId,
  sourceType,
  sourceName,
  originalFilename = null,
  contentType = null,
  fileSize = null,
  rawText = null
}) {
  const result = await query(
    `INSERT INTO knowledge_sources 
     (guide_step_id, guide_id, organization_id, source_type, source_name, original_filename, content_type, file_size, raw_text, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     RETURNING *`,
    [guideStepId, guideId, organizationId, sourceType, sourceName, originalFilename, contentType, fileSize, rawText]
  );
  return result.rows[0];
}

// File types read in-process. Everything else (PDF, Word, PowerPoint, images)
// goes to the document parser container.
const LOCAL_TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv']);
const LOCAL_SHEET_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel'
]);

// error_message of a source that needs the document parser while it is switched off
const DOCUMENT_PARSER_DISABLED = 'DOCUMENT_PARSER_DISABLED';

/**
 * Read a text or spreadsheet file without the parser container.
 * Spreadsheets become CSV text, one block per sheet.
 * @param {Buffer} fileBuffer
 * @param {string} contentType
 * @returns {string}
 */
function parseLocally(fileBuffer, contentType) {
  if (LOCAL_SHEET_TYPES.has(contentType)) {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    return workbook.SheetNames
      .map((name) => `${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`)
      .join('\n\n')
      .trim();
  }
  return fileBuffer.toString('utf8').replace(/^\uFEFF/, '').trim();
}

/**
 * Process a file through Unstructured.io parser
 *
 * @param {string} filePath - Path to the file on disk
 * @param {string} contentType - MIME type of the file
 * @param {object} [options]
 * @param {'auto'|'fast'|'hi_res'|'ocr_only'} [options.strategy] - Unstructured parsing strategy.
 *   'fast' skips ML/vision models (pdfminer only) — lighter on RAM, good enough for plain-text extraction.
 *   Defaults to PARSER_STRATEGY env var, or 'auto'.
 */
export async function parseDocument(filePath, contentType, options = {}) {
  try {
    const fileName = path.basename(filePath);
    const fileBuffer = await fs.readFile(filePath);

    if (LOCAL_TEXT_TYPES.has(contentType) || LOCAL_SHEET_TYPES.has(contentType)) {
      const text = parseLocally(fileBuffer, contentType);
      console.log(`[Knowledge] Read ${fileName} without the parser: ${text.length} characters`);
      return { success: true, text, elements: [] };
    }
    if (!(await getSetting('documents.parserEnabled'))) {
      return { success: false, error: DOCUMENT_PARSER_DISABLED };
    }
    const strategy = options.strategy || process.env.PARSER_STRATEGY || 'auto';

    console.log(`[Knowledge] Parsing document: ${fileName} (${contentType}) strategy=${strategy}`);
    console.log(`[Knowledge] File size: ${fileBuffer.length} bytes`);
    console.log(`[Knowledge] Parser URL: ${PARSER_URL}`);
    
    // Use native FormData with Blob (works with Node.js 18+)
    const blob = new Blob([fileBuffer], { type: contentType });
    const formData = new FormData();
    formData.append('files', blob, fileName);
    formData.append('strategy', strategy);
    
    // Call Unstructured API
    const response = await fetch(`${PARSER_URL}/general/v0/general`, {
      method: 'POST',
      body: formData
    });
    
    console.log(`[Knowledge] Parser response status: ${response.status}`);
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`[Knowledge] Parser error response: ${error}`);
      throw new Error(`Parser error: ${error}`);
    }
    
    const elements = await response.json();
    console.log(`[Knowledge] Parsed ${elements.length} elements`);
    
    // Extract text from parsed elements
    const textContent = elements
      .map(el => el.text || '')
      .filter(text => text.trim().length > 0)
      .join('\n\n');
    
    console.log(`[Knowledge] Extracted ${textContent.length} characters of text`);
    
    return {
      success: true,
      text: textContent,
      elements: elements
    };
  } catch (error) {
    console.error('[Knowledge] Parse error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Split text into chunks with overlap
 */
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  let currentChunk = '';
  let chunkIndex = 0;
  
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > chunkSize && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        index: chunkIndex++
      });
      
      // Keep some overlap
      const words = currentChunk.split(' ');
      const overlapWords = words.slice(-Math.ceil(words.length * (overlap / chunkSize)));
      currentChunk = overlapWords.join(' ') + ' ' + sentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }
  
  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      index: chunkIndex
    });
  }
  
  return chunks;
}

/**
 * Embed a text with the configured embedding model (services/aiProvider.js).
 * @returns {Promise<number[]|null>} The vector, or null when no provider is available
 */
async function generateEmbedding(text) {
  if (!(await isAiConfigured())) {
    console.warn('[Knowledge] No AI provider configured for embeddings');
    return null;
  }
  try {
    return await createEmbedding(text);
  } catch (error) {
    console.error('[Knowledge] Embedding error:', error.message);
    return null;
  }
}

// error_message of a source that did not fit the tier's knowledge limit:
// KNOWLEDGE_LIMIT:<chunks needed>:<chunks available>. formatKnowledgeError() turns
// it into a message for the maker.
const KNOWLEDGE_LIMIT_ERROR = /^KNOWLEDGE_LIMIT:(\d+):(\d+)$/;

/**
 * Throw when adding chunkCount chunks would exceed the organization's knowledge limit.
 * Nothing is stored then: a half-stored document would make the guide answer from
 * an incomplete source without anyone noticing.
 */
async function assertKnowledgeRoom(organizationId, chunkCount) {
  const usageData = await getOrganizationUsageWithLimits(organizationId);
  const chunks = usageData?.usage.knowledgeChunks;
  if (!chunks || chunks.isUnlimited) return;
  if (chunkCount > chunks.remaining) {
    throw new Error(`KNOWLEDGE_LIMIT:${chunkCount}:${chunks.remaining}`);
  }
}

/**
 * Message for a source's error_message: the knowledge limit and disabled-parser
 * errors are translated, anything else is returned as is.
 * @param {string|null} errorMessage
 * @param {Function} t - i18next translate function of the request
 */
export function formatKnowledgeError(errorMessage, t) {
  if (errorMessage === DOCUMENT_PARSER_DISABLED) {
    return t('guides.detail.parserDisabled');
  }
  const match = KNOWLEDGE_LIMIT_ERROR.exec(errorMessage || '');
  if (!match) return errorMessage;
  return t('subscription.limits.knowledgeSourceTooLarge', { needed: match[1], available: match[2] });
}

/**
 * Store chunks with embeddings in database
 * Supports both guide_step_id (legacy) and guide_id (central guides)
 */
async function storeChunks(sourceId, guideStepId, guideId, organizationId, chunks) {
  const storedChunks = [];
  
  for (const chunk of chunks) {
    // Generate embedding
    const embedding = await generateEmbedding(chunk.content);
    
    // Format embedding for PostgreSQL vector type
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
    
    const result = await query(
      `INSERT INTO knowledge_chunks 
       (source_id, guide_step_id, guide_id, organization_id, content, embedding, chunk_index, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
       RETURNING id, chunk_index`,
      [sourceId, guideStepId, guideId, organizationId, chunk.content, embeddingStr, chunk.index, JSON.stringify(chunk.metadata || {})]
    );
    
    storedChunks.push(result.rows[0]);
  }
  
  return storedChunks;
}

/**
 * Process an uploaded file
 * guideId and guideStepId are optional overrides (otherwise read from source)
 */
export async function processFile(sourceId, filePath, contentType, guideId = null, guideStepId = null, organizationId = null) {
  try {
    // Update status to processing
    await query(
      `UPDATE knowledge_sources SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [sourceId]
    );
    
    // Get source info
    const sourceResult = await query('SELECT * FROM knowledge_sources WHERE id = $1', [sourceId]);
    const source = sourceResult.rows[0];
    
    if (!source) {
      throw new Error('Source not found');
    }
    
    // Use provided IDs or fall back to source values
    const effectiveGuideId = guideId || source.guide_id;
    const effectiveGuideStepId = guideStepId || source.guide_step_id;
    const effectiveOrgId = organizationId || source.organization_id;
    
    // Parse document
    console.log(`[Knowledge] Processing file: ${source.source_name}`);
    const parseResult = await parseDocument(filePath, contentType);
    
    if (!parseResult.success) {
      throw new Error(parseResult.error);
    }
    
    // Chunk the text
    const chunks = chunkText(parseResult.text);
    console.log(`[Knowledge] Created ${chunks.length} chunks`);
    await assertKnowledgeRoom(effectiveOrgId, chunks.length);
    
    // Store chunks with embeddings
    const storedChunks = await storeChunks(
      sourceId,
      effectiveGuideStepId,
      effectiveGuideId,
      effectiveOrgId,
      chunks
    );
    
    // Update source status
    await query(
      `UPDATE knowledge_sources 
       SET status = 'completed', chunks_count = $2, updated_at = NOW() 
       WHERE id = $1`,
      [sourceId, storedChunks.length]
    );
    
    // Clean up uploaded file
    try {
      await fs.unlink(filePath);
      console.log(`[Knowledge] Cleaned up file: ${filePath}`);
    } catch (_e) {
      console.warn(`[Knowledge] Could not delete file: ${filePath}`);
    }
    
    return {
      success: true,
      chunksCreated: storedChunks.length
    };
    
  } catch (error) {
    console.error('[Knowledge] Processing error:', error);
    
    // Update source with error
    await query(
      `UPDATE knowledge_sources 
       SET status = 'failed', error_message = $2, updated_at = NOW() 
       WHERE id = $1`,
      [sourceId, error.message]
    );
    
    // Clean up file even on error
    try {
      await fs.unlink(filePath);
      console.log(`[Knowledge] Cleaned up file after error: ${filePath}`);
    } catch (_e) {
      // File might already be deleted or doesn't exist
    }
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Process a text source (no file upload needed)
 * guideId and guideStepId are optional overrides
 */
export async function processText(sourceId, content = null, guideId = null, guideStepId = null, organizationId = null) {
  try {
    // Update status to processing
    await query(
      `UPDATE knowledge_sources SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [sourceId]
    );
    
    // Get source with text
    const sourceResult = await query('SELECT * FROM knowledge_sources WHERE id = $1', [sourceId]);
    const source = sourceResult.rows[0];
    
    if (!source) {
      throw new Error('Source not found');
    }
    
    // Use provided content/IDs or fall back to source values
    const textContent = content || source.raw_text;
    const effectiveGuideId = guideId || source.guide_id;
    const effectiveGuideStepId = guideStepId || source.guide_step_id;
    const effectiveOrgId = organizationId || source.organization_id;
    
    if (!textContent) {
      throw new Error('No text content available');
    }
    
    // Chunk the text
    const chunks = chunkText(textContent);
    console.log(`[Knowledge] Created ${chunks.length} chunks from text`);
    await assertKnowledgeRoom(effectiveOrgId, chunks.length);
    
    // Store chunks with embeddings
    const storedChunks = await storeChunks(
      sourceId,
      effectiveGuideStepId,
      effectiveGuideId,
      effectiveOrgId,
      chunks
    );
    
    // Update source status
    await query(
      `UPDATE knowledge_sources 
       SET status = 'completed', chunks_count = $2, updated_at = NOW() 
       WHERE id = $1`,
      [sourceId, storedChunks.length]
    );
    
    return {
      success: true,
      chunksCreated: storedChunks.length
    };
    
  } catch (error) {
    console.error('[Knowledge] Text processing error:', error);
    
    await query(
      `UPDATE knowledge_sources 
       SET status = 'failed', error_message = $2, updated_at = NOW() 
       WHERE id = $1`,
      [sourceId, error.message]
    );
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Retrieve relevant knowledge for a query (RAG)
 * This is the key function used during AI conversations
 * Supports both guideStepId (legacy) and guideId (central guides)
 * 
 * SECURITY: This function now includes organization_id validation to prevent
 * cross-organization data leakage. The organizationId parameter is required
 * for defense-in-depth security.
 */
export async function retrieveKnowledge(guideStepId, queryText, limit = 5, guideId = null, organizationId = null) {
  try {
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(queryText);
    
    // Build WHERE clause based on which ID is provided
    // SECURITY: Always include organization_id check when available for defense-in-depth
    let whereClause = '';
    let params = [];
    let paramIndex = 1;
    
    if (guideId) {
      whereClause = `kc.guide_id = $${paramIndex}`;
      params = [guideId];
      paramIndex++;
    } else if (guideStepId) {
      whereClause = `kc.guide_step_id = $${paramIndex}`;
      params = [guideStepId];
      paramIndex++;
    } else {
      console.warn('[Knowledge] No guide ID provided for retrieval');
      return [];
    }
    
    // SECURITY: Add organization check if provided (defense-in-depth)
    if (organizationId) {
      whereClause += ` AND kc.organization_id = $${paramIndex}`;
      params.push(organizationId);
      paramIndex++;
    }
    
    if (!queryEmbedding) {
      console.warn('[Knowledge] No embedding generated for query, falling back to text search');
      // Fallback to simple text search with source info
      const result = await query(
        `SELECT 
           kc.id as chunk_id,
           kc.content, 
           kc.metadata,
           kc.source_id,
           ks.source_name,
           ks.original_filename,
           ks.source_type
         FROM knowledge_chunks kc
         JOIN knowledge_sources ks ON kc.source_id = ks.id
         WHERE ${whereClause}
         AND kc.content ILIKE $${paramIndex}
         LIMIT $${paramIndex + 1}`,
        [...params, `%${queryText.split(' ').slice(0, 3).join('%')}%`, limit]
      );
      return result.rows;
    }
    
    // Vector similarity search with source information and similarity threshold
    const embeddingStr = `[${queryEmbedding.join(',')}]`;
    
    const result = await query(
      `SELECT 
         kc.id as chunk_id,
         kc.content, 
         kc.metadata,
         kc.source_id,
         ks.source_name,
         ks.original_filename,
         ks.source_type,
         1 - (kc.embedding <=> $${paramIndex}::vector) as similarity
       FROM knowledge_chunks kc
       JOIN knowledge_sources ks ON kc.source_id = ks.id
       WHERE ${whereClause}
       AND kc.embedding IS NOT NULL
       AND 1 - (kc.embedding <=> $${paramIndex}::vector) >= ${SIMILARITY_THRESHOLD}
       ORDER BY kc.embedding <=> $${paramIndex}::vector
       LIMIT $${paramIndex + 1}`,
      [...params, embeddingStr, limit]
    );
    
    console.log(`[Knowledge] Retrieved ${result.rows.length} relevant chunks (threshold: ${SIMILARITY_THRESHOLD}) for ${guideId ? 'central guide' : 'guide step'}${organizationId ? ' (org-verified)' : ''}`);
    if (result.rows.length > 0) {
      console.log(`[Knowledge] Similarity range: ${result.rows[result.rows.length - 1]?.similarity?.toFixed(3)} - ${result.rows[0]?.similarity?.toFixed(3)}`);
    }
    
    return result.rows;
    
  } catch (error) {
    console.error('[Knowledge] Retrieval error:', error);
    return [];
  }
}

/**
 * Parse citations from AI response text
 * Extracts [ID] format citations and returns them with their positions
 * @param {string} text - AI response text
 * @returns {Array} Array of {id, position, fullMatch} objects
 */
export function parseCitations(text) {
  if (!text) return [];
  
  // Match [ID] format where ID can be:
  // - Full UUID: [a1b2c3d4-e5f6-7890-abcd-ef1234567890]
  // - Partial UUID (first 8 chars): [a1b2c3d4]
  // - chunk-N format: [chunk-1]
  // eslint-disable-next-line security/detect-unsafe-regex -- fixed-width UUID/number groups only, no nested quantifiers, linear time
  const citationRegex = /\[([a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?|chunk-\d+)\]/gi;
  const citations = [];
  let match;
  
  while ((match = citationRegex.exec(text)) !== null) {
    citations.push({
      id: match[1],
      position: match.index,
      fullMatch: match[0],
      isPartial: !match[1].includes('-') && match[1].length === 8 // Partial UUID (8 chars without dashes)
    });
  }
  
  return citations;
}

/**
 * Get source information for citation IDs with organization security check
 * @param {Array} citationIds - Array of chunk IDs from citations
 * @param {string} organizationId - Organization ID for security check
 * @returns {Promise<Array>} Array of source information objects
 */
export async function getCitationSources(citationIds, organizationId) {
  if (!citationIds || citationIds.length === 0) {
    console.log('[Knowledge] No citation IDs provided');
    return [];
  }
  
  console.log('[Knowledge] getCitationSources called with:', {
    citationIds,
    organizationId,
    count: citationIds.length
  });
  
  try {
    // Separate full UUIDs from partial IDs
    const fullUuids = citationIds.filter(id => {
      const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      return uuidPattern.test(id);
    });
    const partialIds = citationIds.filter(id => !fullUuids.includes(id) && /^[a-f0-9]{8}$/i.test(id));
    
    console.log('[Knowledge] Separated IDs:', { fullUuids, partialIds });
    
    let result = { rows: [] };
    
    if (fullUuids.length > 0) {
      // Query chunks with full UUIDs - use text comparison to be safe
      const uuidStrings = fullUuids.map(id => id.toString());
      
      result = await query(
        `SELECT 
           kc.id as chunk_id,
           kc.content as original_text,
           kc.metadata,
           kc.chunk_index,
           ks.id as source_id,
           ks.source_name,
           ks.original_filename,
           ks.source_type,
           ks.organization_id
         FROM knowledge_chunks kc
         JOIN knowledge_sources ks ON kc.source_id = ks.id
         WHERE kc.id::text = ANY($2::text[])
         AND ks.organization_id = $1
         ORDER BY ks.source_name, kc.chunk_index`,
        [organizationId, uuidStrings]
      );
      
      console.log('[Knowledge] Full UUID query returned', result.rows.length, 'rows');
    }
    
    // For partial IDs, find matching chunks by prefix (UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
    // We need to match the first 8 chars without dashes
    if (partialIds.length > 0) {
      const partialResults = await query(
        `SELECT 
           kc.id as chunk_id,
           kc.content as original_text,
           kc.metadata,
           kc.chunk_index,
           ks.id as source_id,
           ks.source_name,
           ks.original_filename,
           ks.source_type,
           ks.organization_id
         FROM knowledge_chunks kc
         JOIN knowledge_sources ks ON kc.source_id = ks.id
         WHERE ks.organization_id = $1
         AND (
           ${partialIds.map((_, i) => `REPLACE(kc.id::text, '-', '') LIKE $${i + 2} || '%'`).join(' OR ')}
         )
         ORDER BY ks.source_name, kc.chunk_index`,
        [organizationId, ...partialIds]
      );
      
      console.log('[Knowledge] Partial ID query returned', partialResults.rows.length, 'rows');
      
      // Merge results
      if (result.rows) {
        result.rows = [...result.rows, ...partialResults.rows];
      } else {
        result = partialResults;
      }
    }
    
    // Security check: ensure all sources belong to the organization
    const unauthorized = result.rows.filter(row => row.organization_id !== organizationId);
    if (unauthorized.length > 0) {
      console.error('[Knowledge] Security violation: Attempted access to sources from different organization');
      return [];
    }
    
    console.log('[Knowledge] Found', result.rows.length, 'chunks in database');
    if (result.rows.length > 0) {
      console.log('[Knowledge] Sample chunk:', {
        chunk_id: result.rows[0].chunk_id,
        source_name: result.rows[0].source_name,
        original_filename: result.rows[0].original_filename
      });
    }
    
    // Format results and create a map for partial ID matching
    const sourceMap = {};
    result.rows.forEach(row => {
      const chunkIdStr = row.chunk_id.toString();
      const chunkIdPrefix = chunkIdStr.substring(0, 8).replace(/-/g, '');
      
      const sourceInfo = {
        chunkId: chunkIdStr, // Always use string for consistency
        sourceId: row.source_id,
        sourceName: row.source_name || row.original_filename || 'Unknown Source',
        originalFilename: row.original_filename,
        sourceType: row.source_type,
        pageNumber: row.metadata?.page_number || row.metadata?.page || null,
        originalText: row.original_text || '',
        metadata: row.metadata || {}
      };
      
      // Map by full UUID (as string)
      sourceMap[chunkIdStr] = sourceInfo;
      
      // Also map by prefix for partial matches
      if (chunkIdPrefix.length === 8) {
        sourceMap[chunkIdPrefix] = sourceInfo;
      }
    });
    
    console.log('[Knowledge] Source map created with', Object.keys(sourceMap).length, 'entries');
    console.log('[Knowledge] Looking for citation IDs:', citationIds);
    
    // Return sources mapped to their citation IDs
    const matchedSources = citationIds.map(citationId => {
      const citationIdStr = citationId.toString();
      
      // Try exact match first (as string)
      if (sourceMap[citationIdStr]) {
        console.log('[Knowledge] Found exact match for', citationIdStr);
        return sourceMap[citationIdStr];
      }
      
      // Try partial match (first 8 chars without dashes)
      const prefix = citationIdStr.substring(0, 8).replace(/-/g, '');
      if (prefix.length === 8 && sourceMap[prefix]) {
        console.log('[Knowledge] Found partial match for', citationIdStr, '->', prefix);
        return { ...sourceMap[prefix], matchedCitationId: citationIdStr };
      }
      
      console.warn('[Knowledge] No match found for', citationIdStr);
      return null;
    }).filter(Boolean);
    
    console.log('[Knowledge] Returning', matchedSources.length, 'matched sources out of', citationIds.length, 'requested');
    return matchedSources;
    
  } catch (error) {
    console.error('[Knowledge] Error fetching citation sources:', error);
    return [];
  }
}

/**
 * Get all knowledge sources for a guide
 */
export async function getKnowledgeSources(guideStepId) {
  const result = await query(
    `SELECT id, source_type, source_name, original_filename, content_type, 
            file_size, status, error_message, chunks_count, created_at
     FROM knowledge_sources 
     WHERE guide_step_id = $1
     ORDER BY created_at DESC`,
    [guideStepId]
  );
  return result.rows;
}

/**
 * Update a text knowledge source and reprocess chunks
 */
export async function updateTextKnowledgeSource(sourceId, organizationId, title, content) {
  // Verify ownership and that it's a text source
  const sourceResult = await query(
    'SELECT * FROM knowledge_sources WHERE id = $1 AND organization_id = $2 AND source_type = $3',
    [sourceId, organizationId, 'text']
  );
  
  if (sourceResult.rows.length === 0) {
    throw new Error('Text source not found or access denied');
  }
  
  const source = sourceResult.rows[0];
  
  // Update the source
  await query(
    `UPDATE knowledge_sources 
     SET source_name = $1, raw_text = $2, status = 'processing', updated_at = NOW()
     WHERE id = $3`,
    [title || source.source_name, content, sourceId]
  );
  
  // Delete old chunks
  await query('DELETE FROM knowledge_chunks WHERE source_id = $1', [sourceId]);
  
  // Reprocess text with new content
  const guideId = source.guide_id;
  const guideStepId = source.guide_step_id;
  
  const processResult = await processText(sourceId, content, guideId, guideStepId, organizationId);
  
  if (!processResult.success) {
    throw new Error(processResult.error || 'Failed to reprocess text');
  }
  
  return {
    success: true,
    chunksCreated: processResult.chunksCreated
  };
}

/**
 * Delete a knowledge source and all its chunks
 */
export async function deleteKnowledgeSource(sourceId, organizationId) {
  // Verify ownership
  const sourceResult = await query(
    'SELECT * FROM knowledge_sources WHERE id = $1 AND organization_id = $2',
    [sourceId, organizationId]
  );
  
  if (sourceResult.rows.length === 0) {
    throw new Error('Source not found or access denied');
  }
  
  // Delete (cascades to chunks)
  await query('DELETE FROM knowledge_sources WHERE id = $1', [sourceId]);
  
  return { success: true };
}

/**
 * Get knowledge statistics for a guide
 */
export async function getKnowledgeStats(guideStepId) {
  const sourcesResult = await query(
    `SELECT 
       COUNT(*) as total_sources,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
       SUM(chunks_count) as total_chunks
     FROM knowledge_sources 
     WHERE guide_step_id = $1`,
    [guideStepId]
  );
  
  return sourcesResult.rows[0];
}

/**
 * Check if file type is supported
 */
export function isFileTypeSupported(mimeType) {
  return mimeType in SUPPORTED_FILE_TYPES;
}

/**
 * Get supported file types list
 */
export function getSupportedFileTypes() {
  return Object.entries(SUPPORTED_FILE_TYPES).map(([mime, ext]) => ({
    mimeType: mime,
    extension: ext
  }));
}

/**
 * Verify citations in the AI response against the chunks that were actually provided.
 * Replaces <<N>> citation references with real chunk UUIDs [uuid],
 * and strips any citations that don't correspond to a valid provided chunk.
 * Also detects "lazy citing" where the model uses the same source for everything.
 * @param {string} responseText - Raw AI response text
 * @param {Object} chunkIdMap - Mapping of sequential IDs to real chunk UUIDs { '1': 'uuid', '2': 'uuid' }
 * @param {Array} knowledgeChunks - The actual knowledge chunks (for lazy-cite correction)
 * @returns {string} Cleaned response with verified citations only
 */
export function verifyAndCleanCitations(responseText, chunkIdMap, knowledgeChunks = []) {
  if (!responseText || !chunkIdMap) return responseText;

  let cleaned = responseText;
  const validIds = new Set(Object.keys(chunkIdMap));
  const maxSourceNum = Math.max(...Object.keys(chunkIdMap).map(Number));

  // Track which source numbers the model used, with their surrounding text
  const citationUsage = [];

  // Replace <<N>> or <<Source N>> references with real chunk UUIDs
  // Also handle [N], [Source N] as fallback formats the model might use
  // eslint-disable-next-line security/detect-unsafe-regex -- fixed-width UUID/number groups only, no nested quantifiers, linear time
  cleaned = cleaned.replace(/(?:<<|[\[])(?:Source\s*)?(\d+)(?:>>|[\]])/gi, (match, num) => {
    if (validIds.has(num)) {
      citationUsage.push(num);
      return `[${chunkIdMap[num]}]`;
    }
    // Number beyond valid range but small enough to be a citation attempt - remove
    if (parseInt(num) <= maxSourceNum + 5) {
      console.warn(`[Knowledge] Stripped out-of-range citation: ${match}`);
      return '';
    }
    // Large number, probably not a citation (e.g. "[30 days]") - leave as-is
    return match;
  });

  // Detect lazy citing: if all citations use the same source, try to correct them
  if (knowledgeChunks.length > 1 && citationUsage.length > 1) {
    const uniqueSources = new Set(citationUsage);
    if (uniqueSources.size === 1) {
      console.warn(`[Knowledge] Lazy citing detected: model used only source [${[...uniqueSources][0]}] for all ${citationUsage.length} citations`);
      // Re-process: for each citation, find the best matching chunk based on surrounding text
      cleaned = reassignCitations(cleaned, chunkIdMap, knowledgeChunks);
    }
  }

  // Strip any hallucinated UUIDs that weren't in our provided set
  const realChunkIds = new Set(Object.values(chunkIdMap));
  // eslint-disable-next-line security/detect-unsafe-regex -- fixed-width UUID/number groups only, no nested quantifiers, linear time
  cleaned = cleaned.replace(/\[([a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?)\]/gi, (match, id) => {
    if (realChunkIds.has(id)) return match;
    for (const realId of realChunkIds) {
      if (realId.startsWith(id) || realId.replace(/-/g, '').startsWith(id)) return match;
    }
    console.warn(`[Knowledge] Stripped hallucinated citation: ${match}`);
    return '';
  });

  cleaned = cleaned.replace(/  +/g, ' ').trim();
  return cleaned;
}

/**
 * Re-assign citations when the model lazily used the same source for everything.
 * For each citation in the text, extracts the surrounding sentence and finds
 * the best-matching knowledge chunk using keyword overlap.
 */
function reassignCitations(text, chunkIdMap, knowledgeChunks) {
  const realChunkIds = Object.values(chunkIdMap);
  const uuidRegex = /\[([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]/gi;
  
  return text.replace(uuidRegex, (match, _uuid, offset) => {
    // Extract ~120 chars before the citation as context
    const contextStart = Math.max(0, offset - 120);
    const context = text.substring(contextStart, offset).toLowerCase();
    // Extract significant words (4+ chars) from the context
    const contextWords = context.match(/[a-z\u00C0-\u024F]{4,}/gi) || [];
    if (contextWords.length === 0) return match;
    
    // Score each chunk by keyword overlap with the context
    let bestScore = -1;
    let bestChunkIdx = -1;
    
    knowledgeChunks.forEach((chunk, i) => {
      const chunkText = (chunk.content || '').toLowerCase();
      let score = 0;
      for (const word of contextWords) {
        if (chunkText.includes(word.toLowerCase())) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestChunkIdx = i;
      }
    });
    
    if (bestChunkIdx >= 0 && bestScore > 0) {
      const correctUuid = realChunkIds[bestChunkIdx];
      if (correctUuid) {
        console.log(`[Knowledge] Re-assigned citation: context="${contextWords.slice(-3).join(' ')}" -> chunk ${bestChunkIdx + 1} (score: ${bestScore}/${contextWords.length})`);
        return `[${correctUuid}]`;
      }
    }
    
    return match;
  });
}


// Progress of the running or last re-embedding (one per process)
let reembedState = { running: false, done: 0, total: 0, failed: 0, startedAt: null, finishedAt: null };

/**
 * Progress of re-embedding the knowledge base.
 * @returns {{running: boolean, done: number, total: number, failed: number, startedAt: string|null, finishedAt: string|null}}
 */
export function getReembedStatus() {
  return { ...reembedState };
}

/**
 * Embed every knowledge chunk again with the current embedding model. Needed
 * after the embedding model or provider changed: vectors from different models
 * cannot be compared. Runs in the background; returns the starting status.
 */
export async function reembedAllChunks() {
  if (reembedState.running) return getReembedStatus();
  const total = (await query('SELECT count(*)::int AS n FROM knowledge_chunks')).rows[0].n;
  reembedState = { running: true, done: 0, total, failed: 0, startedAt: new Date().toISOString(), finishedAt: null };

  (async () => {
    let lastId = null;
    for (;;) {
      const batch = await query(
        'SELECT id, content FROM knowledge_chunks WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 50',
        [lastId]
      );
      if (batch.rows.length === 0) break;
      for (const row of batch.rows) {
        try {
          const embedding = await createEmbedding(row.content);
          await query('UPDATE knowledge_chunks SET embedding = $1::vector WHERE id = $2', [`[${embedding.join(',')}]`, row.id]);
        } catch (err) {
          // One line is enough: when the provider is down, every chunk fails the same way
          if (reembedState.failed === 0) console.error(`[Knowledge] Re-embedding chunk ${row.id} failed:`, err.message);
          reembedState.failed++;
        }
        reembedState.done++;
        lastId = row.id;
      }
    }
  })()
    .catch((err) => console.error('[Knowledge] Re-embedding stopped:', err))
    .finally(() => {
      reembedState.running = false;
      reembedState.finishedAt = new Date().toISOString();
      console.log(`[Knowledge] Re-embedding finished: ${reembedState.done - reembedState.failed} of ${reembedState.total} chunks, ${reembedState.failed} failed`);
    });

  return getReembedStatus();
}
