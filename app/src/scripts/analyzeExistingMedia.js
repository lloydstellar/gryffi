/**
 * One-time script to analyze all existing images and videos in journeys
 * This adds AI-generated descriptions to all media that doesn't have one yet
 * 
 * Run with: node src/scripts/analyzeExistingMedia.js
 */
import 'dotenv/config';
import { query, getClient } from '../db/index.js';
import { queueAnalysis, detectMediaType, getAnalysisDescription } from '../services/imageAnalysis.js';

async function analyzeExistingMedia() {
  console.log('🔍 Scanning for existing media in journeys...\n');
  
  const client = await getClient();
  
  try {
    // Get all steps with media URLs
    const stepsResult = await client.query(`
      SELECT 
        s.id,
        s.title,
        s.type,
        s.basic_props,
        j.title as journey_title
      FROM steps s
      JOIN journeys j ON s.journey_id = j.id
      WHERE j.deleted_at IS NULL
        AND (
          s.basic_props->>'image_url' IS NOT NULL
          OR s.basic_props->>'video_url' IS NOT NULL
          OR s.basic_props->>'panorama_url' IS NOT NULL
        )
      ORDER BY j.updated_at DESC
    `);
    
    console.log(`📊 Found ${stepsResult.rows.length} steps with media\n`);
    
    // Collect all unique URLs
    const mediaUrls = new Map(); // url -> { type, stepTitle, journeyTitle }
    
    for (const step of stepsResult.rows) {
      const basicProps = typeof step.basic_props === 'string' 
        ? JSON.parse(step.basic_props) 
        : step.basic_props;
      
      if (basicProps.image_url) {
        mediaUrls.set(basicProps.image_url, {
          type: detectMediaType(basicProps.image_url),
          stepTitle: step.title,
          journeyTitle: step.journey_title
        });
      }
      
      if (basicProps.video_url) {
        mediaUrls.set(basicProps.video_url, {
          type: detectMediaType(basicProps.video_url),
          stepTitle: step.title,
          journeyTitle: step.journey_title
        });
      }
      
      if (basicProps.panorama_url) {
        mediaUrls.set(basicProps.panorama_url, {
          type: 'image',
          stepTitle: step.title,
          journeyTitle: step.journey_title
        });
      }
    }
    
    console.log(`🖼️  Found ${mediaUrls.size} unique media URLs\n`);
    
    // Check which ones already have descriptions
    let alreadyAnalyzed = 0;
    let needsAnalysis = 0;
    let failed = 0;
    let success = 0;
    
    const urlsToAnalyze = [];
    
    for (const [url, info] of mediaUrls) {
      const existing = await getAnalysisDescription(url);
      if (existing) {
        alreadyAnalyzed++;
        console.log(`✅ Already analyzed: ${url.substring(0, 60)}...`);
      } else {
        needsAnalysis++;
        urlsToAnalyze.push({ url, ...info });
      }
    }
    
    console.log(`\n📈 Status:`);
    console.log(`   Already analyzed: ${alreadyAnalyzed}`);
    console.log(`   Needs analysis: ${needsAnalysis}\n`);
    
    if (urlsToAnalyze.length === 0) {
      console.log('✨ All media already has descriptions!');
      return;
    }
    
    console.log(`🚀 Starting analysis of ${urlsToAnalyze.length} media items...\n`);
    
    // Process each URL one by one (to avoid rate limiting)
    for (let i = 0; i < urlsToAnalyze.length; i++) {
      const { url, type, stepTitle, journeyTitle } = urlsToAnalyze[i];
      
      console.log(`[${i + 1}/${urlsToAnalyze.length}] Analyzing ${type}: ${url.substring(0, 50)}...`);
      console.log(`   Step: "${stepTitle}" in Journey: "${journeyTitle}"`);
      
      try {
        // Queue the analysis (this runs synchronously for this script)
        await queueAnalysisSync(url, type);
        
        // Wait a bit for the analysis to complete
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check if it succeeded
        const description = await getAnalysisDescription(url);
        if (description) {
          success++;
          console.log(`   ✅ Success: ${description.substring(0, 80)}...`);
        } else {
          // Check status
          const statusResult = await client.query(
            'SELECT status, error_message FROM media_analyses WHERE original_url = $1',
            [url]
          );
          if (statusResult.rows.length > 0) {
            const status = statusResult.rows[0];
            if (status.status === 'processing') {
              console.log(`   ⏳ Still processing...`);
              // Wait a bit more
              await new Promise(resolve => setTimeout(resolve, 5000));
              const desc = await getAnalysisDescription(url);
              if (desc) {
                success++;
                console.log(`   ✅ Success (delayed): ${desc.substring(0, 80)}...`);
              } else {
                failed++;
                console.log(`   ❌ Timeout waiting for analysis`);
              }
            } else if (status.status === 'failed') {
              failed++;
              console.log(`   ❌ Failed: ${status.error_message}`);
            }
          } else {
            failed++;
            console.log(`   ❌ No analysis record found`);
          }
        }
      } catch (err) {
        failed++;
        console.log(`   ❌ Error: ${err.message}`);
      }
      
      console.log('');
      
      // Small delay between items to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 FINAL RESULTS:');
    console.log(`   Total media: ${mediaUrls.size}`);
    console.log(`   Already had descriptions: ${alreadyAnalyzed}`);
    console.log(`   Newly analyzed: ${success}`);
    console.log(`   Failed: ${failed}`);
    console.log('='.repeat(50));
    
  } catch (err) {
    console.error('❌ Script error:', err);
  } finally {
    client.release();
    process.exit(0);
  }
}

/**
 * Synchronous version of queueAnalysis that waits for completion
 */
async function queueAnalysisSync(url, mediaType) {
  const crypto = await import('crypto');
  const urlHash = crypto.createHash('sha256').update(url).digest('hex');
  
  // Check if already exists
  const existing = await query(
    'SELECT status FROM media_analyses WHERE url_hash = $1',
    [urlHash]
  );
  
  if (existing.rows.length > 0 && existing.rows[0].status === 'completed') {
    return; // Already done
  }
  
  // Start the analysis
  await queueAnalysis(url, mediaType);
}

// Run the script
analyzeExistingMedia();
