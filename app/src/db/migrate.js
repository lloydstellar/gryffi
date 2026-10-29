/**
 * Database Migration Script
 * Creates all necessary tables for Gryffi Hybrid Explorer
 * 
 * Run with: npm run db:migrate
 */
import 'dotenv/config';
import pg from 'pg';

// Migrations require DDL/owner privileges, so they connect as the migration
// role (gryffi_user) via MIGRATION_DATABASE_URL. At runtime the app connects
// as the least-privilege role (gryffi_app_rt) via DATABASE_URL, which cannot
// run DDL. We therefore use a dedicated pool here instead of the shared app
// pool, falling back to DATABASE_URL for environments without a split setup.
const { Pool } = pg;
const migrationPool = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
});
const getClient = () => migrationPool.connect();

const migrations = [
  // Organizations (Multi-tenant)
  `CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    logo_url VARCHAR(500),
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Users (belong to organization)
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    role VARCHAR(50) DEFAULT 'member',
    avatar_url VARCHAR(500),
    is_active BOOLEAN DEFAULT true,
    last_login_at TIMESTAMP WITH TIME ZONE,
    password_reset_token VARCHAR(255),
    password_reset_expires TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(organization_id, email)
  )`,

  // Team Invites (builder users)
  `CREATE TABLE IF NOT EXISTS user_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'member', -- admin | manager | member | viewer
    invited_by UUID REFERENCES users(id) ON DELETE SET NULL,

    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,

    last_sent_at TIMESTAMP WITH TIME ZONE,
    email_provider_id VARCHAR(100),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(organization_id, email)
  )`,

  // Journeys (the interactive paths/experiences)
  `CREATE TABLE IF NOT EXISTS journeys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    status VARCHAR(50) DEFAULT 'draft',
    cover_image_url VARCHAR(500),
    settings JSONB DEFAULT '{}',
    published_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // ============================================
  // HYBRID EXPLORER: Step Types
  // ============================================
  
  // Steps - Main building blocks
  // Types: 'space', 'guide', 'content', 'challenge'
  `CREATE TABLE IF NOT EXISTS steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'content',
    title VARCHAR(255) NOT NULL,
    
    -- Visual positioning
    position_x INTEGER DEFAULT 100,
    position_y INTEGER DEFAULT 100,
    
    -- Flow control
    is_start BOOLEAN DEFAULT false,
    is_end BOOLEAN DEFAULT false,
    
    -- Basic properties (shown by default)
    basic_props JSONB DEFAULT '{}',
    
    -- Advanced properties (hidden behind expand)
    advanced_props JSONB DEFAULT '{}',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Resources - Collectible items (documents, badges, tools)
  `CREATE TABLE IF NOT EXISTS resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(50) DEFAULT 'document',
    type VARCHAR(50) DEFAULT 'document',
    content JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Paths - Connections between steps (multiple choice options)
  `CREATE TABLE IF NOT EXISTS paths (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    from_step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    to_step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    
    -- Display
    label VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    
    -- Conditions
    requires_resource_id UUID REFERENCES resources(id) ON DELETE SET NULL,
    condition JSONB DEFAULT '{}',
    
    -- Order
    sort_order INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Drop old transitions table if exists (replaced by paths)
  `DROP TABLE IF EXISTS transitions CASCADE`,

  // ============================================
  // PROGRESS TRACKING
  // ============================================

  // User Progress (tracking journey completion)
  `CREATE TABLE IF NOT EXISTS user_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    current_step_id UUID REFERENCES steps(id) ON DELETE SET NULL,
    visited_steps UUID[] DEFAULT '{}',
    collected_resources UUID[] DEFAULT '{}',
    answers JSONB DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(user_id, journey_id)
  )`,

  // ============================================
  // MEDIA & FILES
  // ============================================

  // Media Library
  `CREATE TABLE IF NOT EXISTS media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255),
    mime_type VARCHAR(100),
    size_bytes INTEGER,
    url VARCHAR(500) NOT NULL,
    source VARCHAR(50) DEFAULT 'upload',
    pexels_id VARCHAR(50),
    photographer VARCHAR(255),
    photographer_url VARCHAR(500),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(organization_id, pexels_id)
  )`,

  // ============================================
  // KNOWLEDGE ENGINE (RAG)
  // ============================================

  // Enable pgvector extension for semantic search
  `CREATE EXTENSION IF NOT EXISTS vector`,

  // Knowledge Sources - Uploaded files, URLs, or text blocks
  `CREATE TABLE IF NOT EXISTS knowledge_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guide_step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Source information
    source_type VARCHAR(50) NOT NULL, -- 'file', 'text', 'url'
    source_name VARCHAR(255) NOT NULL, -- Display name or filename
    original_filename VARCHAR(255), -- Original uploaded filename
    content_type VARCHAR(100), -- MIME type for files
    file_size INTEGER, -- Size in bytes
    
    -- For text sources, store the raw text
    raw_text TEXT,
    
    -- Processing status
    status VARCHAR(50) DEFAULT 'pending', -- pending, processing, completed, failed
    error_message TEXT,
    chunks_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // Knowledge Chunks - Processed text segments with embeddings
  `CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    guide_step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- The actual content
    content TEXT NOT NULL,
    
    -- Vector embedding for semantic search (1536 dimensions for OpenAI, 384 for smaller models)
    embedding vector(1536),
    
    -- Metadata
    chunk_index INTEGER NOT NULL, -- Order within the source
    metadata JSONB DEFAULT '{}', -- Additional info like page numbers, headers, etc.
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // ============================================
  // EMAIL LOGS
  // ============================================

  // Email logs for tracking sent emails
  `CREATE TABLE IF NOT EXISTS email_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    journey_id UUID REFERENCES journeys(id) ON DELETE SET NULL,
    step_id UUID REFERENCES steps(id) ON DELETE SET NULL,
    
    -- Email details
    to_email VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    template_type VARCHAR(50) NOT NULL,
    
    -- Status tracking
    email_provider_id VARCHAR(100),
    status VARCHAR(50) DEFAULT 'sent',
    error_message TEXT,
    
    -- Metadata
    variables JSONB DEFAULT '{}',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,

  // ============================================
  // INDEXES
  // ============================================
  
  `CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_user_invites_org ON user_invites(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_invites_email ON user_invites(email)`,
  `CREATE INDEX IF NOT EXISTS idx_journeys_org ON journeys(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journeys_status ON journeys(status)`,
  `CREATE INDEX IF NOT EXISTS idx_steps_journey ON steps(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_steps_type ON steps(type)`,
  `CREATE INDEX IF NOT EXISTS idx_resources_journey ON resources(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_paths_journey ON paths(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_paths_from ON paths(from_step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_paths_to ON paths(to_step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_progress_user ON user_progress(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_progress_journey ON user_progress(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_email_logs_org ON email_logs(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_email_logs_user ON email_logs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_email_logs_journey ON email_logs(journey_id)`,
  
  // Knowledge Engine indexes
  `CREATE INDEX IF NOT EXISTS idx_knowledge_sources_guide ON knowledge_sources(guide_step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_sources_org ON knowledge_sources(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status ON knowledge_sources(status)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks(source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_guide ON knowledge_chunks(guide_step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_org ON knowledge_chunks(organization_id)`,
  
  // Vector similarity search index (IVFFlat for approximate nearest neighbor)
  // Note: This index is created separately because it requires data to be present
  // Run this manually after populating some data for better performance
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_knowledge_chunks_embedding') THEN
       CREATE INDEX idx_knowledge_chunks_embedding ON knowledge_chunks 
       USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
     END IF;
   EXCEPTION WHEN OTHERS THEN
     -- Index creation might fail if not enough data, that's ok
     RAISE NOTICE 'Vector index creation skipped (needs data first)';
   END $$`,
  
  // ============================================
  // CENTRAL GUIDE LIBRARY
  // ============================================
  
  // Guides - Organization-level AI assistants that can be used across journeys
  `CREATE TABLE IF NOT EXISTS guides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Guide identity
    name VARCHAR(100) NOT NULL,
    role VARCHAR(150),
    avatar_url VARCHAR(500),
    
    -- AI configuration
    personality VARCHAR(50) DEFAULT 'friendly',
    greeting TEXT,
    ai_instructions TEXT,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Add guide_id to journeys (optional - for journey-wide guide)
  `ALTER TABLE journeys ADD COLUMN IF NOT EXISTS guide_id UUID REFERENCES guides(id) ON DELETE SET NULL`,
  
  // Add guide_id to knowledge_sources (for central guides)
  `ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS guide_id UUID REFERENCES guides(id) ON DELETE CASCADE`,
  `ALTER TABLE knowledge_sources ALTER COLUMN guide_step_id DROP NOT NULL`,
  
  // Add guide_id to knowledge_chunks (for central guides)
  `ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS guide_id UUID REFERENCES guides(id) ON DELETE CASCADE`,
  `ALTER TABLE knowledge_chunks ALTER COLUMN guide_step_id DROP NOT NULL`,
  
  // Indexes for guides
  `CREATE INDEX IF NOT EXISTS idx_guides_org ON guides(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_sources_central_guide ON knowledge_sources(guide_id)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_central_guide ON knowledge_chunks(guide_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journeys_guide ON journeys(guide_id)`,
  
  // Add language column to guides (default English)
  `ALTER TABLE guides ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT 'en'`,
  
  // Add language column to organizations (for invitation emails etc.)
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT 'en'`,
  
  // Add deleted_at column to journeys for soft delete (trash functionality)
  `ALTER TABLE journeys ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE`,

  // Add deleted_at column to guides for soft delete (trash functionality)
  `ALTER TABLE guides ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE`,
  `CREATE INDEX IF NOT EXISTS idx_guides_deleted_at ON guides(deleted_at)`,

  // ============================================
  // END USERS (Journey Participants)
  // ============================================
  
  // End users - People who participate in journeys (not builder users)
  // These are synced from external sources or manually entered
  `CREATE TABLE IF NOT EXISTS end_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Identity
    email VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    
    -- Source tracking (how the user was added)
    source VARCHAR(50) NOT NULL DEFAULT 'manual', -- manual, csv, microsoft, google
    external_id VARCHAR(255), -- ID from external system (Microsoft/Google)
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Email is unique per organization
    UNIQUE(organization_id, email)
  )`,
  
  // Indexes for end_users
  `CREATE INDEX IF NOT EXISTS idx_end_users_org ON end_users(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_end_users_email ON end_users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_end_users_source ON end_users(source)`,

  // ============================================
  // END USER GROUPS
  // ============================================
  
  // Groups - Organize end users into groups for bulk invitations
  `CREATE TABLE IF NOT EXISTS end_user_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Group info
    name VARCHAR(100) NOT NULL,
    description TEXT,
    
    -- Source tracking (how the group was created)
    source VARCHAR(50) NOT NULL DEFAULT 'manual', -- manual, microsoft, google
    external_id VARCHAR(255), -- ID from external system (Microsoft/Google)
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Group name must be unique within organization
    UNIQUE(organization_id, name)
  )`,
  
  // Group members - Many-to-many relationship between groups and end users
  `CREATE TABLE IF NOT EXISTS end_user_group_members (
    group_id UUID NOT NULL REFERENCES end_user_groups(id) ON DELETE CASCADE,
    end_user_id UUID NOT NULL REFERENCES end_users(id) ON DELETE CASCADE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (group_id, end_user_id)
  )`,
  
  // Indexes for groups
  `CREATE INDEX IF NOT EXISTS idx_end_user_groups_org ON end_user_groups(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_end_user_group_members_group ON end_user_group_members(group_id)`,
  `CREATE INDEX IF NOT EXISTS idx_end_user_group_members_user ON end_user_group_members(end_user_id)`,

  // ============================================
  // INVITATIONS (Magic Links for End Users)
  // ============================================
  
  // Invitations - Magic link invitations sent to end users
  `CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- The magic link token (cryptographically secure, URL-safe)
    token VARCHAR(64) UNIQUE NOT NULL,
    
    -- What journey is being invited to
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    
    -- Who is invited
    end_user_id UUID NOT NULL REFERENCES end_users(id) ON DELETE CASCADE,
    
    -- Options
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    max_completions INT DEFAULT 1, -- How many times the journey can be completed
    
    -- Tracking
    completions_count INT DEFAULT 0,
    
    -- Status: pending (sent but not opened), active (opened), completed, expired, revoked
    status VARCHAR(20) DEFAULT 'pending',
    
    -- Session tracking
    first_accessed_at TIMESTAMP WITH TIME ZONE,
    last_accessed_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  
  // Partial unique index to prevent duplicate active invitations for same user+journey
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_active_unique 
   ON invitations(end_user_id, journey_id) 
   WHERE status IN ('pending', 'active')`,

  // Device sessions for invitation - tracks which devices have accessed an invitation
  // Allows up to 2 devices, then requires email verification
  `CREATE TABLE IF NOT EXISTS invitation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invitation_id UUID NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
    
    -- Device identification (browser fingerprint hash)
    device_fingerprint VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45),
    country_code VARCHAR(2),
    user_agent TEXT,
    
    -- Verification status
    verified BOOLEAN DEFAULT false, -- true = device is trusted
    verification_code VARCHAR(4),
    verification_expires_at TIMESTAMP WITH TIME ZONE,
    verification_attempts INT DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Each device fingerprint can only have one session per invitation
    UNIQUE(invitation_id, device_fingerprint)
  )`,

  // End user progress - tracking journey completion for end users (via invitations)
  `CREATE TABLE IF NOT EXISTS end_user_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invitation_id UUID NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
    end_user_id UUID NOT NULL REFERENCES end_users(id) ON DELETE CASCADE,
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    
    -- Progress tracking
    current_step_id UUID REFERENCES steps(id) ON DELETE SET NULL,
    visited_steps UUID[] DEFAULT '{}',
    collected_resources UUID[] DEFAULT '{}',
    answers JSONB DEFAULT '{}',
    
    -- Timestamps
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- One progress record per invitation
    UNIQUE(invitation_id)
  )`,

  // Indexes for invitations
  `CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token)`,
  `CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invitations_journey ON invitations(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invitations_end_user ON invitations(end_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status)`,
  `CREATE INDEX IF NOT EXISTS idx_invitations_expires ON invitations(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_invitation_sessions_invitation ON invitation_sessions(invitation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invitation_sessions_device ON invitation_sessions(device_fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_end_user_progress_invitation ON end_user_progress(invitation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_end_user_progress_end_user ON end_user_progress(end_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_end_user_progress_journey ON end_user_progress(journey_id)`,

  // ============================================
  // NESTED JOURNEY SUPPORT
  // ============================================
  
  // Add nested_context column to track parent journey state when in a nested journey
  // Structure: { parent_journey_id, parent_step_id, parent_visited_steps, parent_answers, entry_time }
  `ALTER TABLE end_user_progress ADD COLUMN IF NOT EXISTS nested_context JSONB DEFAULT NULL`,

  // ============================================
  // GOOGLE WORKSPACE INTEGRATION
  // ============================================
  
  // Add Google OAuth columns to organizations
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS google_access_token TEXT`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS google_refresh_token TEXT`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS google_connected_email VARCHAR(255)`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS google_connected_at TIMESTAMP WITH TIME ZONE`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS google_domain VARCHAR(255)`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS google_last_sync TIMESTAMP WITH TIME ZONE`,
  
  // Google Workspace sync configuration (same structure as Microsoft)
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS google_sync_config JSONB DEFAULT '{
    "syncMode": "all",
    "syncGroups": true,
    "selectedGroupIds": [],
    "autoSyncEnabled": true
  }'`,

  // User email verification (for organization sign-up)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP WITH TIME ZONE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token_hash VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMP WITH TIME ZONE`,
  `CREATE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token_hash)`,

  // Hidden admin support (for super admin CLI)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_visible BOOLEAN DEFAULT true`,

  // ============================================
  // POLLS (Anonymous voting within journeys)
  // ============================================
  
  // Polls - Reusable poll definitions within an organization
  `CREATE TABLE IF NOT EXISTS polls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    
    -- Poll configuration (stored in step basic_props, but poll needs its own ID for responses)
    -- The actual question and options are stored in the step's basic_props
    
    -- Archive status (for when journey/step is deleted but responses exist)
    is_archived BOOLEAN DEFAULT false,
    archived_at TIMESTAMP WITH TIME ZONE,
    archived_question TEXT,
    archived_options JSONB,
    archived_journey_title TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Each step can only have one poll
    UNIQUE(step_id)
  )`,
  
  // Add archive columns to polls if they don't exist
  `DO $$ 
  BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'polls' AND column_name = 'is_archived') THEN
      ALTER TABLE polls ADD COLUMN is_archived BOOLEAN DEFAULT false;
      ALTER TABLE polls ADD COLUMN archived_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE polls ADD COLUMN archived_question TEXT;
      ALTER TABLE polls ADD COLUMN archived_options JSONB;
      ALTER TABLE polls ADD COLUMN archived_journey_title TEXT;
    END IF;
  END $$`,
  
  // Make step_id nullable for archived polls (so they survive permanent journey deletion)
  `DO $$
  BEGIN
    -- Drop the NOT NULL constraint if it exists
    ALTER TABLE polls ALTER COLUMN step_id DROP NOT NULL;
    -- Change cascade behavior to SET NULL
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'polls_step_id_fkey' AND table_name = 'polls') THEN
      ALTER TABLE polls DROP CONSTRAINT polls_step_id_fkey;
      ALTER TABLE polls ADD CONSTRAINT polls_step_id_fkey FOREIGN KEY (step_id) REFERENCES steps(id) ON DELETE SET NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Ignore if already done
    NULL;
  END $$`,
  
  // Poll responses - Anonymous responses from end users
  `CREATE TABLE IF NOT EXISTS poll_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Anonymous but trackable per invitation session (to prevent duplicate votes)
    invitation_id UUID REFERENCES invitations(id) ON DELETE CASCADE,
    session_id VARCHAR(100), -- For builder preview sessions
    
    -- Response data
    selected_options INTEGER[] NOT NULL, -- Array of option indices (0-based)
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- One response per invitation per poll (anonymous but deduplicated)
    UNIQUE(poll_id, invitation_id)
  )`,
  
  // Indexes for polls
  `CREATE INDEX IF NOT EXISTS idx_polls_org ON polls(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_polls_step ON polls(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_poll_responses_poll ON poll_responses(poll_id)`,
  `CREATE INDEX IF NOT EXISTS idx_poll_responses_org ON poll_responses(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_poll_responses_invitation ON poll_responses(invitation_id)`,

  // ============================================
  // SUBSCRIPTION TIERS & USAGE TRACKING
  // ============================================
  
  // Subscription tiers - Define the 4 plan levels
  `CREATE TABLE IF NOT EXISTS subscription_tiers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    price_monthly DECIMAL(10,2) DEFAULT 0,
    price_yearly DECIMAL(10,2) DEFAULT 0,
    
    -- Feature limits
    max_journeys INTEGER DEFAULT 1,
    max_guides INTEGER DEFAULT 1,
    max_makers INTEGER DEFAULT 1,
    max_end_users INTEGER DEFAULT 10,
    max_knowledge_chunks INTEGER DEFAULT 500,
    max_ai_credits_monthly INTEGER DEFAULT 500,
    
    -- Feature flags
    sync_enabled BOOLEAN DEFAULT false,
    priority_support BOOLEAN DEFAULT false,
    dedicated_support BOOLEAN DEFAULT false,
    custom_branding BOOLEAN DEFAULT false,
    api_access BOOLEAN DEFAULT false,
    
    -- Display order
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Insert default tiers
  `INSERT INTO subscription_tiers (name, display_name, description, price_monthly, price_yearly, max_journeys, max_guides, max_makers, max_end_users, max_knowledge_chunks, max_ai_credits_monthly, sync_enabled, priority_support, dedicated_support, sort_order)
   VALUES 
     ('free', 'Free', 'Perfect for testing and solo users', 0, 0, 1, 1, 1, 10, 500, 500, false, false, false, 1),
     ('professional', 'Professional', 'For small teams and growing businesses', 49, 490, 20, 10, 10, 100, 7000, 5000, true, false, false, 2),
     ('enterprise', 'Enterprise', 'For larger organizations', 149, 1490, 50, 50, 30, 1000, 50000, 25000, true, true, false, 3),
     ('custom', 'Custom', 'Tailored solutions for enterprise needs', 0, 0, -1, -1, -1, -1, -1, -1, true, true, true, 4)
   ON CONFLICT (name) DO NOTHING`,
  
  // Add trash retention days to subscription tiers (days before permanent deletion)
  `ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS trash_retention_days INTEGER DEFAULT 14`,
  
  // Update trash retention days per tier: Free=14, Pro=30, Enterprise=90, Custom=-1 (unlimited)
  `UPDATE subscription_tiers SET trash_retention_days = CASE 
    WHEN name = 'free' THEN 14
    WHEN name = 'professional' THEN 30
    WHEN name = 'enterprise' THEN 90
    WHEN name = 'custom' THEN -1
    ELSE 14
  END WHERE trash_retention_days IS NULL OR trash_retention_days = 14`,

  // Add subscription fields to organizations
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_tier_id INTEGER DEFAULT 1`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'active'`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_cycle_start TIMESTAMP WITH TIME ZONE DEFAULT NOW()`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_cycle_end TIMESTAMP WITH TIME ZONE`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS creem_customer_id VARCHAR(100)`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS creem_subscription_id VARCHAR(100)`,
  `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'paddle_customer_id') THEN ALTER TABLE organizations RENAME COLUMN paddle_customer_id TO paddle_customer_id_legacy; END IF; END $$`,
  `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'paddle_subscription_id') THEN ALTER TABLE organizations RENAME COLUMN paddle_subscription_id TO paddle_subscription_id_legacy; END IF; END $$`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP WITH TIME ZONE`,
  
  // Usage tracking - Monthly resettable counters
  `CREATE TABLE IF NOT EXISTS organization_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Billing period
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Usage counters (reset monthly for AI credits)
    ai_credits_used INTEGER DEFAULT 0,
    
    -- Snapshot of counts at period end (for historical tracking)
    journeys_count INTEGER DEFAULT 0,
    guides_count INTEGER DEFAULT 0,
    makers_count INTEGER DEFAULT 0,
    end_users_count INTEGER DEFAULT 0,
    knowledge_chunks_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- One record per organization per billing period
    UNIQUE(organization_id, period_start)
  )`,
  
  // Usage events log - Detailed tracking for analytics and billing
  `CREATE TABLE IF NOT EXISTS usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    
    -- Event details
    event_type VARCHAR(50) NOT NULL, -- 'ai_chat', 'journey_create', 'guide_create', 'chunk_add', etc.
    resource_type VARCHAR(50), -- 'journey', 'guide', 'knowledge', 'user', etc.
    resource_id UUID,
    
    -- AI-specific tracking
    ai_credits_used INTEGER DEFAULT 0,
    ai_model VARCHAR(100),
    ai_tokens_input INTEGER,
    ai_tokens_output INTEGER,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Limit exceeded notifications - Track when limits are hit
  `CREATE TABLE IF NOT EXISTS limit_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- What limit was exceeded
    limit_type VARCHAR(50) NOT NULL, -- 'journeys', 'guides', 'makers', 'end_users', 'chunks', 'ai_credits'
    current_value INTEGER NOT NULL,
    limit_value INTEGER NOT NULL,
    
    -- Notification tracking
    notified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    email_sent BOOLEAN DEFAULT false,
    acknowledged_at TIMESTAMP WITH TIME ZONE,
    acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
    
    -- Prevent duplicate notifications within same period
    notification_period VARCHAR(20) DEFAULT 'monthly' -- 'daily', 'weekly', 'monthly'
  )`,
  
  // Indexes for subscription/usage tables
  `CREATE INDEX IF NOT EXISTS idx_org_usage_org ON organization_usage(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_org_usage_period ON organization_usage(period_start, period_end)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_org ON usage_events(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_limit_notifications_org ON limit_notifications(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_limit_notifications_type ON limit_notifications(limit_type)`,
  
  // ============================================
  // INVITATION REMINDERS
  // ============================================
  
  // Add reminder fields to invitations table
  `ALTER TABLE invitations ADD COLUMN IF NOT EXISTS send_reminder BOOLEAN DEFAULT false`,
  `ALTER TABLE invitations ADD COLUMN IF NOT EXISTS reminder_at TIMESTAMP WITH TIME ZONE`,
  `ALTER TABLE invitations ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMP WITH TIME ZONE`,
  
  // Index for efficient reminder queries
  `CREATE INDEX IF NOT EXISTS idx_invitations_reminder ON invitations(reminder_at) WHERE send_reminder = true AND reminder_sent_at IS NULL AND status IN ('pending', 'active')`,

  // ============================================
  // PUBLIC API - API Keys for Organizations
  // ============================================
  
  // Add API key hash column to organizations (for public API authentication)
  // The API key is generated once and shown to the admin, only the hash is stored
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(255)`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMP WITH TIME ZONE`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS api_key_last_used_at TIMESTAMP WITH TIME ZONE`,
  
  // Enable API access for Professional, Enterprise, and Custom tiers
  `UPDATE subscription_tiers SET api_access = true WHERE name IN ('professional', 'enterprise', 'custom')`,

  // Add backup retention days to subscription tiers
  `ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS backup_retention_days INTEGER DEFAULT 0`,
  
  // Set backup retention days per tier: Free=0, Pro=7, Enterprise=30, Custom=-1 (unlimited)
  `UPDATE subscription_tiers SET backup_retention_days = CASE 
    WHEN name = 'free' THEN 0
    WHEN name = 'professional' THEN 7
    WHEN name = 'enterprise' THEN 30
    WHEN name = 'custom' THEN -1
    ELSE 0
  END`,

  // ============================================
  // LOGIN SECURITY - Brute Force & 2FA
  // ============================================
  
  // Login attempts tracking for brute force protection
  `CREATE TABLE IF NOT EXISTS login_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    ip_address INET,
    country_code VARCHAR(2),
    user_agent TEXT,
    success BOOLEAN DEFAULT false,
    failure_reason VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Indexes for efficient login attempt queries
  `CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email)`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address)`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at)`,
  
  // User login security fields
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS login_verification_code VARCHAR(4)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS login_verification_expires TIMESTAMP WITH TIME ZONE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip INET`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_country VARCHAR(2)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS lockout_until TIMESTAMP WITH TIME ZONE`,
  
  // ============================================
  // AI CREDITS - Change to DECIMAL for precise tracking
  // ============================================
  
  // Change ai_credits_used from INTEGER to DECIMAL(10,2) in organization_usage
  `ALTER TABLE organization_usage ALTER COLUMN ai_credits_used TYPE DECIMAL(10,2)`,
  
  // Change ai_credits_used from INTEGER to DECIMAL(10,2) in usage_events
  `ALTER TABLE usage_events ALTER COLUMN ai_credits_used TYPE DECIMAL(10,2)`,
  
  // ============================================
  // REWARDS SYSTEM - Coupon/code distribution
  // ============================================
  
  // Rewards - Configuration for reward steps
  `CREATE TABLE IF NOT EXISTS rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Reward details
    title VARCHAR(255) NOT NULL,
    description TEXT,
    redemption_location VARCHAR(500),
    terms_conditions TEXT,
    valid_until DATE,
    
    -- Code generation settings
    is_random_codes BOOLEAN DEFAULT true,
    max_recipients INTEGER,
    code_prefix VARCHAR(20) DEFAULT '',
    code_length INTEGER DEFAULT 8,
    
    -- Archive status (for when journey/step is deleted but codes were claimed)
    is_archived BOOLEAN DEFAULT false,
    archived_at TIMESTAMP WITH TIME ZONE,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Add is_archived column to rewards if it doesn't exist
  `DO $$ 
  BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rewards' AND column_name = 'is_archived') THEN
      ALTER TABLE rewards ADD COLUMN is_archived BOOLEAN DEFAULT false;
      ALTER TABLE rewards ADD COLUMN archived_at TIMESTAMP WITH TIME ZONE;
    END IF;
  END $$`,
  
  // Make step_id and journey_id nullable for archived rewards (so they survive permanent journey deletion)
  `DO $$
  BEGIN
    -- Drop the NOT NULL constraints
    ALTER TABLE rewards ALTER COLUMN step_id DROP NOT NULL;
    ALTER TABLE rewards ALTER COLUMN journey_id DROP NOT NULL;
    -- Change cascade behavior to SET NULL for step_id
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'rewards_step_id_fkey' AND table_name = 'rewards') THEN
      ALTER TABLE rewards DROP CONSTRAINT rewards_step_id_fkey;
      ALTER TABLE rewards ADD CONSTRAINT rewards_step_id_fkey FOREIGN KEY (step_id) REFERENCES steps(id) ON DELETE SET NULL;
    END IF;
    -- Change cascade behavior to SET NULL for journey_id
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'rewards_journey_id_fkey' AND table_name = 'rewards') THEN
      ALTER TABLE rewards DROP CONSTRAINT rewards_journey_id_fkey;
      ALTER TABLE rewards ADD CONSTRAINT rewards_journey_id_fkey FOREIGN KEY (journey_id) REFERENCES journeys(id) ON DELETE SET NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END $$`,
  
  // Reward codes - Individual codes (pre-generated or on-demand)
  `CREATE TABLE IF NOT EXISTS reward_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reward_id UUID NOT NULL REFERENCES rewards(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- The code itself
    code VARCHAR(100) NOT NULL,
    
    -- Claim status
    is_claimed BOOLEAN DEFAULT false,
    claimed_by_end_user_id UUID REFERENCES end_users(id) ON DELETE SET NULL,
    claimed_by_invitation_id UUID REFERENCES invitations(id) ON DELETE SET NULL,
    claimed_at TIMESTAMP WITH TIME ZONE,
    claim_position INTEGER,
    
    -- Notification tracking
    email_sent_at TIMESTAMP WITH TIME ZONE,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Unique constraint: one code per reward
    UNIQUE(reward_id, code)
  )`,
  
  // Indexes for rewards
  `CREATE INDEX IF NOT EXISTS idx_rewards_step ON rewards(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rewards_journey ON rewards(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rewards_org ON rewards(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reward_codes_reward ON reward_codes(reward_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reward_codes_claimed_by ON reward_codes(claimed_by_end_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reward_codes_code ON reward_codes(code)`,
  

  // ============================================
  // FLOORPLANS - Building/venue maps for Space Steps
  // ============================================
  
  // Floorplans - Organization-level library of building/venue maps
  `CREATE TABLE IF NOT EXISTS floorplans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Floorplan details
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- Image
    image_url VARCHAR(500) NOT NULL,
    width INTEGER,
    height INTEGER,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Indexes for floorplans
  `CREATE INDEX IF NOT EXISTS idx_floorplans_org ON floorplans(organization_id)`,

  // ============================================
  // THEMES - Custom journey styling for Tier 3+4
  // ============================================
  
  // Themes - Organization-level custom styling for journeys
  `CREATE TABLE IF NOT EXISTS themes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Theme details
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_preset BOOLEAN DEFAULT false,
    preset_key VARCHAR(50),
    
    -- Logo
    logo_url VARCHAR(500),
    
    -- Design tokens (JSONB for flexibility)
    tokens JSONB NOT NULL DEFAULT '{
      "primary": "#0b4b34",
      "accent": "#78c503",
      "background": "#ecf2eb",
      "textPrimary": "#1f2937",
      "textSecondary": "#6b7280",
      "cardBackground": "#ffffff",
      "cardBorder": "#e5e7eb",
      "buttonText": "#ffffff",
      "headerBackground": "#0b4b34",
      "progressBar": "#78c503",
      "chatBubbleUser": "#0b4b34",
      "chatBubbleGuide": "#f3f4f6",
      "borderRadius": "12",
      "shadowStrength": "medium"
    }',
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Add active theme to organizations
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS active_theme_id UUID REFERENCES themes(id) ON DELETE SET NULL`,
  
  // Indexes for themes
  `CREATE INDEX IF NOT EXISTS idx_themes_org ON themes(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_themes_preset ON themes(is_preset)`,
  
  // Add logo_light_url column for white/inverted logo version (for dark backgrounds)
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS logo_light_url VARCHAR(500)`,

  // ============================================
  // ORGANIZATION COUNTRY
  // ============================================
  
  // Add country column to organizations (ISO 3166-1 alpha-2 code)
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS country VARCHAR(2)`,
  `CREATE INDEX IF NOT EXISTS idx_organizations_country ON organizations(country)`,

  // ============================================
  // TIER PRICING PER CURRENCY
  // ============================================
  
  // Tier prices - Prices per subscription tier and currency
  `CREATE TABLE IF NOT EXISTS tier_prices (
    id SERIAL PRIMARY KEY,
    tier_id INTEGER NOT NULL REFERENCES subscription_tiers(id) ON DELETE CASCADE,
    currency VARCHAR(3) NOT NULL, -- EUR, GBP, USD
    price_monthly DECIMAL(10,2) NOT NULL DEFAULT 0,
    price_yearly DECIMAL(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tier_id, currency)
  )`,
  
  // Index for efficient lookups
  `CREATE INDEX IF NOT EXISTS idx_tier_prices_tier ON tier_prices(tier_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tier_prices_currency ON tier_prices(currency)`,
  
  // Insert default prices for all tiers and currencies
  // EUR prices (base prices)
  `INSERT INTO tier_prices (tier_id, currency, price_monthly, price_yearly)
   SELECT id, 'EUR', price_monthly, price_yearly FROM subscription_tiers
   ON CONFLICT (tier_id, currency) DO NOTHING`,
  
  // GBP prices (roughly 0.85x EUR)
  `INSERT INTO tier_prices (tier_id, currency, price_monthly, price_yearly)
   SELECT id, 'GBP', 
     CASE WHEN price_monthly > 0 THEN ROUND(price_monthly * 0.85, 0) ELSE 0 END,
     CASE WHEN price_yearly > 0 THEN ROUND(price_yearly * 0.85, 0) ELSE 0 END
   FROM subscription_tiers
   ON CONFLICT (tier_id, currency) DO NOTHING`,
  
  // USD prices (roughly 1.10x EUR)
  `INSERT INTO tier_prices (tier_id, currency, price_monthly, price_yearly)
   SELECT id, 'USD',
     CASE WHEN price_monthly > 0 THEN ROUND(price_monthly * 1.10, 0) ELSE 0 END,
     CASE WHEN price_yearly > 0 THEN ROUND(price_yearly * 1.10, 0) ELSE 0 END
   FROM subscription_tiers
   ON CONFLICT (tier_id, currency) DO NOTHING`,

  // ============================================
  // PUBLIC JOURNEYS (Tier 3+ Feature)
  // ============================================
  
  // Add public journey columns to journeys table
  `ALTER TABLE journeys ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false`,
  `ALTER TABLE journeys ADD COLUMN IF NOT EXISTS public_token VARCHAR(64) UNIQUE`,
  `ALTER TABLE journeys ADD COLUMN IF NOT EXISTS public_link_created_at TIMESTAMP WITH TIME ZONE`,
  
  // Index for public token lookups
  `CREATE INDEX IF NOT EXISTS idx_journeys_public_token ON journeys(public_token) WHERE public_token IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_journeys_is_public ON journeys(is_public) WHERE is_public = true`,
  
  // Public participants - Anonymous visitors to public journeys
  // They get identified when they reach form/poll/reward steps
  `CREATE TABLE IF NOT EXISTS public_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Session tracking
    session_id VARCHAR(64) NOT NULL,
    browser_fingerprint VARCHAR(64),
    
    -- Identity (filled when user identifies at form/poll/reward)
    email VARCHAR(255),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email_verified BOOLEAN DEFAULT false,
    email_verification_code VARCHAR(6),
    email_verification_expires TIMESTAMP WITH TIME ZONE,
    
    -- Progress tracking
    current_step_id UUID REFERENCES steps(id) ON DELETE SET NULL,
    visited_steps UUID[] DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Each email can only participate once per journey
    UNIQUE(journey_id, email)
  )`,
  
  // Indexes for public participants
  `CREATE INDEX IF NOT EXISTS idx_public_participants_journey ON public_participants(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_participants_session ON public_participants(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_participants_email ON public_participants(email)`,
  `CREATE INDEX IF NOT EXISTS idx_public_participants_org ON public_participants(organization_id)`,

  // Add public participant reference to reward codes (for public journeys).
  // Must run after public_participants exists, otherwise a fresh install fails.
  `ALTER TABLE reward_codes ADD COLUMN IF NOT EXISTS claimed_by_public_participant_id UUID REFERENCES public_participants(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS idx_reward_codes_public_participant ON reward_codes(claimed_by_public_participant_id)`,
  
  // Public poll responses - Track poll answers from public participants
  `CREATE TABLE IF NOT EXISTS public_poll_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID NOT NULL REFERENCES public_participants(id) ON DELETE CASCADE,
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    
    -- Response data
    selected_option VARCHAR(255) NOT NULL,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- One response per participant per poll
    UNIQUE(participant_id, step_id)
  )`,
  
  // Indexes for public poll responses
  `CREATE INDEX IF NOT EXISTS idx_public_poll_responses_participant ON public_poll_responses(participant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_poll_responses_step ON public_poll_responses(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_poll_responses_journey ON public_poll_responses(journey_id)`,
  
  // Public form submissions - Track form submissions from public participants
  `CREATE TABLE IF NOT EXISTS public_form_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID NOT NULL REFERENCES public_participants(id) ON DELETE CASCADE,
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    
    -- Form data
    responses JSONB NOT NULL DEFAULT '{}',
    
    -- Email tracking
    email_sent BOOLEAN DEFAULT false,
    email_sent_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Indexes for public form submissions
  `CREATE INDEX IF NOT EXISTS idx_public_form_submissions_participant ON public_form_submissions(participant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_form_submissions_step ON public_form_submissions(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_form_submissions_journey ON public_form_submissions(journey_id)`,
  
  // Public reward claims - Track reward claims from public participants
  `CREATE TABLE IF NOT EXISTS public_reward_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID NOT NULL REFERENCES public_participants(id) ON DELETE CASCADE,
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    reward_id UUID REFERENCES rewards(id) ON DELETE SET NULL,
    
    -- Reward code assigned
    code VARCHAR(100),
    
    -- Claim tracking
    claimed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    email_sent BOOLEAN DEFAULT false,
    email_sent_at TIMESTAMP WITH TIME ZONE,
    
    -- One reward per participant per step
    UNIQUE(participant_id, step_id)
  )`,
  
  // Indexes for public reward claims
  `CREATE INDEX IF NOT EXISTS idx_public_reward_claims_participant ON public_reward_claims(participant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_reward_claims_step ON public_reward_claims(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_reward_claims_journey ON public_reward_claims(journey_id)`,

  // ============================================
  // REMOVE JOURNEY CATEGORIES
  // ============================================
  // Categories are removed to give makers more freedom
  `ALTER TABLE journeys DROP COLUMN IF EXISTS category`,

  // ============================================
  // PRIVATE FORM SUBMISSIONS TRACKING
  // ============================================
  // Track form submissions for private journeys (via magic links)
  // This allows users to skip form steps they've already completed
  `CREATE TABLE IF NOT EXISTS private_form_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invitation_id UUID NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
    end_user_id UUID NOT NULL REFERENCES end_users(id) ON DELETE CASCADE,
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    
    -- Form data (for reference)
    responses JSONB NOT NULL DEFAULT '{}',
    
    -- Email tracking
    email_sent BOOLEAN DEFAULT false,
    email_sent_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Indexes for private form submissions
  `CREATE INDEX IF NOT EXISTS idx_private_form_submissions_invitation ON private_form_submissions(invitation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_private_form_submissions_end_user ON private_form_submissions(end_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_private_form_submissions_step ON private_form_submissions(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_private_form_submissions_journey ON private_form_submissions(journey_id)`,

  // ============================================
  // MICROSOFT 365 INTEGRATION (Azure AD)
  // ============================================
  
  // Add Microsoft OAuth columns to organizations (similar to Google)
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS microsoft_access_token TEXT`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS microsoft_refresh_token TEXT`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS microsoft_connected_email VARCHAR(255)`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS microsoft_connected_at TIMESTAMP WITH TIME ZONE`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS microsoft_tenant_id VARCHAR(255)`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS microsoft_tenant_name VARCHAR(255)`,
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS microsoft_last_sync TIMESTAMP WITH TIME ZONE`,
  
  // Sync configuration: what to sync (all users, specific groups, etc.)
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS microsoft_sync_config JSONB DEFAULT '{
    "syncMode": "all",
    "syncGroups": true,
    "selectedGroupIds": [],
    "autoSyncEnabled": true
  }'`,

  // Remove journey archive mode: convert any archived journeys to draft (trash is used instead)
  `UPDATE journeys SET status = 'draft', updated_at = NOW() WHERE status = 'archived'`,

  // ============================================
  // MEDIA ANALYSIS (AI Vision)
  // ============================================
  // Store AI-generated descriptions of images and videos for Step Assistants
  // Uses URL hash for caching/reuse when same image is used in multiple steps
  
  `CREATE TABLE IF NOT EXISTS media_analyses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Unique identifier based on URL hash (SHA256) for deduplication
    url_hash VARCHAR(64) UNIQUE NOT NULL,
    original_url TEXT NOT NULL,
    
    -- Media type
    media_type VARCHAR(20) NOT NULL DEFAULT 'image', -- 'image', 'video', 'youtube'
    
    -- AI-generated description (always in English for consistency)
    description TEXT,
    
    -- For YouTube videos: additional metadata
    video_title VARCHAR(500),
    video_channel VARCHAR(255),
    
    -- Processing status
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    error_message TEXT,
    
    -- Model info
    model_used VARCHAR(100),
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    analyzed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Indexes for media_analyses
  `CREATE INDEX IF NOT EXISTS idx_media_analyses_url_hash ON media_analyses(url_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_media_analyses_status ON media_analyses(status)`,

  // ============================================
  // JOURNEY ANALYTICS EVENTS
  // ============================================
  // Detailed event tracking for journey analytics and reporting
  // Captures every significant user action during journey execution
  
  `CREATE TABLE IF NOT EXISTS journey_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- User context
    invitation_id UUID REFERENCES invitations(id) ON DELETE CASCADE,
    end_user_id UUID REFERENCES end_users(id) ON DELETE CASCADE,
    
    -- Journey context
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    parent_journey_id UUID REFERENCES journeys(id) ON DELETE SET NULL,
    step_id UUID REFERENCES steps(id) ON DELETE SET NULL,
    
    -- Event details
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB DEFAULT '{}',
    
    -- Timing
    duration_ms INTEGER,
    
    -- Session/device context
    session_id VARCHAR(100),
    device_type VARCHAR(20),
    browser VARCHAR(100),
    os VARCHAR(50),
    screen_width INTEGER,
    screen_height INTEGER,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Indexes for efficient querying
  `CREATE INDEX IF NOT EXISTS idx_journey_events_org ON journey_events(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journey_events_journey ON journey_events(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journey_events_end_user ON journey_events(end_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journey_events_invitation ON journey_events(invitation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journey_events_step ON journey_events(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journey_events_type ON journey_events(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_journey_events_created ON journey_events(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_journey_events_session ON journey_events(session_id)`,
  
  // Composite index for common query patterns
  `CREATE INDEX IF NOT EXISTS idx_journey_events_journey_type ON journey_events(journey_id, event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_journey_events_user_journey ON journey_events(end_user_id, journey_id)`,

  // ============================================
  // QUIZ ATTEMPTS - Detailed quiz performance tracking
  // ============================================
  // Stores each quiz attempt with detailed per-question results
  // Supports both private (with end_user) and public (anonymous) journeys
  
  `CREATE TABLE IF NOT EXISTS quiz_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Journey/Step context
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    
    -- User context (nullable for public journeys)
    invitation_id UUID REFERENCES invitations(id) ON DELETE CASCADE,
    end_user_id UUID REFERENCES end_users(id) ON DELETE SET NULL,
    session_id VARCHAR(100), -- For anonymous/public journey tracking
    
    -- Attempt details
    attempt_number INTEGER DEFAULT 1,
    
    -- Results
    total_questions INTEGER NOT NULL,
    correct_count INTEGER NOT NULL,
    score_percentage INTEGER NOT NULL,
    passed BOOLEAN DEFAULT FALSE,
    
    -- Timing
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,
    
    -- Detailed per-question results (JSONB array)
    -- Format: [{question_index, question_text, correct, selected_answer, correct_answer, time_ms}]
    question_results JSONB DEFAULT '[]',
    
    -- Device info for analytics
    device_type VARCHAR(20),
    browser VARCHAR(100),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Indexes for quiz_attempts
  `CREATE INDEX IF NOT EXISTS idx_quiz_attempts_org ON quiz_attempts(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quiz_attempts_journey ON quiz_attempts(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quiz_attempts_step ON quiz_attempts(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quiz_attempts_end_user ON quiz_attempts(end_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quiz_attempts_invitation ON quiz_attempts(invitation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quiz_attempts_session ON quiz_attempts(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_quiz_attempts_passed ON quiz_attempts(passed)`,

  // ============================================
  // VIDEO WATCH SESSIONS - Video engagement tracking
  // ============================================
  // Tracks how users interact with video content
  
  `CREATE TABLE IF NOT EXISTS video_watch_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Journey/Step context
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    
    -- User context (nullable for public journeys)
    invitation_id UUID REFERENCES invitations(id) ON DELETE CASCADE,
    end_user_id UUID REFERENCES end_users(id) ON DELETE SET NULL,
    session_id VARCHAR(100),
    
    -- Video info
    video_url TEXT,
    video_duration_sec INTEGER,
    
    -- Watch metrics
    watch_time_sec INTEGER DEFAULT 0,
    max_position_sec INTEGER DEFAULT 0,
    watch_percentage INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    
    -- Engagement
    pause_count INTEGER DEFAULT 0,
    seek_count INTEGER DEFAULT 0,
    
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Indexes for video_watch_sessions
  `CREATE INDEX IF NOT EXISTS idx_video_watch_org ON video_watch_sessions(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_video_watch_journey ON video_watch_sessions(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_video_watch_step ON video_watch_sessions(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_video_watch_end_user ON video_watch_sessions(end_user_id)`,

  // ============================================
  // FORM SUBMISSIONS ANALYTICS
  // ============================================
  // Track form completion metrics (separate from actual form data)
  
  `CREATE TABLE IF NOT EXISTS form_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Journey/Step context
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    
    -- User context
    invitation_id UUID REFERENCES invitations(id) ON DELETE CASCADE,
    end_user_id UUID REFERENCES end_users(id) ON DELETE SET NULL,
    session_id VARCHAR(100),
    
    -- Form metrics (no actual form data, just analytics)
    total_fields INTEGER NOT NULL,
    filled_fields INTEGER NOT NULL,
    completion_percentage INTEGER NOT NULL,
    
    -- Timing
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    duration_ms INTEGER,
    
    -- Field-level timing (JSONB array, no actual values)
    -- Format: [{field_index, field_type, time_to_complete_ms}]
    field_timings JSONB DEFAULT '[]',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Indexes for form_analytics
  `CREATE INDEX IF NOT EXISTS idx_form_analytics_org ON form_analytics(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_form_analytics_journey ON form_analytics(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_form_analytics_step ON form_analytics(step_id)`,

  // ============================================
  // AI GUIDE CHAT ANALYTICS
  // ============================================
  // Tracks AI Guide conversations for support analytics
  
  `CREATE TABLE IF NOT EXISTS guide_chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Journey/Step context
    journey_id UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    guide_id UUID REFERENCES guides(id) ON DELETE SET NULL,
    
    -- User context
    invitation_id UUID REFERENCES invitations(id) ON DELETE CASCADE,
    end_user_id UUID REFERENCES end_users(id) ON DELETE SET NULL,
    session_id VARCHAR(100),
    
    -- Session metrics
    message_count INTEGER DEFAULT 0,
    user_message_count INTEGER DEFAULT 0,
    guide_response_count INTEGER DEFAULT 0,
    
    -- Timing
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    total_duration_ms INTEGER DEFAULT 0,
    
    -- Context: from which steps did user ask questions
    -- Format: [{step_id, step_title, step_type}]
    steps_used JSONB DEFAULT '[]',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  
  // Remove questions_asked column if it exists (contained message content)
  `ALTER TABLE guide_chat_sessions DROP COLUMN IF EXISTS questions_asked`,
  
  // Indexes for guide_chat_sessions
  `CREATE INDEX IF NOT EXISTS idx_guide_chat_org ON guide_chat_sessions(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_guide_chat_journey ON guide_chat_sessions(journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_guide_chat_guide ON guide_chat_sessions(guide_id)`,
  `CREATE INDEX IF NOT EXISTS idx_guide_chat_end_user ON guide_chat_sessions(end_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_guide_chat_invitation ON guide_chat_sessions(invitation_id)`,

  // ============================================
  // GUIDE CHAT MESSAGES (individual messages)
  // ============================================
  // REMOVED: guide_chat_messages table
  // We only store session-level counts, not individual messages (for database efficiency)
  // Drop the table if it exists from previous versions
  `DROP TABLE IF EXISTS guide_chat_messages`,

  // ============================================
  // DEMO JOURNEYS - System-level onboarding tours
  // ============================================
  // Central demo journeys that are shown to all organizations
  // These are managed by super admins and displayed read-only to makers
  
  `CREATE TABLE IF NOT EXISTS demo_journeys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Language for this demo journey (en, nl, de, fr, es)
    language VARCHAR(10) NOT NULL DEFAULT 'en',
    
    -- Target role: which maker role sees this demo (null = all roles)
    target_role VARCHAR(50), -- 'admin', 'manager', 'editor', 'viewer', or NULL for all
    
    -- Journey content
    title VARCHAR(255) NOT NULL,
    description TEXT,
    cover_image_url VARCHAR(500),
    
    -- Journey structure stored as JSONB (steps, paths, etc.)
    journey_data JSONB NOT NULL DEFAULT '{}',
    
    -- Version tracking for updates
    version INTEGER DEFAULT 1,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure one active demo journey per language/role combination
    UNIQUE(language, target_role)
  )`,
  
  // Index for quick lookups
  `CREATE INDEX IF NOT EXISTS idx_demo_journeys_lang_role ON demo_journeys(language, target_role) WHERE is_active = true`,

  // ============================================
  // USER ONBOARDING STATE - Track onboarding progress per user
  // ============================================
  
  `CREATE TABLE IF NOT EXISTS user_onboarding (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Onboarding state
    has_seen_welcome BOOLEAN DEFAULT false,
    has_started_tour BOOLEAN DEFAULT false,
    has_completed_tour BOOLEAN DEFAULT false,
    has_skipped_tour BOOLEAN DEFAULT false,
    
    -- Track which demo journey version was seen
    demo_journey_version INTEGER,
    
    -- Contextual hints state (JSONB object tracking which hints were shown)
    hints_shown JSONB DEFAULT '{}',
    
    -- Timestamps
    welcome_seen_at TIMESTAMP WITH TIME ZONE,
    tour_started_at TIMESTAMP WITH TIME ZONE,
    tour_completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id)
  )`,
  
  `CREATE INDEX IF NOT EXISTS idx_user_onboarding_user ON user_onboarding(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_onboarding_org ON user_onboarding(organization_id)`,

  // ============================================
  // WEBHOOK IDEMPOTENCY
  // ============================================
  `CREATE TABLE IF NOT EXISTS processed_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(255) UNIQUE NOT NULL,
    event_type VARCHAR(100),
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_id ON processed_webhook_events(event_id)`,

  // ============================================
  // MISSING INDEXES (performance)
  // ============================================
  `CREATE INDEX IF NOT EXISTS idx_media_org_created ON media(organization_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_user_invites_token_hash ON user_invites(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_journeys_active ON journeys(organization_id) WHERE deleted_at IS NULL`,

  // ============================================
  // MISSING FK INDEXES (performance for JOINs and CASCADE DELETEs)
  // ============================================
  `CREATE INDEX IF NOT EXISTS idx_reward_codes_org ON reward_codes(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reward_codes_invitation ON reward_codes(claimed_by_invitation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_video_watch_invitation ON video_watch_sessions(invitation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_form_analytics_invitation ON form_analytics(invitation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_form_analytics_end_user ON form_analytics(end_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invitations_created_by ON invitations(created_by)`,
  `CREATE INDEX IF NOT EXISTS idx_journeys_created_by ON journeys(created_by)`,
  `CREATE INDEX IF NOT EXISTS idx_media_uploaded_by ON media(uploaded_by)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_user ON usage_events(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_email_logs_step ON email_logs(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_end_user_progress_step ON end_user_progress(current_step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_journey_events_parent ON journey_events(parent_journey_id)`,
  `CREATE INDEX IF NOT EXISTS idx_limit_notifications_ack_by ON limit_notifications(acknowledged_by)`,
  `CREATE INDEX IF NOT EXISTS idx_paths_resource ON paths(requires_resource_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_participants_step ON public_participants(current_step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_public_reward_claims_reward ON public_reward_claims(reward_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_invites_invited_by ON user_invites(invited_by)`,
  `CREATE INDEX IF NOT EXISTS idx_user_progress_step ON user_progress(current_step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orgs_active_theme ON organizations(active_theme_id)`,

  // ============================================
  // REMOVE REDUNDANT INDEXES (covered by UNIQUE constraints)
  // ============================================
  `DROP INDEX IF EXISTS idx_invitations_token`,
  `DROP INDEX IF EXISTS idx_media_analyses_url_hash`,
  `DROP INDEX IF EXISTS idx_end_user_group_members_group`,

  // ============================================
  // DATA TYPE FIXES
  // ============================================
  `ALTER TABLE media ALTER COLUMN size_bytes TYPE BIGINT`,

  // ============================================
  // AUTOMATIC updated_at TRIGGERS
  // ============================================
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN
     NEW.updated_at = NOW();
     RETURN NEW;
   END;
   $$ language 'plpgsql'`,

  `DO $$ 
   DECLARE
     tbl TEXT;
   BEGIN
     FOR tbl IN SELECT unnest(ARRAY[
       'organizations', 'users', 'user_invites', 'journeys', 'steps', 'guides',
       'end_users', 'end_user_groups', 'knowledge_sources', 'media_analyses',
       'themes', 'polls', 'rewards', 'organization_usage', 'public_participants',
       'user_onboarding'
     ])
     LOOP
       IF NOT EXISTS (
         SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || tbl || '_updated_at'
       ) THEN
         EXECUTE format(
           'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
           tbl, tbl
         );
       END IF;
     END LOOP;
   END $$`,

  // ============================================
  // VECTOR INDEX UPGRADE: IVFFlat -> HNSW
  // ============================================
  `DROP INDEX IF EXISTS idx_knowledge_chunks_embedding`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_knowledge_chunks_embedding_hnsw') THEN
       CREATE INDEX idx_knowledge_chunks_embedding_hnsw ON knowledge_chunks 
       USING hnsw (embedding vector_cosine_ops);
     END IF;
   EXCEPTION WHEN OTHERS THEN
     RAISE NOTICE 'HNSW index creation skipped: %', SQLERRM;
   END $$`,

  // ============================================
  // ROW LEVEL SECURITY (tenant isolation)
  // ============================================

  // RLS policies on all tables with organization_id
  `DO $$
   DECLARE
     tbl TEXT;
   BEGIN
     FOR tbl IN SELECT unnest(ARRAY[
       'users', 'guides', 'journeys', 'end_users', 'end_user_groups', 'media',
       'knowledge_sources', 'knowledge_chunks', 'invitations', 'polls', 'poll_responses',
       'rewards', 'reward_codes', 'floorplans', 'themes', 'email_logs', 'usage_events',
       'limit_notifications', 'organization_usage', 'journey_events', 'form_analytics',
       'quiz_attempts', 'video_watch_sessions', 'guide_chat_sessions', 'user_onboarding',
       'user_invites', 'public_participants'
     ])
     LOOP
       EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
       
       -- Drop existing policy if it exists, then recreate
       BEGIN
         EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', tbl);
       EXCEPTION WHEN OTHERS THEN NULL;
       END;
       
       EXECUTE format(
         'CREATE POLICY org_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)',
         tbl
       );
     END LOOP;
   END $$`,

  // ============================================
  // STEP VISITS (replace UUID arrays for progress tracking)
  // ============================================
  `CREATE TABLE IF NOT EXISTS step_visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    progress_id UUID NOT NULL,
    progress_type VARCHAR(20) NOT NULL,
    step_id UUID NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    visited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(progress_id, step_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_step_visits_progress ON step_visits(progress_id)`,
  `CREATE INDEX IF NOT EXISTS idx_step_visits_step ON step_visits(step_id)`,
  `CREATE INDEX IF NOT EXISTS idx_step_visits_type ON step_visits(progress_type)`,

  // Migrate existing visited_steps arrays from end_user_progress
  `DO $$
   DECLARE
     rec RECORD;
     step_uuid UUID;
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM step_visits LIMIT 1) THEN
       FOR rec IN SELECT id, visited_steps FROM end_user_progress WHERE visited_steps IS NOT NULL AND array_length(visited_steps, 1) > 0
       LOOP
         FOREACH step_uuid IN ARRAY rec.visited_steps
         LOOP
           BEGIN
             INSERT INTO step_visits (progress_id, progress_type, step_id)
             VALUES (rec.id, 'end_user', step_uuid)
             ON CONFLICT (progress_id, step_id) DO NOTHING;
           EXCEPTION WHEN foreign_key_violation THEN
             NULL;
           END;
         END LOOP;
       END LOOP;
       
       FOR rec IN SELECT id, visited_steps FROM user_progress WHERE visited_steps IS NOT NULL AND array_length(visited_steps, 1) > 0
       LOOP
         FOREACH step_uuid IN ARRAY rec.visited_steps
         LOOP
           BEGIN
             INSERT INTO step_visits (progress_id, progress_type, step_id)
             VALUES (rec.id, 'user', step_uuid)
             ON CONFLICT (progress_id, step_id) DO NOTHING;
           EXCEPTION WHEN foreign_key_violation THEN
             NULL;
           END;
         END LOOP;
       END LOOP;
     END IF;
   END $$`,

  // ============================================
  // JOURNEY EVENTS PARTITIONING
  // ============================================
  // Create a partitioned replacement table for journey_events
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'journey_events_partitioned' AND relkind = 'p') THEN
       CREATE TABLE journey_events_partitioned (
         id UUID DEFAULT gen_random_uuid(),
         organization_id UUID NOT NULL,
         invitation_id UUID,
         end_user_id UUID,
         journey_id UUID NOT NULL,
         parent_journey_id UUID,
         step_id UUID,
         event_type VARCHAR(50) NOT NULL,
         event_data JSONB DEFAULT '{}',
         duration_ms INTEGER,
         session_id VARCHAR(100),
         device_type VARCHAR(20),
         browser VARCHAR(100),
         os VARCHAR(50),
         screen_width INTEGER,
         screen_height INTEGER,
         created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
         PRIMARY KEY (id, created_at)
       ) PARTITION BY RANGE (created_at);
     END IF;
   END $$`,

  // Rename resend_id to email_provider_id (migration from Resend to Nuntly)
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_invites' AND column_name = 'resend_id') THEN
      ALTER TABLE user_invites RENAME COLUMN resend_id TO email_provider_id;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'email_logs' AND column_name = 'resend_id') THEN
      ALTER TABLE email_logs RENAME COLUMN resend_id TO email_provider_id;
    END IF;
  END $$`,

  // Create default partition for existing and current data
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'journey_events_partitioned' AND relkind = 'p') THEN
       -- Create a partition for current quarter
       EXECUTE format(
         'CREATE TABLE IF NOT EXISTS journey_events_y%sq%s PARTITION OF journey_events_partitioned FOR VALUES FROM (%L) TO (%L)',
         extract(year FROM NOW())::int,
         extract(quarter FROM NOW())::int,
         date_trunc('quarter', NOW()),
         date_trunc('quarter', NOW()) + interval '3 months'
       );
       -- Create next quarter partition
       EXECUTE format(
         'CREATE TABLE IF NOT EXISTS journey_events_y%sq%s PARTITION OF journey_events_partitioned FOR VALUES FROM (%L) TO (%L)',
         extract(year FROM NOW() + interval '3 months')::int,
         extract(quarter FROM NOW() + interval '3 months')::int,
         date_trunc('quarter', NOW() + interval '3 months'),
         date_trunc('quarter', NOW() + interval '3 months') + interval '3 months'
       );
       -- Create a default partition for old data
       BEGIN
         CREATE TABLE IF NOT EXISTS journey_events_default PARTITION OF journey_events_partitioned DEFAULT;
       EXCEPTION WHEN OTHERS THEN NULL;
       END;
     END IF;
   END $$`,

  // G1: GDPR — store proof of terms/privacy consent at signup
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_agreed_at TIMESTAMP WITH TIME ZONE`,

  // G8: GDPR — separate marketing consent from ToS agreement
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent_at TIMESTAMP WITH TIME ZONE`,

  // ============================================
  // FORM SUBMISSIONS: ORG SCOPING + SECURE FILE STORAGE
  // ============================================
  // Form submissions become first-class, org-scoped data so makers can view
  // them in Analytics. Uploaded files are stored on disk (not emailed as
  // attachments) and shared via secure, expiring download links.

  // Add organization_id to both submission tables (backfilled from journeys)
  `ALTER TABLE private_form_submissions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE`,
  `UPDATE private_form_submissions pfs SET organization_id = j.organization_id
   FROM journeys j WHERE pfs.journey_id = j.id AND pfs.organization_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_private_form_submissions_org ON private_form_submissions(organization_id)`,

  `ALTER TABLE public_form_submissions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE`,
  `UPDATE public_form_submissions pfs SET organization_id = j.organization_id
   FROM journeys j WHERE pfs.journey_id = j.id AND pfs.organization_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_public_form_submissions_org ON public_form_submissions(organization_id)`,

  // Keep submission history when a journey/step is deleted: archive the
  // titles on the submission itself so Analytics can still show context.
  `ALTER TABLE private_form_submissions ADD COLUMN IF NOT EXISTS journey_title VARCHAR(255)`,
  `ALTER TABLE private_form_submissions ADD COLUMN IF NOT EXISTS step_title VARCHAR(255)`,
  `ALTER TABLE public_form_submissions ADD COLUMN IF NOT EXISTS journey_title VARCHAR(255)`,
  `ALTER TABLE public_form_submissions ADD COLUMN IF NOT EXISTS step_title VARCHAR(255)`,

  // Files uploaded via form steps. Stored in uploads/form-submissions/{orgId}/
  // (outside the org media tree, so they are never served by the media routes).
  // Recipients download them via an unguessable, expiring token; makers via an
  // authenticated, org-checked Analytics endpoint.
  `CREATE TABLE IF NOT EXISTS form_submission_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Exactly one of these is set for player submissions; both NULL for
    -- builder preview submissions (which only send the notification email).
    private_submission_id UUID REFERENCES private_form_submissions(id) ON DELETE CASCADE,
    public_submission_id UUID REFERENCES public_form_submissions(id) ON DELETE CASCADE,
    
    -- Context (kept even if journey/step rows disappear)
    journey_id UUID,
    step_id UUID,
    field_label VARCHAR(255),
    
    -- File metadata
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT,
    storage_path VARCHAR(500) NOT NULL,
    
    -- Secure download link for the email recipient
    download_token VARCHAR(64) NOT NULL UNIQUE,
    download_token_expires_at TIMESTAMP WITH TIME ZONE,
    download_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_form_submission_files_org ON form_submission_files(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_form_submission_files_private ON form_submission_files(private_submission_id)`,
  `CREATE INDEX IF NOT EXISTS idx_form_submission_files_public ON form_submission_files(public_submission_id)`,

  // RLS (tenant isolation) for form submission tables — same org_isolation
  // policy as all other org-scoped tables.
  `DO $$
   DECLARE
     tbl TEXT;
   BEGIN
     FOR tbl IN SELECT unnest(ARRAY[
       'private_form_submissions', 'public_form_submissions', 'form_submission_files'
     ])
     LOOP
       EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
       
       BEGIN
         EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', tbl);
       EXCEPTION WHEN OTHERS THEN NULL;
       END;
       
       EXECUTE format(
         'CREATE POLICY org_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid)',
         tbl
       );
     END LOOP;
   END $$`,

  // ============================================
  // LIFECYCLE EMAILS (behaviour-triggered help and tips for free-tier makers)
  // ============================================
  // One row per email actually sent (or dry-run / failed) so every email key
  // goes out at most once per user and frequency caps can be enforced.
  `CREATE TABLE IF NOT EXISTS lifecycle_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email_key VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'sent',
    language VARCHAR(5),
    provider_email_id VARCHAR(100),
    snapshot JSONB,
    error_message TEXT,
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lifecycle_emails_user_key ON lifecycle_emails(user_id, email_key)`,
  `CREATE INDEX IF NOT EXISTS idx_lifecycle_emails_org ON lifecycle_emails(organization_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lifecycle_emails_sent_at ON lifecycle_emails(sent_at)`,

  // Master switch for lifecycle emails (the unsubscribe link in those emails
  // turns this off) and a per-user token for one-click unsubscribe links.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS lifecycle_emails_enabled BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_unsubscribe_token VARCHAR(64)`,
  `UPDATE users
   SET email_unsubscribe_token = md5(random()::text || clock_timestamp()::text || id::text)
                                 || md5(clock_timestamp()::text || random()::text || email)
   WHERE email_unsubscribe_token IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unsubscribe_token ON users(email_unsubscribe_token)`,

  // Accounts created before the marketing-consent checkbox existed never had
  // the chance to tick it. Product decision (Sept 2026): treat them as opted
  // in. Those accounts are recognisable by the missing terms_agreed_at, which
  // was introduced together with the consent checkbox. They can opt out at any
  // time via Settings or the unsubscribe link; the source column makes sure
  // this one-off never re-applies after such an opt-out.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent_source VARCHAR(20)`,
  `UPDATE users
   SET marketing_consent_at = NOW(), marketing_consent_source = 'legacy_optin'
   WHERE terms_agreed_at IS NULL AND marketing_consent_at IS NULL AND marketing_consent_source IS NULL`,

  `DO $$
   BEGIN
     ALTER TABLE lifecycle_emails ENABLE ROW LEVEL SECURITY;
     BEGIN
       DROP POLICY IF EXISTS org_isolation ON lifecycle_emails;
     EXCEPTION WHEN OTHERS THEN NULL;
     END;
     CREATE POLICY org_isolation ON lifecycle_emails
       USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
       WITH CHECK (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
   END $$`,

  // 2026-10: raise the AI knowledge (chunk) limits per tier. Idempotent: only
  // touches rows that still have the old values, so manually adjusted tiers
  // (admin-cli) are left alone.
  `UPDATE subscription_tiers SET max_knowledge_chunks = 500 WHERE name = 'free' AND max_knowledge_chunks = 100`,
  `UPDATE subscription_tiers SET max_knowledge_chunks = 7000 WHERE name = 'professional' AND max_knowledge_chunks = 2500`,
  `UPDATE subscription_tiers SET max_knowledge_chunks = 50000 WHERE name = 'enterprise' AND max_knowledge_chunks = 15000`,

  // 2026-10: media.updated_at is used by the media URL update in api.js but was
  // never part of this schema (existing databases already have it).
  `ALTER TABLE media ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()`,

  // 2026-10: "remember me" for public journeys needs a secret, not just the
  // email address. Only the SHA-256 hash of the token is stored.
  `ALTER TABLE public_participants ADD COLUMN IF NOT EXISTS remember_token_hash VARCHAR(64)`,

  // 2026-10: oauth_connections was an unused copy of the OAuth tokens on
  // organizations, and kept them after an organization disconnected.
  `DROP TABLE IF EXISTS oauth_connections`,

  // Tier features that used to be "Enterprise and up" checks on sort_order
  `ALTER TABLE subscription_tiers ADD COLUMN IF NOT EXISTS public_journeys BOOLEAN DEFAULT false`,
  `UPDATE subscription_tiers SET public_journeys = true WHERE name IN ('enterprise', 'custom')`,
  `UPDATE subscription_tiers SET custom_branding = true WHERE name IN ('enterprise', 'custom')`,

  // Community Edition: one organization per installation, no limits, every
  // feature on. Inactive, so it never shows as a plan in Gryffi Cloud.
  `INSERT INTO subscription_tiers (name, display_name, description, price_monthly, price_yearly,
     max_journeys, max_guides, max_makers, max_end_users, max_knowledge_chunks, max_ai_credits_monthly,
     sync_enabled, priority_support, dedicated_support, custom_branding, api_access, public_journeys,
     trash_retention_days, backup_retention_days, sort_order, is_active)
   VALUES ('community', 'Community Edition', 'Self-hosted, one organization, no limits', 0, 0,
     -1, -1, -1, -1, -1, -1,
     true, false, false, true, true, true,
     30, 0, 0, false)
   ON CONFLICT (name) DO NOTHING`,

  // Installation settings (services/settings.js). The Community Edition keeps
  // its configuration here instead of in .env; secrets are encrypted
  // (enc:v1:..., same key as the OAuth tokens). Gryffi Cloud leaves it empty
  // and keeps using .env.
  `CREATE TABLE IF NOT EXISTS instance_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS instance_settings_audit (
    id BIGSERIAL PRIMARY KEY,
    key VARCHAR(100) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_instance_settings_audit_changed_at ON instance_settings_audit(changed_at DESC)`
];

async function migrate() {
  console.log('🚀 Starting Gryffi Hybrid database migration...\n');
  
  const client = await getClient();
  
  try {
    await client.query('BEGIN');
    
    for (const sql of migrations) {
      // eslint-disable-next-line security/detect-unsafe-regex -- runs against hard-coded migration SQL, never against user input
      const match = sql.match(/(?:CREATE\s+(?:TABLE|INDEX)|DROP\s+TABLE).*?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\w+)/i);
      const name = match?.[1] || 'query';
      process.stdout.write(`  ${sql.startsWith('DROP') ? 'Dropping' : 'Creating'} ${name}... `);
      await client.query(sql);
      console.log('✅');
    }
    
    await client.query('COMMIT');
    console.log('\n✨ Migration completed successfully!');
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

migrate();
