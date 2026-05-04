import pkg from "pg";

const { Pool } = pkg;

let pool = null;

function sslExplicitlyDisabled() {
  return process.env.DB_SSL === "false";
}

function connectionStringNeedsSsl(urlStr) {
  if (sslExplicitlyDisabled()) return false;
  if (process.env.DB_SSL === "true") return true;
  const lower = urlStr.toLowerCase();
  if (
    lower.includes("sslmode=require") ||
    lower.includes("sslmode=verify-full") ||
    lower.includes("sslmode=no-verify")
  ) {
    return true;
  }
  const hostedMarkers = ["neon.tech", "amazonaws.com", "supabase.co", "render.com", "cockroachlabs.cloud"];
  return hostedMarkers.some((m) => lower.includes(m));
}

function hostNeedsSsl(host) {
  if (sslExplicitlyDisabled()) return false;
  if (process.env.DB_SSL === "true") return true;
  const h = String(host).toLowerCase();
  const hostedMarkers = ["neon.tech", "amazonaws.com", "supabase.co", "render.com", "cockroachlabs.cloud"];
  return hostedMarkers.some((m) => h.includes(m));
}

/** Postgres connection URI (direct pool). Supabase: Dashboard → Connect → Direct connection. */
function resolvedDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    null
  );
}

/**
 * Build pg Pool options when DATABASE_URL / SUPABASE_DATABASE_URL or DB_* is configured.
 */
export function createPoolConfig() {
  const connUrl = resolvedDatabaseUrl();
  if (connUrl) {
    const url = String(connUrl);
    const needsSsl = connectionStringNeedsSsl(url);
    return {
      connectionString: url,
      // Supabase session-mode pooler allows max 15 connections total.
      // Keep pool small so local dev + Render don't exhaust it simultaneously.
      max: Number(process.env.DB_POOL_MAX || 3),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    };
  }
  if (!process.env.DB_HOST) return null;
  const needsSsl = hostNeedsSsl(process.env.DB_HOST);
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  };
}

/**
 * New Pool for scripts (setup-database, check-database). Throws if DB env is missing.
 */
export function createPgPool() {
  const cfg = createPoolConfig();
  if (!cfg) {
    throw new Error(
      "[db] Configure DATABASE_URL (Supabase direct URI) or SUPABASE_DATABASE_URL, or DB_HOST + DB_PORT + DB_USER + DB_PASSWORD + DB_NAME."
    );
  }
  return new Pool(cfg);
}

export async function connectPostgres() {
  const cfg = createPoolConfig();
  if (!cfg) {
    console.log("[db] No DATABASE_URL / SUPABASE_DATABASE_URL or DB_HOST — API state stays in memory only.");
    return null;
  }
  const p = new Pool(cfg);
  try {
    const c = await p.connect();
    await c.query("SELECT 1");
    c.release();
    pool = p;
    console.log("[db] PostgreSQL connected — snapshots enabled.");
    return p;
  } catch (e) {
    console.error("[db] PostgreSQL connection failed:", e.message);
    await p.end().catch(() => {});
    pool = null;
    return null;
  }
}

export function getPool() {
  return pool;
}

export async function closePool() {
  if (!pool) return;
  await pool.end().catch(() => {});
  pool = null;
}
