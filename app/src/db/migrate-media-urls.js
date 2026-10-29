/**
 * Media URL Migration Script
 * 
 * Migrates media URLs from old structure to new structure:
 * - Old: /media/organizations/{orgId}/uploads/{filename}
 * - New: /uploads/organizations/{orgId}/media/{filename}
 * 
 * - Old: /media/organizations/{orgId}/pexels/{filename}
 * - New: /uploads/organizations/{orgId}/pexels/{filename}
 * 
 * This is a one-time migration script for existing data.
 * Run with: node --env-file=../.env app/src/db/migrate-media-urls.js
 */

import 'dotenv/config';
import { query, getClient } from './index.js';

async function migrateMediaUrls() {
  console.log('🔄 Starting media URL migration...\n');
  
  const client = await getClient();
  
  try {
    await client.query('BEGIN');
    
    // Tables and columns that contain media URLs
    const urlMigrations = [
      {
        table: 'media',
        column: 'url',
        description: 'Media library URLs'
      },
      {
        table: 'guides',
        column: 'avatar_url',
        description: 'Guide avatar URLs'
      },
      {
        table: 'themes',
        column: 'logo_url',
        description: 'Theme logo URLs'
      },
      {
        table: 'themes',
        column: 'logo_light_url',
        description: 'Theme light logo URLs'
      },
      {
        table: 'floorplans',
        column: 'image_url',
        description: 'Floorplan image URLs'
      },
      {
        table: 'users',
        column: 'avatar_url',
        description: 'User avatar URLs'
      },
      {
        table: 'journeys',
        column: 'cover_image_url',
        description: 'Journey cover image URLs'
      },
      {
        table: 'organizations',
        column: 'logo_url',
        description: 'Organization logo URLs'
      },
      {
        table: 'media_analyses',
        column: 'original_url',
        description: 'Media analyses original URLs'
      }
    ];
    
    let totalUpdated = 0;
    
    for (const migration of urlMigrations) {
      const { table, column, description } = migration;
      
      // Check if table and column exist
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = $1 AND column_name = $2
        )
      `, [table, column]);
      
      if (!tableCheck.rows[0].exists) {
        console.log(`  ⏭️  Skipping ${table}.${column} (column not found)`);
        continue;
      }
      
      // Count records that need migration
      const countResult = await client.query(`
        SELECT COUNT(*) as count FROM ${table} 
        WHERE ${column} LIKE '/media/organizations/%'
      `);
      const count = parseInt(countResult.rows[0].count);
      
      if (count === 0) {
        console.log(`  ⏭️  ${description}: No records to migrate`);
        continue;
      }
      
      console.log(`  📦 ${description}: Migrating ${count} records...`);
      
      // Migration 1: /media/organizations/{orgId}/uploads/ -> /uploads/organizations/{orgId}/media/
      const uploadsResult = await client.query(`
        UPDATE ${table}
        SET ${column} = REGEXP_REPLACE(
          ${column}, 
          '^/media/organizations/([^/]+)/uploads/', 
          '/uploads/organizations/\\1/media/'
        )
        WHERE ${column} LIKE '/media/organizations/%/uploads/%'
        RETURNING id
      `);
      
      // Migration 2: /media/organizations/{orgId}/pexels/ -> /uploads/organizations/{orgId}/pexels/
      const pexelsResult = await client.query(`
        UPDATE ${table}
        SET ${column} = REGEXP_REPLACE(
          ${column}, 
          '^/media/organizations/([^/]+)/pexels/', 
          '/uploads/organizations/\\1/pexels/'
        )
        WHERE ${column} LIKE '/media/organizations/%/pexels/%'
        RETURNING id
      `);
      
      const updatedCount = uploadsResult.rowCount + pexelsResult.rowCount;
      totalUpdated += updatedCount;
      console.log(`  ✅ ${description}: Updated ${updatedCount} records`);
    }
    
    await client.query('COMMIT');
    console.log(`\n✨ Migration completed! Total records updated: ${totalUpdated}`);
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

// Show dry-run first
async function dryRun() {
  console.log('📊 Dry-run: Checking what will be migrated...\n');
  
  const tables = [
    { table: 'media', column: 'url' },
    { table: 'guides', column: 'avatar_url' },
    { table: 'themes', column: 'logo_url' },
    { table: 'themes', column: 'logo_light_url' },
    { table: 'floorplans', column: 'image_url' },
    { table: 'users', column: 'avatar_url' },
    { table: 'journeys', column: 'cover_image_url' },
    { table: 'organizations', column: 'logo_url' },
    { table: 'media_analyses', column: 'original_url' }
  ];
  
  let totalToMigrate = 0;
  
  for (const { table, column } of tables) {
    try {
      const result = await query(`
        SELECT COUNT(*) as count FROM ${table} 
        WHERE ${column} LIKE '/media/organizations/%'
      `);
      const count = parseInt(result.rows[0].count);
      if (count > 0) {
        console.log(`  ${table}.${column}: ${count} records to migrate`);
        totalToMigrate += count;
        
        // Show sample URLs
        const samples = await query(`
          SELECT ${column} FROM ${table} 
          WHERE ${column} LIKE '/media/organizations/%'
          LIMIT 2
        `);
        for (const row of samples.rows) {
          console.log(`    Example: ${row[column]}`);
        }
      }
    } catch {
      // Table or column doesn't exist
    }
  }
  
  console.log(`\nTotal records to migrate: ${totalToMigrate}`);
  return totalToMigrate;
}

// Main
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--dry-run')) {
    await dryRun();
    process.exit(0);
  } else if (args.includes('--execute')) {
    await migrateMediaUrls();
  } else {
    console.log('Media URL Migration Script');
    console.log('==========================');
    console.log('');
    console.log('This script migrates media URLs from old structure to new structure:');
    console.log('  Old: /media/organizations/{orgId}/uploads/{filename}');
    console.log('  New: /uploads/organizations/{orgId}/media/{filename}');
    console.log('');
    console.log('  Old: /media/organizations/{orgId}/pexels/{filename}');
    console.log('  New: /uploads/organizations/{orgId}/pexels/{filename}');
    console.log('');
    console.log('Usage:');
    console.log('  node migrate-media-urls.js --dry-run   Show what will be migrated');
    console.log('  node migrate-media-urls.js --execute   Execute the migration');
    console.log('');
    
    // Show dry-run by default
    await dryRun();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
