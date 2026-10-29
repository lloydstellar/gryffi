-- ============================================================================
-- K4 — Least-privilege runtime database role for the Gryffi app
-- ============================================================================
--
-- The bootstrap user `gryffi_user` is a Postgres SUPERUSER and cannot be
-- demoted (Postgres refuses to remove SUPERUSER from the bootstrap role).
-- Instead, the application connects at runtime as a separate, non-superuser
-- role `gryffi_app_rt`. `gryffi_user` is then only used for migrations / DDL.
--
-- `gryffi_app_rt`:
--   * NOT a superuser  -> no COPY ... PROGRAM RCE, no access to other databases
--                         on the same server, no reading pg_authid hashes,
--                         no creating roles, no disabling RLS.
--   * BYPASSRLS        -> required so the existing "no org context" fallback
--                         queries (login by email, magic-link token lookup,
--                         payment webhooks, public journey routes) keep working.
--                         When the app does `SET ROLE gryffi_app` per request,
--                         the current role becomes gryffi_app (no bypass) and
--                         RLS IS enforced for tenant-scoped traffic.
--   * member of gryffi_app -> can `SET ROLE gryffi_app` and inherits its grants.
--
-- Run as the superuser (gryffi_user). SAFE TO RE-RUN.
--
-- IMPORTANT: replace :'app_pw' below, or pass it on the command line:
--   docker compose exec -T db psql -U gryffi_user -d gryffi_db \
--     -v app_pw="<STRONG_PASSWORD>" -f - < scripts/security/create-app-runtime-role.sql
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. Create the role (idempotent) and (re)set its password + attributes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gryffi_app_rt') THEN
    CREATE ROLE gryffi_app_rt LOGIN;
  END IF;
END $$;

ALTER ROLE gryffi_app_rt
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  BYPASSRLS
  INHERIT
  PASSWORD :'app_pw';

-- 2. Let it assume the RLS role for per-request tenant isolation.
GRANT gryffi_app TO gryffi_app_rt;

-- 3. Schema + object privileges (every table/sequence the app touches,
--    including non-RLS tables such as steps/paths/resources).
GRANT USAGE ON SCHEMA public TO gryffi_app_rt;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gryffi_app_rt;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO gryffi_app_rt;

-- 4. Make sure FUTURE tables/sequences created by gryffi_user (migrations) are
--    automatically usable by the runtime role.
ALTER DEFAULT PRIVILEGES FOR ROLE gryffi_user IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gryffi_app_rt;
ALTER DEFAULT PRIVILEGES FOR ROLE gryffi_user IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO gryffi_app_rt;

-- 5. Verify (informational).
\echo 'Runtime role attributes:'
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
FROM pg_roles WHERE rolname IN ('gryffi_user', 'gryffi_app', 'gryffi_app_rt')
ORDER BY rolname;
