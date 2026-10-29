/**
 * PostgreSQL Database Connection
 * Connects to gryffi-db container via Docker internal network
 * 
 * Pool settings are configurable via environment variables:
 * - DB_POOL_MAX: Max connections (dev: 20, prod: 80)
 * - DB_POOL_IDLE_TIMEOUT: Idle timeout in ms (dev: 30000, prod: 60000)
 * - DB_POOL_CONNECTION_TIMEOUT: Connection timeout in ms (dev: 2000, prod: 5000)
 * 
 * RLS (Row Level Security) enforcement:
 * - orgContextMiddleware acquires a per-request client with SET ROLE gryffi_app
 * - query() checks AsyncLocalStorage for an org-scoped client
 * - If present, uses it (RLS enforced); otherwise falls back to pool (superuser, no RLS)
 * - runWithOrg() provides the same mechanism for background jobs
 */
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT) || 2000,
});

pool.on('error', (err) => {
  console.error('[Database] Unexpected idle client error:', err.message);
});

const orgContext = new AsyncLocalStorage();

const RLS_ROLE = 'gryffi_app';

/**
 * Run a database query. If an org-scoped client exists in AsyncLocalStorage
 * (set by orgContextMiddleware or runWithOrg), that client is used and RLS
 * is enforced. Otherwise falls back to the superuser pool (no RLS).
 */
export const query = async (text, params) => {
  const ctx = orgContext.getStore();
  const start = Date.now();
  try {
    let res;
    if (ctx && ctx.released) {
      // Work that continues after the response (e.g. knowledge processing)
      // must not use the request's client: it is back in the pool and may
      // already serve another organization. Run with a fresh client instead.
      res = await queryAsOrg(ctx.orgId, text, params);
    } else {
      res = await (ctx ? ctx.client : pool).query(text, params);
    }
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development' && duration > 100) {
      console.log('🐢 Slow query:', { text, duration: `${duration}ms`, rows: res.rowCount });
    }
    return res;
  } catch (err) {
    console.error('Database query error:', { text, error: err.message });
    throw err;
  }
};

/**
 * Express middleware that creates a per-request database client with
 * SET ROLE gryffi_app and app.current_org_id for RLS enforcement.
 * Must be registered AFTER tenantFilter (which sets req.organizationId).
 * Requests without org context (public routes) skip this and use the
 * superuser pool, bypassing RLS.
 */
export async function orgContextMiddleware(req, res, next) {
  if (!req.organizationId) return next();

  let client;
  let released = false;
  try {
    client = await pool.connect();
    await client.query(`SET ROLE ${RLS_ROLE}`);
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [req.organizationId]);

    const ctx = { client, orgId: req.organizationId, released: false };
    const cleanup = () => {
      if (released) return;
      released = true;
      ctx.released = true;
      client.query(`RESET ROLE`).catch(() => {})
        .then(() => client.query(`RESET app.current_org_id`).catch(() => {}))
        .then(() => client.release())
        .catch(() => { try { client.release(); } catch (_) {} });
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);

    orgContext.run(ctx, next);
  } catch (err) {
    if (client && !released) { released = true; client.release(); }
    next(err);
  }
}

/**
 * Run a function with RLS org context outside of an HTTP request
 * (e.g., scheduler jobs). Acquires a client, sets the role + org,
 * executes fn, then cleans up.
 */
export async function runWithOrg(orgId, fn) {
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${RLS_ROLE}`);
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
    return await orgContext.run({ client, orgId, released: false }, fn);
  } finally {
    await client.query(`RESET ROLE`).catch(() => {});
    await client.query(`RESET app.current_org_id`).catch(() => {});
    client.release();
  }
}

/**
 * Run one query with RLS context for an organization on its own client.
 */
async function queryAsOrg(orgId, text, params) {
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${RLS_ROLE}`);
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
    return await client.query(text, params);
  } finally {
    await client.query(`RESET ROLE`).catch(() => {});
    await client.query(`RESET app.current_org_id`).catch(() => {});
    client.release();
  }
}

export const getClient = () => pool.connect();

export default pool;
