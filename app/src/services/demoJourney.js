/**
 * Demo Journey Service
 * Manages system-level demo journeys for maker onboarding.
 * Demo journeys are centrally managed and shown read-only to all organizations.
 */
import { query } from '../db/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Demo images are stored in app/public/images/demo/ which syncs to production
// In Docker: /app/public/images/demo (from ./app/public:/app/public volume)
const DEMO_IMAGES_DIR = path.join(__dirname, '../../public/images/demo');
const DEMO_IMAGES_URL_PREFIX = '/images/demo';

// Source uploads directory (where organization-specific images are stored)
// In Docker: /app/uploads (from ./data/uploads:/app/uploads volume)
// On host: ./data/uploads
const UPLOADS_DIR = path.join(__dirname, '../../uploads');

const SUPPORTED_LANGUAGES = ['en', 'nl', 'de', 'fr', 'es'];

// Compound word corrections - these are replaced WITHOUT word boundaries
// to catch compound words like "demoreis" -> "demo-expeditie"
const COMPOUND_CORRECTIONS = {
  nl: {
    // Compound words with "reis" that should use "expeditie"
    'demoreis': 'demo-expeditie',
    'Demoreis': 'Demo-expeditie',
    'reisbouwer': 'expeditiebouwer',
    'Reisbouwer': 'Expeditiebouwer',
    'reisbuilder': 'expeditiebuilder',
    'Reisbuilder': 'Expeditiebuilder',
    // "Reis voltooid" -> "Expeditie voltooid" (with various punctuation)
    'Reis voltooid!': 'Expeditie voltooid!',
    'reis voltooid!': 'expeditie voltooid!',
    'Reis voltooid': 'Expeditie voltooid',
    'reis voltooid': 'expeditie voltooid',
    // "deze reis" -> "deze expeditie"
    'deze reis': 'deze expeditie',
    'Deze reis': 'Deze expeditie',
    // Visual journey builder
    'visuele reisbouwer': 'visuele expeditiebouwer',
    'Visuele reisbouwer': 'Visuele expeditiebouwer'
  },
  de: {
    // German compound words - Duits heeft veel samengestelde woorden
    'Demoreise': 'Demo-Expedition',
    'demoreise': 'demo-expedition',
    'Reisebauer': 'Expeditionsbauer',
    'Reisebuilder': 'Expeditionsbuilder',
    'Reisebaukasten': 'Expeditionsbaukasten',
    // "Reise" completion phrases
    'Reise abgeschlossen': 'Expedition abgeschlossen',
    'Reise abgeschlossen!': 'Expedition abgeschlossen!',
    'Reise vollendet': 'Expedition vollendet',
    'Reise vollendet!': 'Expedition vollendet!',
    'Reise beendet': 'Expedition beendet',
    'Reise beendet!': 'Expedition beendet!',
    // "diese Reise" -> "diese Expedition"
    'diese Reise': 'diese Expedition',
    'Diese Reise': 'Diese Expedition',
    'dieser Reise': 'dieser Expedition',
    'Dieser Reise': 'Dieser Expedition',
    // Visual builder
    'visuellen Reisebauer': 'visuellen Expeditionsbauer',
    'Visuellen Reisebauer': 'Visuellen Expeditionsbauer',
    'visuelle Reisebauer': 'visuelle Expeditionsbauer',
    'Visuelle Reisebauer': 'Visuelle Expeditionsbauer',
    // End of journey
    'Ende dieser Reise': 'Ende dieser Expedition',
    'Ende der Reise': 'Ende der Expedition',
    // Other common phrases
    'Ihrer Reise': 'Ihrer Expedition',
    'deiner Reise': 'deiner Expedition',
    'eine Reise': 'eine Expedition',
    'Eine Reise': 'Eine Expedition'
  },
  fr: {
    // French compound words
    'voyage de démonstration': 'parcours de démonstration',
    'Voyage de démonstration': 'Parcours de démonstration',
    'Voyage terminé': 'Parcours terminé',
    'voyage terminé': 'parcours terminé'
  },
  es: {
    // Spanish compound words
    'viaje de demostración': 'expedición de demostración',
    'Viaje de demostración': 'Expedición de demostración',
    'viaje demo': 'expedición demo',
    'Viaje demo': 'Expedición demo',
    'Viaje completado': 'Expedición completada',
    'viaje completado': 'expedición completada'
  }
};

// Common incorrect translations that AI might produce, mapped to correct Gryffi terms
// Also includes English terms that AI might leave untranslated
// These are replaced WITH word boundaries to avoid partial matches
const TRANSLATION_CORRECTIONS = {
  nl: {
    // English terms left untranslated
    'Journey': 'Expeditie',
    'journey': 'expeditie',
    'Journeys': 'Expedities',
    'journeys': 'expedities',
    'Challenge': 'Quiz',
    'challenge': 'quiz',
    'Guide': 'Gids',
    'guide': 'gids',
    'Content': 'Inhoud',
    'content': 'inhoud',
    'Space': 'Ruimte',
    'space': 'ruimte',
    'Form': 'Formulier',
    'form': 'formulier',
    'Poll': 'Peiling',
    'poll': 'peiling',
    'Reward': 'Beloning',
    'reward': 'beloning',
    // Journey corrections
    'reis': 'expeditie',
    'Reis': 'Expeditie',
    'REIS': 'EXPEDITIE',
    'reizen': 'expedities',
    'Reizen': 'Expedities',
    'traject': 'expeditie',
    'Traject': 'Expeditie',
    'trajecten': 'expedities',
    'Trajecten': 'Expedities',
    // Step type corrections
    'Uitdaging': 'Quiz',
    'uitdaging': 'quiz',
    'Begeleider': 'Gids',
    'begeleider': 'gids'
  },
  de: {
    // English terms left untranslated
    'Journey': 'Expedition',
    'journey': 'expedition',
    'Journeys': 'Expeditionen',
    'journeys': 'expeditionen',
    'Challenge': 'Quiz',
    'challenge': 'quiz',
    'Guide': 'Begleiter',
    'guide': 'begleiter',
    'Content': 'Inhalt',
    'content': 'inhalt',
    'Space': 'Raum',
    'space': 'raum',
    'Form': 'Formular',
    'form': 'formular',
    'Poll': 'Umfrage',
    'poll': 'umfrage',
    'Reward': 'Belohnung',
    'reward': 'belohnung',
    // Journey corrections  
    'Reise': 'Expedition',
    'reise': 'expedition',
    'REISE': 'EXPEDITION',
    'Reisen': 'Expeditionen',
    'reisen': 'expeditionen',
    // Step type corrections
    'Herausforderung': 'Quiz',
    'herausforderung': 'quiz',
    'Anleitung': 'Begleiter',
    'anleitung': 'begleiter'
  },
  fr: {
    // English terms left untranslated
    'Journey': 'Parcours',
    'journey': 'parcours',
    'Journeys': 'Parcours',
    'journeys': 'parcours',
    'Challenge': 'Défi',
    'challenge': 'défi',
    'Guide': 'Guide',
    'guide': 'guide',
    'Content': 'Contenu',
    'content': 'contenu',
    'Space': 'Espace',
    'space': 'espace',
    'Form': 'Formulaire',
    'form': 'formulaire',
    'Poll': 'Sondage',
    'poll': 'sondage',
    'Reward': 'Récompense',
    'reward': 'récompense',
    // Journey corrections
    'Voyage': 'Parcours',
    'voyage': 'parcours',
    'VOYAGE': 'PARCOURS',
    'voyages': 'parcours',
    'Voyages': 'Parcours',
    'Trajet': 'Parcours',
    'trajet': 'parcours',
    'trajets': 'parcours'
  },
  es: {
    // English terms left untranslated
    'Journey': 'Expedición',
    'journey': 'expedición',
    'Journeys': 'Expediciones',
    'journeys': 'expediciones',
    'Challenge': 'Desafío',
    'challenge': 'desafío',
    'Guide': 'Guía',
    'guide': 'guía',
    'Content': 'Contenido',
    'content': 'contenido',
    'Space': 'Espacio',
    'space': 'espacio',
    'Form': 'Formulario',
    'form': 'formulario',
    'Poll': 'Encuesta',
    'poll': 'encuesta',
    'Reward': 'Recompensa',
    'reward': 'recompensa',
    // Journey corrections
    'Viaje': 'Expedición',
    'viaje': 'expedición',
    'VIAJE': 'EXPEDICIÓN',
    'viajes': 'expediciones',
    'Viajes': 'Expediciones',
    'Jornada': 'Expedición',
    'jornada': 'expedición'
  }
};

/**
 * Apply Gryffi-specific terminology corrections to translated text
 * This ensures consistent terminology across the interface
 * @param {string} text - Text to correct
 * @param {string} lang - Target language code
 * @returns {string} - Corrected text
 */
function applyGryffiTerminology(text, lang) {
  if (!text || typeof text !== 'string' || lang === 'en') {
    return text;
  }
  
  let correctedText = text;
  
  // First, apply compound word corrections (without word boundaries)
  // This catches words like "demoreis" -> "demo-expeditie"
  const compoundCorrections = COMPOUND_CORRECTIONS[lang];
  if (compoundCorrections) {
    for (const [incorrect, correct] of Object.entries(compoundCorrections)) {
      // Case-sensitive replacement without word boundaries
      correctedText = correctedText.split(incorrect).join(correct);
    }
  }
  
  // Then, apply regular word corrections (with word boundaries)
  const corrections = TRANSLATION_CORRECTIONS[lang];
  if (corrections) {
    for (const [incorrect, correct] of Object.entries(corrections)) {
      // Use word boundaries to avoid replacing parts of words
      // eslint-disable-next-line security/detect-non-literal-regexp -- keys come from the static TRANSLATION_CORRECTIONS table
      const regex = new RegExp(`\\b${incorrect}\\b`, 'g');
      correctedText = correctedText.replace(regex, correct);
    }
  }
  
  return correctedText;
}

/**
 * Apply Gryffi terminology to entire content object (title, description, steps, paths)
 * @param {Object} content - Content object with title, description, steps, paths
 * @param {string} lang - Target language code
 * @returns {Object} - Content with corrected terminology
 */
function applyGryffiTerminologyToContent(content, lang) {
  if (lang === 'en') {
    return content;
  }
  
  return {
    ...content,
    title: applyGryffiTerminology(content.title, lang),
    description: applyGryffiTerminology(content.description, lang),
    steps: content.steps?.map(step => ({
      ...step,
      title: applyGryffiTerminology(step.title, lang),
      basic_props: step.basic_props ? applyGryffiTerminologyToProps(step.basic_props, lang) : step.basic_props,
      advanced_props: step.advanced_props ? applyGryffiTerminologyToProps(step.advanced_props, lang) : step.advanced_props
    })),
    paths: content.paths?.map(path => ({
      ...path,
      label: applyGryffiTerminology(path.label, lang),
      description: applyGryffiTerminology(path.description, lang)
    }))
  };
}

/**
 * Recursively apply terminology corrections to props object
 * @param {Object} props - Props object
 * @param {string} lang - Target language code
 * @returns {Object} - Corrected props
 */
function applyGryffiTerminologyToProps(props, lang) {
  if (!props || typeof props !== 'object') {
    return props;
  }
  
  const result = {};
  
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string') {
      result[key] = applyGryffiTerminology(value, lang);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (typeof item === 'string') {
          return applyGryffiTerminology(item, lang);
        } else if (typeof item === 'object' && item !== null) {
          return applyGryffiTerminologyToProps(item, lang);
        }
        return item;
      });
    } else if (typeof value === 'object' && value !== null) {
      result[key] = applyGryffiTerminologyToProps(value, lang);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * Check if an image URL is organization-specific (not accessible by other orgs)
 * @param {string} url - Image URL to check
 * @returns {boolean} - True if the image is organization-specific
 */
function isOrganizationSpecificImage(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  
  // Organization-specific paths that are not accessible across orgs
  const orgSpecificPatterns = [
    '/uploads/organizations/',
    '/media/organizations/'
  ];
  
  return orgSpecificPatterns.some(pattern => url.includes(pattern));
}

/**
 * Copy an organization-specific image to the public demo directory
 * @param {string} imageUrl - Original image URL (e.g., /uploads/organizations/{orgId}/pexels/123.jpg)
 * @param {number} stepIndex - Step index for unique naming
 * @param {string} fieldName - Field name (image_url, panorama_url, etc.)
 * @returns {string|null} - New public URL or null if copy failed
 */
async function copyImageToDemo(imageUrl, stepIndex, fieldName) {
  console.log(`[Demo Deploy] copyImageToDemo called with: ${imageUrl}, step ${stepIndex}, field ${fieldName}`);
  
  if (!imageUrl || !isOrganizationSpecificImage(imageUrl)) {
    console.log(`[Demo Deploy] Image URL is not organization-specific, skipping: ${imageUrl}`);
    return imageUrl;
  }
  
  try {
    // Ensure demo directory exists
    console.log(`[Demo Deploy] Demo images dir: ${DEMO_IMAGES_DIR}`);
    console.log(`[Demo Deploy] Uploads dir: ${UPLOADS_DIR}`);
    
    if (!fs.existsSync(DEMO_IMAGES_DIR)) {
      console.log(`[Demo Deploy] Creating demo images directory: ${DEMO_IMAGES_DIR}`);
      fs.mkdirSync(DEMO_IMAGES_DIR, { recursive: true });
    }
    
    // Extract the relative path from the URL
    // URL format: /uploads/organizations/{orgId}/pexels/filename.jpg
    // File path in container: /app/uploads/organizations/{orgId}/pexels/filename.jpg
    let relativePath = imageUrl;
    if (relativePath.startsWith('/uploads/')) {
      relativePath = relativePath.substring('/uploads/'.length);
    } else if (relativePath.startsWith('/media/')) {
      relativePath = relativePath.substring('/media/'.length);
    }
    
    // image_url is maker input: never read outside the uploads directory
    const uploadsRoot = path.resolve(UPLOADS_DIR);
    const sourcePath = path.resolve(uploadsRoot, relativePath);
    if (!sourcePath.startsWith(uploadsRoot + path.sep)) {
      console.warn(`[Demo Deploy] Refused image path outside uploads: ${imageUrl}`);
      return imageUrl;
    }
    console.log(`[Demo Deploy] Looking for source file at: ${sourcePath}`);
    
    // Check if source file exists
    if (!fs.existsSync(sourcePath)) {
      console.log(`[Demo Deploy] Source image not found: ${sourcePath}`);
      // Try to list the parent directory to debug
      const parentDir = path.dirname(sourcePath);
      if (fs.existsSync(parentDir)) {
        console.log(`[Demo Deploy] Parent directory exists, contents: ${fs.readdirSync(parentDir).join(', ')}`);
      } else {
        console.log(`[Demo Deploy] Parent directory does not exist: ${parentDir}`);
      }
      return null;
    }
    
    // Get file extension
    const ext = path.extname(sourcePath);
    
    // Create unique filename based on step and field
    const newFilename = `step-${stepIndex}-${fieldName}${ext}`;
    const destPath = path.join(DEMO_IMAGES_DIR, newFilename);
    
    // Copy the file
    console.log(`[Demo Deploy] Copying: ${sourcePath} -> ${destPath}`);
    fs.copyFileSync(sourcePath, destPath);
    console.log(`[Demo Deploy] Successfully copied image: ${newFilename}`);
    
    // Return the new public URL
    return `${DEMO_IMAGES_URL_PREFIX}/${newFilename}`;
  } catch (err) {
    console.error(`[Demo Deploy] Error copying image: ${err.message}`);
    console.error(`[Demo Deploy] Stack: ${err.stack}`);
    return null;
  }
}

/**
 * Copy cover image to demo directory
 * @param {string} imageUrl - Original cover image URL
 * @returns {string|null} - New public URL or null if copy failed
 */
async function copyCoverImageToDemo(imageUrl) {
  if (!imageUrl || !isOrganizationSpecificImage(imageUrl)) {
    return imageUrl;
  }
  
  try {
    // Ensure demo directory exists
    if (!fs.existsSync(DEMO_IMAGES_DIR)) {
      fs.mkdirSync(DEMO_IMAGES_DIR, { recursive: true });
    }
    
    // Extract the relative path from the URL
    let relativePath = imageUrl;
    if (relativePath.startsWith('/uploads/')) {
      relativePath = relativePath.substring('/uploads/'.length);
    } else if (relativePath.startsWith('/media/')) {
      relativePath = relativePath.substring('/media/'.length);
    }
    
    const sourcePath = path.join(UPLOADS_DIR, relativePath);
    
    // Check if source file exists
    if (!fs.existsSync(sourcePath)) {
      console.log(`[Demo Deploy] Source cover image not found: ${sourcePath}`);
      return null;
    }
    
    // Get file extension
    const ext = path.extname(sourcePath);
    
    // Create filename for cover
    const newFilename = `cover${ext}`;
    const destPath = path.join(DEMO_IMAGES_DIR, newFilename);
    
    // Copy the file
    fs.copyFileSync(sourcePath, destPath);
    console.log(`[Demo Deploy] Copied cover image: ${sourcePath} -> ${destPath}`);
    
    // Return the new public URL
    return `${DEMO_IMAGES_URL_PREFIX}/${newFilename}`;
  } catch (err) {
    console.error(`[Demo Deploy] Error copying cover image: ${err.message}`);
    return null;
  }
}

/**
 * Process steps and copy organization-specific images to the public demo directory
 * @param {Array} steps - Steps array
 * @returns {Array} - Steps with updated image URLs pointing to public demo directory
 */
async function processStepImages(steps) {
  console.log(`[Demo Deploy] processStepImages called with ${steps?.length || 0} steps`);
  
  if (!steps || !Array.isArray(steps)) {
    console.log(`[Demo Deploy] No steps to process`);
    return steps;
  }
  
  const processedSteps = [];
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`[Demo Deploy] Processing step ${i + 1}: ${step.type}, has basic_props: ${!!step.basic_props}`);
    if (step.basic_props) {
      console.log(`[Demo Deploy] Step ${i + 1} basic_props keys: ${Object.keys(step.basic_props).join(', ')}`);
      console.log(`[Demo Deploy] Step ${i + 1} image_url: ${step.basic_props.image_url || 'none'}`);
    }
    const processedStep = { ...step };
    
    if (processedStep.basic_props) {
      const basicProps = { ...processedStep.basic_props };
      
      // Process image_url
      if (isOrganizationSpecificImage(basicProps.image_url)) {
        const newUrl = await copyImageToDemo(basicProps.image_url, i + 1, 'image');
        if (newUrl) {
          console.log(`[Demo Deploy] Step ${i + 1}: Updated image_url from ${basicProps.image_url} to ${newUrl}`);
          basicProps.image_url = newUrl;
        } else {
          console.log(`[Demo Deploy] Step ${i + 1}: Removing unavailable image_url: ${basicProps.image_url}`);
          basicProps.image_url = null;
          if (basicProps.media_type === 'image') {
            basicProps.media_type = 'text';
          }
        }
      }
      
      // Process media_url (for videos/other media)
      if (isOrganizationSpecificImage(basicProps.media_url)) {
        const newUrl = await copyImageToDemo(basicProps.media_url, i + 1, 'media');
        if (newUrl) {
          basicProps.media_url = newUrl;
        } else {
          basicProps.media_url = null;
        }
      }
      
      // Process background_image
      if (isOrganizationSpecificImage(basicProps.background_image)) {
        const newUrl = await copyImageToDemo(basicProps.background_image, i + 1, 'background');
        if (newUrl) {
          basicProps.background_image = newUrl;
        } else {
          basicProps.background_image = null;
        }
      }
      
      // Process panorama_url (for space steps)
      if (isOrganizationSpecificImage(basicProps.panorama_url)) {
        const newUrl = await copyImageToDemo(basicProps.panorama_url, i + 1, 'panorama');
        if (newUrl) {
          basicProps.panorama_url = newUrl;
        } else {
          basicProps.panorama_url = null;
        }
      }
      
      // Process floorplan_url (for space steps)
      if (isOrganizationSpecificImage(basicProps.floorplan_url)) {
        const newUrl = await copyImageToDemo(basicProps.floorplan_url, i + 1, 'floorplan');
        if (newUrl) {
          basicProps.floorplan_url = newUrl;
        } else {
          basicProps.floorplan_url = null;
        }
      }
      
      processedStep.basic_props = basicProps;
    }
    
    processedSteps.push(processedStep);
  }
  
  return processedSteps;
}

/**
 * Clear old demo images before deploying new ones
 */
function clearDemoImages() {
  try {
    if (fs.existsSync(DEMO_IMAGES_DIR)) {
      const files = fs.readdirSync(DEMO_IMAGES_DIR);
      for (const file of files) {
        const filePath = path.join(DEMO_IMAGES_DIR, file);
        fs.unlinkSync(filePath);
        console.log(`[Demo Deploy] Removed old demo image: ${file}`);
      }
    }
  } catch (err) {
    console.error(`[Demo Deploy] Error clearing demo images: ${err.message}`);
  }
}

/**
 * Get the demo journey for a specific language and role
 * @param {string} language - Language code (en, nl, de, fr, es)
 * @param {string|null} role - User role (admin, manager, editor, viewer) or null for general
 * @returns {Object|null} - Demo journey data or null if not found
 */
export async function getDemoJourney(language = 'en', role = null) {
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    language = 'en';
  }
  
  try {
    const result = await query(`
      SELECT * FROM demo_journeys 
      WHERE language = $1 
        AND (target_role = $2 OR target_role IS NULL)
        AND is_active = true
      ORDER BY target_role NULLS LAST
      LIMIT 1
    `, [language, role]);
    
    if (result.rows.length === 0) {
      if (language !== 'en') {
        return getDemoJourney('en', role);
      }
      return null;
    }
    
    return result.rows[0];
  } catch (err) {
    console.error('Error fetching demo journey:', err);
    return null;
  }
}

/**
 * Get all demo journeys (for admin management)
 * @returns {Array} - All demo journeys
 */
export async function getAllDemoJourneys() {
  try {
    const result = await query(`
      SELECT * FROM demo_journeys 
      WHERE is_active = true
      ORDER BY language, target_role NULLS FIRST
    `);
    return result.rows;
  } catch (err) {
    console.error('Error fetching all demo journeys:', err);
    return [];
  }
}

/**
 * Create or update a demo journey
 * @param {Object} data - Demo journey data
 * @returns {Object} - Created/updated demo journey
 */
export async function upsertDemoJourney(data) {
  const { language, target_role, title, description, cover_image_url, journey_data } = data;
  
  try {
    const result = await query(`
      INSERT INTO demo_journeys (language, target_role, title, description, cover_image_url, journey_data, version)
      VALUES ($1, $2, $3, $4, $5, $6, 1)
      ON CONFLICT (language, target_role) 
      DO UPDATE SET 
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        cover_image_url = EXCLUDED.cover_image_url,
        journey_data = EXCLUDED.journey_data,
        version = demo_journeys.version + 1,
        updated_at = NOW()
      RETURNING *
    `, [language, target_role || null, title, description, cover_image_url, JSON.stringify(journey_data)]);
    
    return result.rows[0];
  } catch (err) {
    console.error('Error upserting demo journey:', err);
    throw err;
  }
}

/**
 * Delete a demo journey
 * @param {string} id - Demo journey ID
 */
export async function deleteDemoJourney(id) {
  try {
    await query('DELETE FROM demo_journeys WHERE id = $1', [id]);
  } catch (err) {
    console.error('Error deleting demo journey:', err);
    throw err;
  }
}

/**
 * Get or create user onboarding state
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID
 * @returns {Object} - User onboarding state
 */
export async function getUserOnboardingState(userId, organizationId) {
  try {
    let result = await query(`
      SELECT * FROM user_onboarding WHERE user_id = $1
    `, [userId]);
    
    if (result.rows.length === 0) {
      result = await query(`
        INSERT INTO user_onboarding (user_id, organization_id)
        VALUES ($1, $2)
        RETURNING *
      `, [userId, organizationId]);
    }
    
    return result.rows[0];
  } catch (err) {
    console.error('Error getting user onboarding state:', err);
    return {
      has_seen_welcome: false,
      has_started_tour: false,
      has_completed_tour: false,
      has_skipped_tour: false,
      hints_shown: {}
    };
  }
}

/**
 * Update user onboarding state
 * @param {string} userId - User ID
 * @param {Object} updates - Fields to update
 * @returns {Object} - Updated onboarding state
 */
export async function updateUserOnboardingState(userId, updates) {
  const allowedFields = [
    'has_seen_welcome', 'has_started_tour', 'has_completed_tour', 
    'has_skipped_tour', 'demo_journey_version', 'hints_shown',
    'welcome_seen_at', 'tour_started_at', 'tour_completed_at'
  ];
  
  const setClause = [];
  const values = [];
  let paramIndex = 1;
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClause.push(`${key} = $${paramIndex}`);
      values.push(key === 'hints_shown' ? JSON.stringify(value) : value);
      paramIndex++;
    }
  }
  
  if (setClause.length === 0) {
    return getUserOnboardingState(userId);
  }
  
  setClause.push('updated_at = NOW()');
  values.push(userId);
  
  try {
    const result = await query(`
      UPDATE user_onboarding 
      SET ${setClause.join(', ')}
      WHERE user_id = $${paramIndex}
      RETURNING *
    `, values);
    
    return result.rows[0];
  } catch (err) {
    console.error('Error updating user onboarding state:', err);
    throw err;
  }
}

/**
 * Check if user should see the onboarding welcome modal
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID
 * @returns {boolean} - True if welcome modal should be shown
 */
export async function shouldShowWelcome(userId, organizationId) {
  const state = await getUserOnboardingState(userId, organizationId);
  return !state.has_seen_welcome && !state.has_skipped_tour && !state.has_completed_tour;
}

/**
 * Mark a contextual hint as shown
 * @param {string} userId - User ID
 * @param {string} hintId - Hint identifier
 */
export async function markHintShown(userId, hintId) {
  try {
    const state = await query(`SELECT hints_shown FROM user_onboarding WHERE user_id = $1`, [userId]);
    if (state.rows.length === 0) return;
    
    const hints = state.rows[0].hints_shown || {};
    hints[hintId] = new Date().toISOString();
    
    await query(`
      UPDATE user_onboarding 
      SET hints_shown = $1, updated_at = NOW()
      WHERE user_id = $2
    `, [JSON.stringify(hints), userId]);
  } catch (err) {
    console.error('Error marking hint as shown:', err);
  }
}

/**
 * Check if a hint has been shown
 * @param {string} userId - User ID
 * @param {string} hintId - Hint identifier
 * @returns {boolean} - True if hint was already shown
 */
export async function hasHintBeenShown(userId, hintId) {
  try {
    const state = await query(`SELECT hints_shown FROM user_onboarding WHERE user_id = $1`, [userId]);
    if (state.rows.length === 0) return false;
    
    const hints = state.rows[0].hints_shown || {};
    return !!hints[hintId];
  } catch (err) {
    console.error('Error checking hint state:', err);
    return false;
  }
}

/**
 * Convert a regular journey to demo journey format
 * Exports all steps, paths, and relevant data
 * @param {string} journeyId - Journey ID to export
 * @param {string} organizationId - Organization ID
 * @returns {Object} - Journey data in demo format
 */
export async function exportJourneyAsDemo(journeyId, organizationId) {
  try {
    const journeyResult = await query(`
      SELECT id, title, description, cover_image_url, settings
      FROM journeys 
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
    `, [journeyId, organizationId]);
    
    if (journeyResult.rows.length === 0) {
      throw new Error('Journey not found');
    }
    
    const journey = journeyResult.rows[0];
    
    const stepsResult = await query(`
      SELECT id, type, title, position_x, position_y, is_start, is_end, basic_props, advanced_props
      FROM steps 
      WHERE journey_id = $1
      ORDER BY created_at
    `, [journeyId]);
    
    const pathsResult = await query(`
      SELECT id, from_step_id, to_step_id, label, description, icon, sort_order
      FROM paths 
      WHERE journey_id = $1
      ORDER BY sort_order
    `, [journeyId]);
    
    return {
      title: journey.title,
      description: journey.description,
      cover_image_url: journey.cover_image_url,
      settings: journey.settings,
      steps: stepsResult.rows,
      paths: pathsResult.rows
    };
  } catch (err) {
    console.error('Error exporting journey as demo:', err);
    throw err;
  }
}

/**
 * Import demo journey data and create a virtual journey object
 * This creates a journey-like object that can be displayed in the builder (read-only)
 * @param {Object} demoJourney - Demo journey from database
 * @returns {Object} - Journey object compatible with builder
 */
export function createVirtualJourneyFromDemo(demoJourney) {
  const data = demoJourney.journey_data || {};
  
  return {
    id: `demo-${demoJourney.id}`,
    title: demoJourney.title,
    description: demoJourney.description,
    cover_image_url: demoJourney.cover_image_url,
    status: 'published',
    settings: data.settings || {},
    is_demo: true,
    demo_id: demoJourney.id,
    demo_version: demoJourney.version,
    demo_language: demoJourney.language,
    steps: (data.steps || []).map(step => ({
      ...step,
      id: step.id,
      journey_id: `demo-${demoJourney.id}`
    })),
    paths: (data.paths || []).map(path => ({
      ...path,
      journey_id: `demo-${demoJourney.id}`
    }))
  };
}

/**
 * Deploy a journey as the official demo journey for all languages
 * This exports a journey, normalizes IDs, translates to all languages, and saves to demo_journeys
 * @param {string} journeyId - Journey ID to deploy
 * @param {string} organizationId - Organization ID
 * @param {Function} onProgress - Progress callback (message, percentage)
 * @returns {Object} - Deployment result with created demo journeys
 */
export async function deployJourneyAsDemo(journeyId, organizationId, onProgress = () => {}) {
  const { translateJourneyContent } = await import('./translation.js');
  
  try {
    onProgress('Exporting journey...', 5);
    
    // Export the source journey
    const sourceData = await exportJourneyAsDemo(journeyId, organizationId);
    
    if (!sourceData || !sourceData.steps || sourceData.steps.length === 0) {
      throw new Error('Journey has no steps or could not be exported');
    }
    
    onProgress('Normalizing step IDs...', 10);
    
    // Create ID mapping for steps and paths
    const stepIdMap = {};
    const pathIdMap = {};
    
    sourceData.steps.forEach((step, index) => {
      const newId = `demo-step-${index + 1}`;
      stepIdMap[step.id] = newId;
    });
    
    sourceData.paths.forEach((path, index) => {
      const newId = `demo-path-${index + 1}`;
      pathIdMap[path.id] = newId;
    });
    
    // Normalize steps with new IDs
    let normalizedSteps = sourceData.steps.map((step, _index) => ({
      id: stepIdMap[step.id],
      type: step.type,
      title: step.title,
      position_x: step.position_x,
      position_y: step.position_y,
      is_start: step.is_start,
      is_end: step.is_end,
      basic_props: step.basic_props || {},
      advanced_props: step.advanced_props || {}
    }));
    
    // Clear old demo images and copy new ones to public directory
    onProgress('Processing images for demo journey...', 12);
    clearDemoImages();
    normalizedSteps = await processStepImages(normalizedSteps);
    
    // Normalize paths with new IDs
    const normalizedPaths = sourceData.paths.map((path, _index) => ({
      id: pathIdMap[path.id],
      from_step_id: stepIdMap[path.from_step_id],
      to_step_id: stepIdMap[path.to_step_id],
      label: path.label || '',
      description: path.description || '',
      icon: path.icon || null,
      sort_order: path.sort_order || 0
    }));
    
    // Copy cover image to public demo directory if it's organization-specific
    let coverImageUrl = sourceData.cover_image_url;
    if (isOrganizationSpecificImage(coverImageUrl)) {
      onProgress('Processing cover image...', 14);
      const newCoverUrl = await copyCoverImageToDemo(coverImageUrl);
      if (newCoverUrl) {
        console.log(`[Demo Deploy] Updated cover image from ${coverImageUrl} to ${newCoverUrl}`);
        coverImageUrl = newCoverUrl;
      } else {
        console.log(`[Demo Deploy] Could not copy cover image, removing: ${coverImageUrl}`);
        coverImageUrl = null;
      }
    }
    
    // Create English base content
    const baseContent = {
      title: sourceData.title,
      description: sourceData.description || '',
      cover_image_url: coverImageUrl,
      settings: sourceData.settings || {},
      steps: normalizedSteps,
      paths: normalizedPaths
    };
    
    onProgress('Deactivating old demo journeys...', 15);
    
    // Deactivate all existing demo journeys
    await query('UPDATE demo_journeys SET is_active = false WHERE is_active = true');
    
    const results = [];
    const languages = ['en', 'nl', 'de', 'fr', 'es'];
    
    for (let i = 0; i < languages.length; i++) {
      const lang = languages[i];
      const progressBase = 20 + (i * 16); // 20-100 spread across languages
      
      let contentToSave;
      
      if (lang === 'en') {
        onProgress(`Saving English version...`, progressBase);
        contentToSave = baseContent;
      } else {
        onProgress(`Translating to ${lang.toUpperCase()}...`, progressBase);
        
        try {
          // Prepare data for translation service
          // IMPORTANT: Include step.type so the translation service knows which fields to translate
          const journeyDataForTranslation = {
            journey: {
              title: baseContent.title,
              description: baseContent.description
            },
            steps: normalizedSteps.map(step => ({
              id: step.id,
              type: step.type,  // Required for translation service to know which fields to translate
              title: step.title,
              basic_props: step.basic_props,
              advanced_props: step.advanced_props
            })),
            paths: normalizedPaths.map(path => ({
              id: path.id,
              label: path.label,
              description: path.description
            })),
            resources: []
          };
          
          const translated = await translateJourneyContent(
            journeyDataForTranslation, 
            lang, 
            'en',
            (p) => onProgress(`Translating to ${lang.toUpperCase()}... ${p}%`, progressBase + Math.floor(p * 0.15))
          );
          
          // Merge translated content back
          contentToSave = {
            title: translated.journey.title,
            description: translated.journey.description || '',
            cover_image_url: baseContent.cover_image_url,
            settings: baseContent.settings,
            steps: normalizedSteps.map(step => {
              const translatedStep = translated.steps.find(s => s.id === step.id);
              return {
                ...step,
                title: translatedStep?.title || step.title,
                basic_props: translatedStep?.basic_props || step.basic_props,
                advanced_props: translatedStep?.advanced_props || step.advanced_props
              };
            }),
            paths: normalizedPaths.map(path => {
              const translatedPath = translated.paths.find(p => p.id === path.id);
              return {
                ...path,
                label: translatedPath?.label || path.label,
                description: translatedPath?.description || path.description
              };
            })
          };
          
          // Apply Gryffi-specific terminology corrections
          onProgress(`Applying Gryffi terminology for ${lang.toUpperCase()}...`, progressBase + 11);
          contentToSave = applyGryffiTerminologyToContent(contentToSave, lang);
        } catch (translationError) {
          console.error(`Translation to ${lang} failed:`, translationError);
          onProgress(`Translation to ${lang.toUpperCase()} failed, using English...`, progressBase + 10);
          contentToSave = baseContent;
        }
      }
      
      onProgress(`Saving ${lang.toUpperCase()} version...`, progressBase + 12);
      
      // Insert new demo journey
      const insertResult = await query(`
        INSERT INTO demo_journeys (language, title, description, cover_image_url, journey_data, version, is_active)
        VALUES ($1, $2, $3, $4, $5, 1, true)
        RETURNING id, language, title
      `, [
        lang,
        contentToSave.title,
        contentToSave.description,
        contentToSave.cover_image_url,
        JSON.stringify({
          steps: contentToSave.steps,
          paths: contentToSave.paths,
          settings: contentToSave.settings
        })
      ]);
      
      results.push(insertResult.rows[0]);
    }
    
    onProgress('Demo journey deployment complete!', 100);
    
    return {
      success: true,
      source_journey_id: journeyId,
      deployed_languages: results,
      step_count: normalizedSteps.length,
      path_count: normalizedPaths.length
    };
    
  } catch (err) {
    console.error('Error deploying journey as demo:', err);
    throw err;
  }
}

/**
 * Export current demo journeys from database to JavaScript code
 * This generates code that can replace getDefaultDemoJourneyContent()
 * Used for syncing demo journey content to production via code deployment
 * @returns {Object} - { code: string, languages: string[] }
 */
export async function exportDemoJourneysToCode() {
  try {
    const demoJourneys = await getAllDemoJourneys();
    
    if (!demoJourneys || demoJourneys.length === 0) {
      throw new Error('No demo journeys found in database');
    }
    
    // Build the content object
    const contentObj = {};
    
    for (const demo of demoJourneys) {
      const data = demo.journey_data || {};
      contentObj[demo.language] = {
        title: demo.title,
        description: demo.description || '',
        steps: data.steps || [],
        paths: data.paths || []
      };
    }
    
    // Generate JavaScript code with proper escaping
    const escapeForJS = (str) => {
      if (typeof str !== 'string') return str;
      return str
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n');
    };
    
    const formatValue = (val, indent = 0) => {
      const spaces = '  '.repeat(indent);
      
      if (val === null || val === undefined) return 'null';
      if (typeof val === 'boolean') return val.toString();
      if (typeof val === 'number') return val.toString();
      if (typeof val === 'string') return `'${escapeForJS(val)}'`;
      
      if (Array.isArray(val)) {
        if (val.length === 0) return '[]';
        const items = val.map(v => formatValue(v, indent + 1));
        return `[\n${spaces}  ${items.join(`,\n${spaces}  `)}\n${spaces}]`;
      }
      
      if (typeof val === 'object') {
        const entries = Object.entries(val);
        if (entries.length === 0) return '{}';
        const props = entries.map(([k, v]) => {
          const key = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : `'${k}'`;
          return `${key}: ${formatValue(v, indent + 1)}`;
        });
        return `{\n${spaces}  ${props.join(`,\n${spaces}  `)}\n${spaces}}`;
      }
      
      return String(val);
    };
    
    // Generate the content for each language
    let code = `/**
 * Get the default demo journey content for initial setup
 * @param {string} language - Language code
 * @returns {Object} - Default demo journey content
 * 
 * AUTO-GENERATED - Do not edit manually!
 * Generated from database on: ${new Date().toISOString()}
 * Use admin-cli/gryffi-admin.sh -> Testing & Debug -> Export demo journey to code
 */
export function getDefaultDemoJourneyContent(language = 'en') {
  const content = {\n`;
    
    const languages = Object.keys(contentObj).sort((a, b) => {
      // English first, then alphabetical
      if (a === 'en') return -1;
      if (b === 'en') return 1;
      return a.localeCompare(b);
    });
    
    for (const lang of languages) {
      const langContent = contentObj[lang];
      code += `    ${lang}: ${formatValue(langContent, 2)},\n`;
    }
    
    code += `  };
  
  return content[language] || content.en;
}`;
    
    return {
      code,
      languages: languages,
      journey_count: demoJourneys.length
    };
    
  } catch (err) {
    console.error('Error exporting demo journeys to code:', err);
    throw err;
  }
}

/**
 * Get the default demo journey content for initial setup
 * @param {string} language - Language code
 * @returns {Object} - Default demo journey content
 * 
 * AUTO-GENERATED - Do not edit manually!
 * Generated from database on: 2026-03-02T13:43:59.185Z
 * Use admin-cli/gryffi-admin.sh -> Testing & Debug -> Export demo journey to code
 */
export function getDefaultDemoJourneyContent(language = 'en') {
  const content = {
    en: {
      title: 'Demo Journey',
      description: 'This is a demo journey',
      steps: [
        {
          id: 'demo-step-1',
          type: 'content',
          title: 'This is a journey',
          is_end: false,
          is_start: true,
          position_x: 35,
          position_y: 175,
          basic_props: {
            body: '<blockquote data-path-to-node="2"><p data-path-to-node="2,0">Welcome to Gryffi. This is a preview of the exact experience your end users will have. <br><br>Would you prefer the short or the full-length journey?</p></blockquote><h3 data-path-to-node="3"></h3>',
            image_url: '/images/demo/step-1-image.png',
            video_url: '',
            media_type: 'image',
            text_position: 'below',
            media_description: 'Welcome to Gryffi. This is a preview of the exact experience your end users will have.\n\nWould you prefer the short or the full-length journey?\n'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-2',
          type: 'space',
          title: 'Space Step',
          is_end: false,
          is_start: false,
          position_x: 321,
          position_y: 168,
          basic_props: {
            floorplan: {
              enabled: false
            },
            image_url: '/images/demo/step-2-image.jpg',
            description: 'This is a Space Step, used for creating virtual tours. You can use standard images or 360-degree panoramas for a more immersive experience. There is also an option to include an interactive map for better orientation.',
            is_panorama: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-3',
          type: 'challenge',
          title: 'Challenge Step',
          is_end: false,
          is_start: false,
          position_x: 584,
          position_y: 168,
          basic_props: {
            type: 'multiple_choice',
            questions: [
              {
                id: '41d3eca2-72cb-4a5e-8a8a-f926f24d3c88',
                options: [
                  {
                    id: 'a',
                    text: 'Coding platform',
                    correct: false
                  },
                  {
                    id: 'b',
                    text: 'Platform for employee engagement',
                    correct: true
                  },
                  {
                    id: 'c',
                    text: 'Online document editor',
                    correct: false
                  },
                  {
                    id: 'd',
                    text: 'AI image generator',
                    correct: false
                  }
                ],
                question: 'This is a Challenge Step. Use it to create quizzes with one or more questions. For example:\n\nWhich of the following is true about Gryffi? Gryffi is a...'
              }
            ]
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-4',
          type: 'form',
          title: 'Form Step',
          is_end: false,
          is_start: false,
          position_x: 859,
          position_y: 160,
          basic_props: {
            fields: [
              {
                id: '87810c69-36c4-4604-931d-1842272152cc',
                type: 'text',
                label: 'Full name',
                options: '',
                required: true,
                fileSubtype: null
              },
              {
                id: 'be4db3a4-f7de-4ca9-b116-55d31c361cff',
                type: 'select',
                label: 'What will you be using Gryffi for?',
                options: 'New Hire Onboarding,Compliance & Safety Training,Facility Tours & Site Induction,Product Knowledge Training,Standard Operating Procedures,Internal Knowledge Sharing,Customer Education,Other',
                required: true,
                fileSubtype: null
              }
            ],
            description: 'This is a Form Step. Use it to collect essential data from your end users, which is particularly useful for tasks like onboarding new personnel.',
            email_subject: 'Formulierinzending: {{journey_title}}',
            recipient_email: ''
          },
          advanced_props: {
            assistant_guide_id: null,
            confirmation_message: 'Thank you! Your form has been sent.',
            completion_requirement: 'after_submit'
          }
        },
        {
          id: 'demo-step-5',
          type: 'poll',
          title: 'Poll Step',
          is_end: false,
          is_start: false,
          position_x: 1114,
          position_y: 156,
          basic_props: {
            options: [
              {
                id: 'ccbbc74c-9862-449b-8e2c-d00f9f133f1d',
                text: 'Italian food'
              },
              {
                id: '93358173-94b4-4ee2-a65e-dda5bd8b1412',
                text: 'Chinese food'
              },
              {
                id: 'd8f0a390-701c-49d3-a1d3-772d43b75243',
                text: 'Thai food'
              },
              {
                id: '8943db0a-37e3-4a2a-a77f-fd5af17d5e1c',
                text: 'Fast food'
              },
              {
                id: 'e8323903-55f3-45d2-a89d-9aadd425b39c',
                text: 'Sandwiches'
              }
            ],
            question: 'This is a Poll Step. Use it to collect feedback from users, with all data tracked in the analytics section. Here is an example: \n\nWhat kind of food would you like to have added to the staff canteen menu?',
            is_required: true,
            show_results: true,
            allow_multiple: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-6',
          type: 'content',
          title: 'More steps',
          is_end: false,
          is_start: false,
          position_x: 1125,
          position_y: 337,
          basic_props: {
            body: 'There are even more steps possible in a Gryffi journey:<br><b data-path-to-node="4,0,0" data-index-in-node="0"><br>Guide Step</b>: Integrate an AI-powered Guide into the journey to answer questions based on your specific knowledge base.<div><br><b data-path-to-node="4,1,0" data-index-in-node="0">Content Step</b>: Add text, images, or videos to deliver information and training materials effectively.<br><b data-path-to-node="4,2,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,2,0" data-index-in-node="0">Reward Step</b>: Provide users with coupon codes or real-world incentives upon completing the journey.<br><b data-path-to-node="4,3,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,3,0" data-index-in-node="0">Sub step</b>: Embed a journey within another to create modular and reusable training paths.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-7',
          type: 'content',
          title: 'The end of this demo journey',
          is_end: true,
          is_start: false,
          position_x: 1120,
          position_y: 510,
          basic_props: {
            body: '',
            image_url: '/images/demo/step-7-image.jpg',
            video_url: '',
            media_type: 'image',
            text_position: 'above',
            media_description: 'Thank you for exploring how to build journeys in Gryffi. Now that you have completed this experience, you can see exactly how it was constructed within the visual journey builder. You can close this journey now.'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-8',
          type: 'content',
          title: 'Journey Steps',
          is_end: false,
          is_start: false,
          position_x: 360,
          position_y: 430,
          basic_props: {
            body: '<div><b>Space Step</b>: Visualize physical locations using standard images, 360° panoramas, or interactive floor plans with hotspots.</div><div><br></div><div><b>Challenge Step</b>: Evaluate knowledge using multiple-choice quizzes with configurable passing scores and retry logic.</div><div><br></div><div><b>Form Step</b>: Collect structured data and file uploads from participants through customizable input fields.</div><div><br></div><div><b>Poll Step</b>: Gather instant feedback or sentiment via single-question surveys tracked in the analytics dashboard.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        }
      ],
      paths: [
        {
          id: 'demo-path-1',
          icon: 'arrow-right',
          label: 'Full-length journey',
          sort_order: 0,
          to_step_id: 'demo-step-2',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-2',
          icon: 'arrow-right',
          label: 'Take a quiz',
          sort_order: 0,
          to_step_id: 'demo-step-3',
          description: '',
          from_step_id: 'demo-step-2'
        },
        {
          id: 'demo-path-3',
          icon: 'arrow-right',
          label: 'Go to the form',
          sort_order: 0,
          to_step_id: 'demo-step-4',
          description: '',
          from_step_id: 'demo-step-3'
        },
        {
          id: 'demo-path-4',
          icon: 'arrow-right',
          label: 'Poll step is next',
          sort_order: 0,
          to_step_id: 'demo-step-5',
          description: '',
          from_step_id: 'demo-step-4'
        },
        {
          id: 'demo-path-5',
          icon: 'arrow-right',
          label: 'Even more steps',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-5'
        },
        {
          id: 'demo-path-6',
          icon: 'arrow-right',
          label: 'Finish the tour',
          sort_order: 0,
          to_step_id: 'demo-step-7',
          description: '',
          from_step_id: 'demo-step-6'
        },
        {
          id: 'demo-path-7',
          icon: 'arrow-right',
          label: 'Short journey',
          sort_order: 0,
          to_step_id: 'demo-step-8',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-8',
          icon: 'arrow-right',
          label: 'Even more steps',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-8'
        }
      ]
    },
    de: {
      title: 'Demo-Expedition',
      description: 'Dies ist eine Demo-Expedition',
      steps: [
        {
          id: 'demo-step-1',
          type: 'content',
          title: 'Dies ist eine Expedition',
          is_end: false,
          is_start: true,
          position_x: 35,
          position_y: 175,
          basic_props: {
            body: '<blockquote data-path-to-node="2"><p data-path-to-node="2,0">Willkommen bei Gryffi. Dies ist eine Vorschau auf das genaue Erlebnis, das Ihre Endbenutzer haben werden. <br><br>Möchten Sie die kurze oder die ausführliche Expedition?</p></blockquote><h3 data-path-to-node="3"></h3>',
            image_url: '/images/demo/step-1-image.png',
            video_url: '',
            media_type: 'image',
            text_position: 'below',
            media_description: 'Willkommen bei Gryffi. Dies ist eine Vorschau auf das genaue Erlebnis, das Ihre Endbenutzer haben werden.\n\nMöchten Sie die kurze oder die ausführliche Expedition?'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-2',
          type: 'space',
          title: 'Raum-Schritt',
          is_end: false,
          is_start: false,
          position_x: 321,
          position_y: 168,
          basic_props: {
            floorplan: {
              enabled: false
            },
            image_url: '/images/demo/step-2-image.jpg',
            description: 'Dies ist ein Raum-Schritt, der zur Erstellung virtueller Touren verwendet wird. Sie können Standardbilder oder 360-Grad-Panoramen für ein immersiveres Erlebnis nutzen. Es besteht auch die Möglichkeit, eine interaktive Karte zur besseren Orientierung einzubinden.',
            is_panorama: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-3',
          type: 'challenge',
          title: 'Herausforderungs-Schritt',
          is_end: false,
          is_start: false,
          position_x: 584,
          position_y: 168,
          basic_props: {
            type: 'multiple_choice',
            questions: [
              {
                id: '41d3eca2-72cb-4a5e-8a8a-f926f24d3c88',
                options: [
                  {
                    id: 'a',
                    text: 'Codierungsplattform',
                    correct: false
                  },
                  {
                    id: 'b',
                    text: 'Plattform für Mitarbeiterengagement',
                    correct: true
                  },
                  {
                    id: 'c',
                    text: 'Online-Dokumenteditor',
                    correct: false
                  },
                  {
                    id: 'd',
                    text: 'KI-Bildgenerator',
                    correct: false
                  }
                ],
                question: 'Dit is een Uitdagingsstap. Gebruik deze om quizzen te maken met één of meerdere vragen. Bijvoorbeeld:\n\nWelche der folgenden Aussagen über Gryffi ist wahr? Gryffi ist ein...'
              }
            ]
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-4',
          type: 'form',
          title: 'Formular-Schritt',
          is_end: false,
          is_start: false,
          position_x: 859,
          position_y: 160,
          basic_props: {
            fields: [
              {
                id: '87810c69-36c4-4604-931d-1842272152cc',
                type: 'text',
                label: 'Vollständiger Name',
                options: '',
                required: true,
                fileSubtype: null
              },
              {
                id: 'be4db3a4-f7de-4ca9-b116-55d31c361cff',
                type: 'select',
                label: 'Wofür werden Sie Gryffi verwenden?',
                options: 'Einarbeitung neuer Mitarbeiter,Compliance- & Sicherheitsschulung,Führungen & Standortanweisungen,Produktschulung,Standardarbeitsanweisungen,Interner Wissensaustausch,Kundenschulung,Sonstiges',
                required: true,
                fileSubtype: null
              }
            ],
            description: 'Dies ist ein Formular-Schritt. Nutzen Sie ihn, um wichtige Daten von Ihren Endbenutzern zu sammeln, was besonders nützlich für Aufgaben wie die Einarbeitung neuer Mitarbeiter ist.',
            email_subject: 'Formulareinreichung: {{journey_title}}',
            recipient_email: ''
          },
          advanced_props: {
            assistant_guide_id: null,
            confirmation_message: 'Vielen Dank! Ihr Formular wurde gesendet.',
            completion_requirement: 'after_submit'
          }
        },
        {
          id: 'demo-step-5',
          type: 'poll',
          title: 'Umfrage-Schritt',
          is_end: false,
          is_start: false,
          position_x: 1114,
          position_y: 156,
          basic_props: {
            options: [
              {
                id: 'ccbbc74c-9862-449b-8e2c-d00f9f133f1d',
                text: 'Italienisches Essen'
              },
              {
                id: '93358173-94b4-4ee2-a65e-dda5bd8b1412',
                text: 'Chinesisches Essen'
              },
              {
                id: 'd8f0a390-701c-49d3-a1d3-772d43b75243',
                text: 'Thailändisches Essen'
              },
              {
                id: '8943db0a-37e3-4a2a-a77f-fd5af17d5e1c',
                text: 'Fast Food'
              },
              {
                id: 'e8323903-55f3-45d2-a89d-9aadd425b39c',
                text: 'Belegte Brötchen'
              }
            ],
            question: 'Dies ist ein Umfrage-Schritt. Nutzen Sie ihn, um Feedback von Nutzern einzuholen, wobei alle Daten im Analytics-Bereich erfasst werden. Hier ein Beispiel:\n\nWelche Art von Essen möchten Sie im Mitarbeiter-Casino-Menü ergänzt haben?',
            is_required: true,
            show_results: true,
            allow_multiple: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-6',
          type: 'content',
          title: 'Weitere Schritte',
          is_end: false,
          is_start: false,
          position_x: 1125,
          position_y: 337,
          basic_props: {
            body: 'In einer Gryffi-Expedition sind noch mehr Schritte möglich:<br><b data-path-to-node="4,0,0" data-index-in-node="0"><br>Begleiter-Schritt</b>: Integrieren Sie einen KI-gestützten Begleiter in die Expedition, um Fragen basierend auf Ihrer spezifischen Wissensdatenbank zu beantworten.<div><br><b data-path-to-node="4,1,0" data-index-in-node="0">Inhalts-Schritt</b>: Fügen Sie Texte, Bilder oder Videos hinzu, um Informationen und Schulungsmaterialien effektiv zu vermitteln.<br><b data-path-to-node="4,2,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,2,0" data-index-in-node="0">Belohnungs-Schritt</b>: Geben Sie Nutzern Gutscheincodes oder reale Anreize nach Abschluss der Expedition.<br><b data-path-to-node="4,3,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,3,0" data-index-in-node="0">Unterschritt</b>: Betten Sie eine Expedition in eine andere ein, um modulare und wiederverwendbare Schulungspfade zu erstellen.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-7',
          type: 'content',
          title: 'Ende dieser Demo-Expedition',
          is_end: true,
          is_start: false,
          position_x: 1120,
          position_y: 510,
          basic_props: {
            body: '',
            image_url: '/images/demo/step-7-image.jpg',
            video_url: '',
            media_type: 'image',
            text_position: 'above',
            media_description: 'Vielen Dank, dass Sie erkundet haben, wie man Expeditionen in Gryffi erstellt. Nachdem Sie diese Erfahrung abgeschlossen haben, können Sie genau sehen, wie sie im visuellen Expedition-Builder aufgebaut wurde. Sie können diese Expedition jetzt schließen.'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-8',
          type: 'content',
          title: 'Expedition-Schritte',
          is_end: false,
          is_start: false,
          position_x: 360,
          position_y: 430,
          basic_props: {
            body: '<div><b>Raum-Schritt</b>: Visualisieren Sie physische Standorte mithilfe von Standardbildern, 360°-Panoramen oder interaktiven Grundrissen mit Hotspots.</div><div><br></div><div><b>Quiz-Schritt</b>: Überprüfen Sie Wissen mit Multiple-Choice-Quizzen, die konfigurierbare Bestehensgrenzen und Wiederholungslogik bieten.</div><div><br></div><div><b>Formular-Schritt</b>: Erfassen Sie strukturierte Daten und Datei-Uploads von Teilnehmern über anpassbare Eingabefelder.</div><div><br></div><div><b>Umfrage-Schritt</b>: Sammeln Sie sofortiges Feedback oder Stimmungsbilder über Einzelfragen-Umfragen, die im Analytics-Dashboard nachverfolgt werden.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        }
      ],
      paths: [
        {
          id: 'demo-path-1',
          icon: 'arrow-right',
          label: 'Vollständige Expedition',
          sort_order: 0,
          to_step_id: 'demo-step-2',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-2',
          icon: 'arrow-right',
          label: 'Nehmen Sie an einem Quiz teil',
          sort_order: 0,
          to_step_id: 'demo-step-3',
          description: '',
          from_step_id: 'demo-step-2'
        },
        {
          id: 'demo-path-3',
          icon: 'arrow-right',
          label: 'Zum Formular gehen',
          sort_order: 0,
          to_step_id: 'demo-step-4',
          description: '',
          from_step_id: 'demo-step-3'
        },
        {
          id: 'demo-path-4',
          icon: 'arrow-right',
          label: 'Als Nächstes folgt ein Umfrage-Schritt',
          sort_order: 0,
          to_step_id: 'demo-step-5',
          description: '',
          from_step_id: 'demo-step-4'
        },
        {
          id: 'demo-path-5',
          icon: 'arrow-right',
          label: 'Noch mehr Schritte',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-5'
        },
        {
          id: 'demo-path-6',
          icon: 'arrow-right',
          label: 'Tour beenden',
          sort_order: 0,
          to_step_id: 'demo-step-7',
          description: '',
          from_step_id: 'demo-step-6'
        },
        {
          id: 'demo-path-7',
          icon: 'arrow-right',
          label: 'Kurze Expedition',
          sort_order: 0,
          to_step_id: 'demo-step-8',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-8',
          icon: 'arrow-right',
          label: 'Noch mehr Schritte',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-8'
        }
      ]
    },
    es: {
      title: 'Demo Expedición',
      description: 'Este es un expedición de demostración',
      steps: [
        {
          id: 'demo-step-1',
          type: 'content',
          title: 'Este es un expedición',
          is_end: false,
          is_start: true,
          position_x: 35,
          position_y: 175,
          basic_props: {
            body: '<blockquote data-path-to-node="2"><p data-path-to-node="2,0">Bienvenido a Gryffi. Esta es una vista previa de la experiencia exacta que tendrán tus usuarios finales. <br><br>¿Prefieres el expedición corto o el de duración completa?</p></blockquote><h3 data-path-to-node="3"></h3>',
            image_url: '/images/demo/step-1-image.png',
            video_url: '',
            media_type: 'image',
            text_position: 'below',
            media_description: 'Bienvenido a Gryffi. Esta es una vista previa de la experiencia exacta que tendrán tus usuarios finales.\n\n¿Prefieres el expedición corto o el de duración completa?'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-2',
          type: 'space',
          title: 'Paso Espacial',
          is_end: false,
          is_start: false,
          position_x: 321,
          position_y: 168,
          basic_props: {
            floorplan: {
              enabled: false
            },
            image_url: '/images/demo/step-2-image.jpg',
            description: 'Este es un Paso Espacial, utilizado para crear tours virtuales. Puedes usar imágenes estándar o panorámicas de 360 grados para una experiencia más inmersiva. También hay una opción para incluir un mapa interactivo que mejore la orientación.',
            is_panorama: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-3',
          type: 'challenge',
          title: 'Paso de Desafío',
          is_end: false,
          is_start: false,
          position_x: 584,
          position_y: 168,
          basic_props: {
            type: 'multiple_choice',
            questions: [
              {
                id: '41d3eca2-72cb-4a5e-8a8a-f926f24d3c88',
                options: [
                  {
                    id: 'a',
                    text: 'Plataforma de codificación',
                    correct: false
                  },
                  {
                    id: 'b',
                    text: 'Plataforma de compromiso de empleados',
                    correct: true
                  },
                  {
                    id: 'c',
                    text: 'Editor de documentos en línea',
                    correct: false
                  },
                  {
                    id: 'd',
                    text: 'Generador de imágenes con IA',
                    correct: false
                  }
                ],
                question: 'Dit is een Uitdagingsstap. Gebruik deze om quizzen te maken met één of meerdere vragen. Bijvoorbeeld:\n\nWelche der folgenden Aussagen über Gryffi ist wahr? Gryffi ist ein...'
              }
            ]
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-4',
          type: 'form',
          title: 'Paso de Formulario',
          is_end: false,
          is_start: false,
          position_x: 859,
          position_y: 160,
          basic_props: {
            fields: [
              {
                id: '87810c69-36c4-4604-931d-1842272152cc',
                type: 'text',
                label: 'Nombre completo',
                options: '',
                required: true,
                fileSubtype: null
              },
              {
                id: 'be4db3a4-f7de-4ca9-b116-55d31c361cff',
                type: 'select',
                label: '¿Para qué vas a utilizar Gryffi?',
                options: 'Incorporación de nuevos empleados, Formación en cumplimiento y seguridad, Visitas e instrucciones del sitio, Formación de productos, Instrucciones de trabajo estandarizadas, Compartir conocimientos internos, Formación de clientes, Otro',
                required: true,
                fileSubtype: null
              }
            ],
            description: 'Este es un Paso de Formulario. Úsalo para recopilar datos esenciales de tus usuarios finales, lo cual es especialmente útil para tareas como la incorporación de nuevo personal.',
            email_subject: 'Envío de formulario: {{journey_title}}',
            recipient_email: ''
          },
          advanced_props: {
            assistant_guide_id: null,
            confirmation_message: '¡Gracias! Tu formulario ha sido enviado.',
            completion_requirement: 'after_submit'
          }
        },
        {
          id: 'demo-step-5',
          type: 'poll',
          title: 'Paso de Encuesta',
          is_end: false,
          is_start: false,
          position_x: 1114,
          position_y: 156,
          basic_props: {
            options: [
              {
                id: 'ccbbc74c-9862-449b-8e2c-d00f9f133f1d',
                text: 'Cocina italiana'
              },
              {
                id: '93358173-94b4-4ee2-a65e-dda5bd8b1412',
                text: 'Cocina china'
              },
              {
                id: 'd8f0a390-701c-49d3-a1d3-772d43b75243',
                text: 'Cocina tailandesa'
              },
              {
                id: '8943db0a-37e3-4a2a-a77f-fd5af17d5e1c',
                text: 'Comida rápida'
              },
              {
                id: 'e8323903-55f3-45d2-a89d-9aadd425b39c',
                text: 'Sándwiches rellenos'
              }
            ],
            question: 'Este es un Paso de Encuesta. Úsalo para recopilar comentarios de los usuarios, con todos los datos registrados en la sección de análisis. Aquí tienes un ejemplo:\n\n¿Qué tipo de comida te gustaría que se añadiera al menú de la cantina del personal?',
            is_required: true,
            show_results: true,
            allow_multiple: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-6',
          type: 'content',
          title: 'Más pasos',
          is_end: false,
          is_start: false,
          position_x: 1125,
          position_y: 337,
          basic_props: {
            body: 'Hay aún más pasos posibles en un recorrido de Gryffi:<br><b data-path-to-node="4,0,0" data-index-in-node="0"><br>Paso de Guía</b>: Integra una Guía impulsada por IA en el recorrido para responder preguntas basadas en tu base de conocimiento específica.<div><br><b data-path-to-node="4,1,0" data-index-in-node="0">Paso de Contenido</b>: Añade texto, imágenes o videos para entregar información y materiales de formación de manera efectiva.<br><b data-path-to-node="4,2,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,2,0" data-index-in-node="0">Paso de Recompensa</b>: Proporciona a los usuarios códigos de cupón o incentivos del mundo real al completar el recorrido.<br><b data-path-to-node="4,3,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,3,0" data-index-in-node="0">Subpaso</b>: Incrusta un recorrido dentro de otro para crear rutas de formación modulares y reutilizables.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-7',
          type: 'content',
          title: 'Fin de este recorrido de demostración',
          is_end: true,
          is_start: false,
          position_x: 1120,
          position_y: 510,
          basic_props: {
            body: '',
            image_url: '/images/demo/step-7-image.jpg',
            video_url: '',
            media_type: 'image',
            text_position: 'above',
            media_description: 'Gracias por explorar cómo construir recorridos en Gryffi. Ahora que has completado esta experiencia, puedes ver exactamente cómo se construyó dentro del creador visual de recorridos. Puedes cerrar este recorrido ahora.'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-8',
          type: 'content',
          title: 'Pasos del Recorrido',
          is_end: false,
          is_start: false,
          position_x: 360,
          position_y: 430,
          basic_props: {
            body: '<div><b>Paso de Espacio</b>: Visualiza ubicaciones físicas utilizando imágenes estándar, panorámicas de 360° o planos interactivos con puntos de interés.</div><div><br></div><div><b>Paso de Desafío</b>: Evalúa conocimientos mediante cuestionarios de opción múltiple con puntuaciones de aprobación configurables y lógica de reintento.</div><div><br></div><div><b>Paso de Formulario</b>: Recopila datos estructurados y cargas de archivos de los participantes a través de campos de entrada personalizables.</div><div><br></div><div><b>Paso de Encuesta</b>: Recopila comentarios o sentimientos instantáneos mediante encuestas de una sola pregunta registradas en el panel de análisis.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        }
      ],
      paths: [
        {
          id: 'demo-path-1',
          icon: 'arrow-right',
          label: 'Recorrido completo',
          sort_order: 0,
          to_step_id: 'demo-step-2',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-2',
          icon: 'arrow-right',
          label: 'Realiza un cuestionario',
          sort_order: 0,
          to_step_id: 'demo-step-3',
          description: '',
          from_step_id: 'demo-step-2'
        },
        {
          id: 'demo-path-3',
          icon: 'arrow-right',
          label: 'Ir al formulario',
          sort_order: 0,
          to_step_id: 'demo-step-4',
          description: '',
          from_step_id: 'demo-step-3'
        },
        {
          id: 'demo-path-4',
          icon: 'arrow-right',
          label: 'El siguiente es el paso de encuesta',
          sort_order: 0,
          to_step_id: 'demo-step-5',
          description: '',
          from_step_id: 'demo-step-4'
        },
        {
          id: 'demo-path-5',
          icon: 'arrow-right',
          label: 'Aún más pasos',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-5'
        },
        {
          id: 'demo-path-6',
          icon: 'arrow-right',
          label: 'Finalizar el recorrido',
          sort_order: 0,
          to_step_id: 'demo-step-7',
          description: '',
          from_step_id: 'demo-step-6'
        },
        {
          id: 'demo-path-7',
          icon: 'arrow-right',
          label: 'Recorrido corto',
          sort_order: 0,
          to_step_id: 'demo-step-8',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-8',
          icon: 'arrow-right',
          label: 'Aún más pasos',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-8'
        }
      ]
    },
    fr: {
      title: 'Parcours de démonstration',
      description: 'Ceci est un parcours de démonstration',
      steps: [
        {
          id: 'demo-step-1',
          type: 'content',
          title: 'Ceci est un parcours',
          is_end: false,
          is_start: true,
          position_x: 35,
          position_y: 175,
          basic_props: {
            body: '<blockquote data-path-to-node="2"><p data-path-to-node="2,0">Bienvenue sur Gryffi. Voici un aperçu de l\'expérience exacte que vos utilisateurs finaux vivront. <br><br>Préférez-vous le parcours court ou complet ?</p></blockquote><h3 data-path-to-node="3"></h3>',
            image_url: '/images/demo/step-1-image.png',
            video_url: '',
            media_type: 'image',
            text_position: 'below',
            media_description: 'Bienvenue sur Gryffi. Voici un aperçu de l\'expérience exacte que vos utilisateurs finaux vivront.\n\nPréférez-vous le parcours court ou complet ?'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-2',
          type: 'space',
          title: 'Étape Espace',
          is_end: false,
          is_start: false,
          position_x: 321,
          position_y: 168,
          basic_props: {
            floorplan: {
              enabled: false
            },
            image_url: '/images/demo/step-2-image.jpg',
            description: 'Il s\'agit d\'une Étape Espace, utilisée pour créer des visites virtuelles. Vous pouvez utiliser des images standard ou des panoramas à 360 degrés pour une expérience plus immersive. Il existe également une option pour inclure une carte interactive afin d\'améliorer l\'orientation.',
            is_panorama: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-3',
          type: 'challenge',
          title: 'Étape Défi',
          is_end: false,
          is_start: false,
          position_x: 584,
          position_y: 168,
          basic_props: {
            type: 'multiple_choice',
            questions: [
              {
                id: '41d3eca2-72cb-4a5e-8a8a-f926f24d3c88',
                options: [
                  {
                    id: 'a',
                    text: 'Plateforme de codage',
                    correct: false
                  },
                  {
                    id: 'b',
                    text: 'Plateforme d\'engagement des employés',
                    correct: true
                  },
                  {
                    id: 'c',
                    text: 'Éditeur de documents en ligne',
                    correct: false
                  },
                  {
                    id: 'd',
                    text: 'Générateur d\'images par IA',
                    correct: false
                  }
                ],
                question: 'Dit is een Uitdagingsstap. Gebruik deze om quizzen te maken met één of meerdere vragen. Bijvoorbeeld:\n\nWelche der folgenden Aussagen über Gryffi ist wahr? Gryffi ist ein...'
              }
            ]
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-4',
          type: 'form',
          title: 'Étape Formulaire',
          is_end: false,
          is_start: false,
          position_x: 859,
          position_y: 160,
          basic_props: {
            fields: [
              {
                id: '87810c69-36c4-4604-931d-1842272152cc',
                type: 'text',
                label: 'Nom complet',
                options: '',
                required: true,
                fileSubtype: null
              },
              {
                id: 'be4db3a4-f7de-4ca9-b116-55d31c361cff',
                type: 'select',
                label: 'Pour quoi allez-vous utiliser Gryffi ?',
                options: 'Intégration de nouveaux employés,Formation en conformité et sécurité,Visites et instructions de site,Formation produit,Instructions de travail standardisées,Partage des connaissances internes,Formation client,Autre',
                required: true,
                fileSubtype: null
              }
            ],
            description: 'Il s\'agit d\'une Étape Formulaire. Utilisez-la pour collecter des données essentielles auprès de vos utilisateurs finaux, ce qui est particulièrement utile pour des tâches comme l\'intégration de nouveaux employés.',
            email_subject: 'Soumission du formulaire : {{journey_title}}',
            recipient_email: ''
          },
          advanced_props: {
            assistant_guide_id: null,
            confirmation_message: 'Merci ! Votre formulaire a été envoyé.',
            completion_requirement: 'after_submit'
          }
        },
        {
          id: 'demo-step-5',
          type: 'poll',
          title: 'Étape de sondage',
          is_end: false,
          is_start: false,
          position_x: 1114,
          position_y: 156,
          basic_props: {
            options: [
              {
                id: 'ccbbc74c-9862-449b-8e2c-d00f9f133f1d',
                text: 'Cuisine italienne'
              },
              {
                id: '93358173-94b4-4ee2-a65e-dda5bd8b1412',
                text: 'Cuisine chinoise'
              },
              {
                id: 'd8f0a390-701c-49d3-a1d3-772d43b75243',
                text: 'Cuisine thaïlandaise'
              },
              {
                id: '8943db0a-37e3-4a2a-a77f-fd5af17d5e1c',
                text: 'Fast-food'
              },
              {
                id: 'e8323903-55f3-45d2-a89d-9aadd425b39c',
                text: 'Sandwichs garnis'
              }
            ],
            question: 'Il s\'agit d\'une étape de sondage. Utilisez-la pour recueillir les retours des utilisateurs, toutes les données étant suivies dans la section analytique. Voici un exemple :\n\nQuel type de nourriture aimeriez-vous voir ajouté au menu de la cantine du personnel ?',
            is_required: true,
            show_results: true,
            allow_multiple: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-6',
          type: 'content',
          title: 'Plus d\'étapes',
          is_end: false,
          is_start: false,
          position_x: 1125,
          position_y: 337,
          basic_props: {
            body: 'Il est même possible d\'ajouter encore plus d\'étapes dans un parcours Gryffi :<br><b data-path-to-node="4,0,0" data-index-in-node="0"><br>Étape Guide</b> : Intégrez un Guide alimenté par IA dans le parcours pour répondre aux questions en fonction de votre base de connaissances spécifique.<div><br><b data-path-to-node="4,1,0" data-index-in-node="0">Étape Contenu</b> : Ajoutez du texte, des images ou des vidéos pour transmettre des informations et des supports de formation de manière efficace.<br><b data-path-to-node="4,2,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,2,0" data-index-in-node="0">Étape Récompense</b> : Offrez aux utilisateurs des codes de réduction ou des incitations réelles à la fin du parcours.<br><b data-path-to-node="4,3,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,3,0" data-index-in-node="0">Sous-étape</b> : Intégrez un parcours dans un autre pour créer des chemins de formation modulaires et réutilisables.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-7',
          type: 'content',
          title: 'Fin de ce parcours de démonstration',
          is_end: true,
          is_start: false,
          position_x: 1120,
          position_y: 510,
          basic_props: {
            body: '',
            image_url: '/images/demo/step-7-image.jpg',
            video_url: '',
            media_type: 'image',
            text_position: 'above',
            media_description: 'Merci d\'avoir exploré comment créer des parcours dans Gryffi. Maintenant que vous avez terminé cette expérience, vous pouvez voir exactement comment elle a été construite dans le générateur visuel de parcours. Vous pouvez fermer ce parcours maintenant.'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-8',
          type: 'content',
          title: 'Étapes du parcours',
          is_end: false,
          is_start: false,
          position_x: 360,
          position_y: 430,
          basic_props: {
            body: '<div><b>Étape Espace</b> : Visualisez des lieux physiques à l\'aide d\'images standard, de panoramas à 360° ou de plans interactifs avec des points d\'intérêt.</div><div><br></div><div><b>Étape Défi</b> : Évaluez les connaissances à l\'aide de quiz à choix multiples avec des scores de réussite configurables et une logique de réessai.</div><div><br></div><div><b>Étape Formulaire</b> : Collectez des données structurées et des téléchargements de fichiers auprès des participants via des champs de saisie personnalisables.</div><div><br></div><div><b>Étape Sondage</b> : Recueillez des retours instantanés ou des sentiments via des enquêtes à question unique suivies dans le tableau de bord analytique.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        }
      ],
      paths: [
        {
          id: 'demo-path-1',
          icon: 'arrow-right',
          label: 'Parcours complet',
          sort_order: 0,
          to_step_id: 'demo-step-2',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-2',
          icon: 'arrow-right',
          label: 'Passer un quiz',
          sort_order: 0,
          to_step_id: 'demo-step-3',
          description: '',
          from_step_id: 'demo-step-2'
        },
        {
          id: 'demo-path-3',
          icon: 'arrow-right',
          label: 'Aller au formulaire',
          sort_order: 0,
          to_step_id: 'demo-step-4',
          description: '',
          from_step_id: 'demo-step-3'
        },
        {
          id: 'demo-path-4',
          icon: 'arrow-right',
          label: 'L\'étape sondage est la suivante',
          sort_order: 0,
          to_step_id: 'demo-step-5',
          description: '',
          from_step_id: 'demo-step-4'
        },
        {
          id: 'demo-path-5',
          icon: 'arrow-right',
          label: 'Encore plus d\'étapes',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-5'
        },
        {
          id: 'demo-path-6',
          icon: 'arrow-right',
          label: 'Terminer la visite',
          sort_order: 0,
          to_step_id: 'demo-step-7',
          description: '',
          from_step_id: 'demo-step-6'
        },
        {
          id: 'demo-path-7',
          icon: 'arrow-right',
          label: 'Parcours court',
          sort_order: 0,
          to_step_id: 'demo-step-8',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-8',
          icon: 'arrow-right',
          label: 'Encore plus d\'étapes',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-8'
        }
      ]
    },
    nl: {
      title: 'Demo-expeditie',
      description: 'Dit is een demo-expeditie',
      steps: [
        {
          id: 'demo-step-1',
          type: 'content',
          title: 'Dit is een expeditie',
          is_end: false,
          is_start: true,
          position_x: 35,
          position_y: 175,
          basic_props: {
            body: '<blockquote data-path-to-node="2"><p data-path-to-node="2,0">Welkom bij Gryffi. Dit is een voorbeeld van de exacte ervaring die je eindgebruikers zullen hebben. <br><br>Geef je de voorkeur aan de korte of de volledige expeditie?</p></blockquote><h3 data-path-to-node="3"></h3>',
            image_url: '/images/demo/step-1-image.png',
            video_url: '',
            media_type: 'image',
            text_position: 'below',
            media_description: 'Welkom bij Gryffi. Dit is een voorbeeld van de exacte ervaring die je eindgebruikers zullen hebben.\n\nGeef je de voorkeur aan de korte of de volledige expeditie?'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-2',
          type: 'space',
          title: 'Ruimtestap',
          is_end: false,
          is_start: false,
          position_x: 321,
          position_y: 168,
          basic_props: {
            floorplan: {
              enabled: false
            },
            image_url: '/images/demo/step-2-image.jpg',
            description: 'Dit is een Ruimtestap, gebruikt voor het maken van virtuele rondleidingen. Je kunt standaardafbeeldingen of 360-graden panorama\'s gebruiken voor een meer meeslepende ervaring. Er is ook een optie om een interactieve kaart toe te voegen voor betere oriëntatie.',
            is_panorama: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-3',
          type: 'challenge',
          title: 'Uitdagingsstap',
          is_end: false,
          is_start: false,
          position_x: 584,
          position_y: 168,
          basic_props: {
            type: 'multiple_choice',
            questions: [
              {
                id: '41d3eca2-72cb-4a5e-8a8a-f926f24d3c88',
                options: [
                  {
                    id: 'a',
                    text: 'Codeerplatform',
                    correct: false
                  },
                  {
                    id: 'b',
                    text: 'Platform voor medewerkersbetrokkenheid',
                    correct: true
                  },
                  {
                    id: 'c',
                    text: 'Online documentbewerker',
                    correct: false
                  },
                  {
                    id: 'd',
                    text: 'AI-beeldgenerator',
                    correct: false
                  }
                ],
                question: 'Dit is een Uitdagingsstap. Gebruik deze om quizzen te maken met één of meerdere vragen. Bijvoorbeeld:\n\nWelke van de volgende uitspraken over Gryffi is waar? Gryffi is een...'
              }
            ]
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-4',
          type: 'form',
          title: 'Formulierstap',
          is_end: false,
          is_start: false,
          position_x: 859,
          position_y: 160,
          basic_props: {
            fields: [
              {
                id: '87810c69-36c4-4604-931d-1842272152cc',
                type: 'text',
                label: 'Volledige naam',
                options: '',
                required: true,
                fileSubtype: null
              },
              {
                id: 'be4db3a4-f7de-4ca9-b116-55d31c361cff',
                type: 'select',
                label: 'Waarvoor ga je Gryffi gebruiken?',
                options: 'Onboarding nieuwe medewerkers,Naleving & veiligheidstraining,Rondleidingen & locatie-instructie,Productkennis training,Standaardwerkprocedures,Interne kennisdeling,Klanteneducatie,Anders',
                required: true,
                fileSubtype: null
              }
            ],
            description: 'Dit is een Formulierstap. Gebruik deze om essentiële gegevens van je eindgebruikers te verzamelen, wat vooral handig is voor taken zoals het onboarden van nieuwe medewerkers.',
            email_subject: 'Formulierinzending: {{journey_title}}',
            recipient_email: ''
          },
          advanced_props: {
            assistant_guide_id: null,
            confirmation_message: 'Bedankt! Je formulier is verzonden.',
            completion_requirement: 'after_submit'
          }
        },
        {
          id: 'demo-step-5',
          type: 'poll',
          title: 'Peilingsstap',
          is_end: false,
          is_start: false,
          position_x: 1114,
          position_y: 156,
          basic_props: {
            options: [
              {
                id: 'ccbbc74c-9862-449b-8e2c-d00f9f133f1d',
                text: 'Italiaans eten'
              },
              {
                id: '93358173-94b4-4ee2-a65e-dda5bd8b1412',
                text: 'Chinees eten'
              },
              {
                id: 'd8f0a390-701c-49d3-a1d3-772d43b75243',
                text: 'Thais eten'
              },
              {
                id: '8943db0a-37e3-4a2a-a77f-fd5af17d5e1c',
                text: 'Fastfood'
              },
              {
                id: 'e8323903-55f3-45d2-a89d-9aadd425b39c',
                text: 'Broodjes'
              }
            ],
            question: 'Dit is een Peilingsstap. Gebruik deze om feedback van gebruikers te verzamelen, waarbij alle gegevens worden bijgehouden in het analyticsgedeelte. Hier is een voorbeeld:\n\nWelk soort eten zou je graag toegevoegd willen zien aan het personeelsrestaurantmenu?',
            is_required: true,
            show_results: true,
            allow_multiple: false
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-6',
          type: 'content',
          title: 'Meer stappen',
          is_end: false,
          is_start: false,
          position_x: 1125,
          position_y: 337,
          basic_props: {
            body: 'Er zijn nog meer stappen mogelijk in een Gryffi-expeditie:<br><b data-path-to-node="4,0,0" data-index-in-node="0"><br>Gidsstap</b>: Integreer een AI-aangedreven Gids in de expeditie om vragen te beantwoorden op basis van jouw specifieke kennisbank.<div><br><b data-path-to-node="4,1,0" data-index-in-node="0">Inhoudsstap</b>: Voeg tekst, afbeeldingen of video\'s toe om informatie en trainingsmateriaal effectief over te brengen.<br><b data-path-to-node="4,2,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,2,0" data-index-in-node="0">Beloningsstap</b>: Geef gebruikers kortingscodes of tastbare beloningen na het voltooien van de expeditie.<br><b data-path-to-node="4,3,0" data-index-in-node="0"><br></b></div><div><b data-path-to-node="4,3,0" data-index-in-node="0">Substap</b>: Sluit een expeditie in binnen een andere om modulaire en herbruikbare trainingspaden te creëren.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-7',
          type: 'content',
          title: 'Einde van deze demo-expeditie',
          is_end: true,
          is_start: false,
          position_x: 1120,
          position_y: 510,
          basic_props: {
            body: '',
            image_url: '/images/demo/step-7-image.jpg',
            video_url: '',
            media_type: 'image',
            text_position: 'above',
            media_description: 'Bedankt voor het verkennen van hoe je expedities kunt bouwen in Gryffi. Nu je deze ervaring hebt voltooid, kun je precies zien hoe deze is opgebouwd in de visuele expeditiebouwer. Je kunt deze expeditie nu sluiten.'
          },
          advanced_props: {}
        },
        {
          id: 'demo-step-8',
          type: 'content',
          title: 'Reisstappen',
          is_end: false,
          is_start: false,
          position_x: 360,
          position_y: 430,
          basic_props: {
            body: '<div><b>Ruimtelijke stap</b>: Visualiseer fysieke locaties met standaardafbeeldingen, 360°-panorama\'s of interactieve plattegronden met hotspots.</div><div><br></div><div><b>Uitdagingstap</b>: Test kennis met meerkeuzevragen, met configureerbare slagingspercentages en herkansingslogica.</div><div><br></div><div><b>Formulierstap</b>: Verzamel gestructureerde gegevens en bestandsuploads van deelnemers via aanpasbare invoervelden.</div><div><br></div><div><b>Peilingsstap</b>: Verzamel directe feedback of sentiment via eenvoudige vragenlijsten, bijgehouden in het analyticsdashboard.</div>',
            image_url: '',
            video_url: '',
            media_type: 'text'
          },
          advanced_props: {}
        }
      ],
      paths: [
        {
          id: 'demo-path-1',
          icon: 'arrow-right',
          label: 'Volledige expeditie',
          sort_order: 0,
          to_step_id: 'demo-step-2',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-2',
          icon: 'arrow-right',
          label: 'Doe een quiz',
          sort_order: 0,
          to_step_id: 'demo-step-3',
          description: '',
          from_step_id: 'demo-step-2'
        },
        {
          id: 'demo-path-3',
          icon: 'arrow-right',
          label: 'Ga naar het formulier',
          sort_order: 0,
          to_step_id: 'demo-step-4',
          description: '',
          from_step_id: 'demo-step-3'
        },
        {
          id: 'demo-path-4',
          icon: 'arrow-right',
          label: 'Peilingsstap volgt',
          sort_order: 0,
          to_step_id: 'demo-step-5',
          description: '',
          from_step_id: 'demo-step-4'
        },
        {
          id: 'demo-path-5',
          icon: 'arrow-right',
          label: 'Nog meer stappen',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-5'
        },
        {
          id: 'demo-path-6',
          icon: 'arrow-right',
          label: 'Rond de tour af',
          sort_order: 0,
          to_step_id: 'demo-step-7',
          description: '',
          from_step_id: 'demo-step-6'
        },
        {
          id: 'demo-path-7',
          icon: 'arrow-right',
          label: 'Korte expeditie',
          sort_order: 0,
          to_step_id: 'demo-step-8',
          description: '',
          from_step_id: 'demo-step-1'
        },
        {
          id: 'demo-path-8',
          icon: 'arrow-right',
          label: 'Nog meer stappen',
          sort_order: 0,
          to_step_id: 'demo-step-6',
          description: '',
          from_step_id: 'demo-step-8'
        }
      ]
    },
  };
  
  return content[language] || content.en;
}


/**
 * Initialize default demo journeys for all languages
 * Call this once to populate the database
 */
export async function initializeDefaultDemoJourneys() {
  console.log('Initializing default demo journeys...');
  
  for (const lang of SUPPORTED_LANGUAGES) {
    try {
      // Check if this exact language exists (no fallback)
      const existingResult = await query(`
        SELECT id, version FROM demo_journeys 
        WHERE language = $1 AND is_active = true
        LIMIT 1
      `, [lang]);
      
      if (existingResult.rows.length === 0) {
        const content = getDefaultDemoJourneyContent(lang);
        await upsertDemoJourney({
          language: lang,
          target_role: null,
          title: content.title,
          description: content.description,
          journey_data: {
            steps: content.steps,
            paths: content.paths,
            settings: {}
          }
        });
        console.log(`  Created demo journey for ${lang}`);
      } else {
        console.log(`  Demo journey for ${lang} already exists (v${existingResult.rows[0].version})`);
      }
    } catch (err) {
      console.error(`  Failed to create demo journey for ${lang}:`, err.message);
    }
  }
  
  console.log('Demo journey initialization complete');
}

export { SUPPORTED_LANGUAGES };
