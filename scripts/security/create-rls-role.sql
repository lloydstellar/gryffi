-- ============================================================================
-- RLS role for per-request tenant isolation
-- ============================================================================
--
-- orgContextMiddleware (src/db/index.js) runs `SET ROLE gryffi_app` for every
-- tenant-scoped request. gryffi_app has no BYPASSRLS, so the org_isolation
-- policies from migrate.js are enforced for it.
--
-- The role is NOLOGIN: nobody connects as gryffi_app directly. The runtime
-- login role (gryffi_app_rt, see create-app-runtime-role.sql) is granted
-- membership so it can switch into it.
--
-- Run as the superuser (gryffi_user) on a NEW database, after the first
-- migration and before create-app-runtime-role.sql. SAFE TO RE-RUN.
--
-- Usage:
--   docker compose exec -T db psql -U gryffi_user -d gryffi_db \
--     -f - < scripts/security/create-rls-role.sql
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. Create the role (idempotent). An existing role is left as it is.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gryffi_app') THEN
    CREATE ROLE gryffi_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- 2. Privileges on everything the app touches.
GRANT USAGE ON SCHEMA public TO gryffi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gryffi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gryffi_app;

-- 3. Tables and sequences created later by migrations get the same rights.
ALTER DEFAULT PRIVILEGES FOR ROLE gryffi_user IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gryffi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gryffi_user IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gryffi_app;

-- 4. Verify (informational).
\echo 'RLS role attributes:'
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles WHERE rolname = 'gryffi_app';
