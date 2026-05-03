import pkg from "pg";

const { Pool } = pkg;

let pool = null;

/**
 * Build a pg Pool when DATABASE_URL or DB_HOST is configured.
 */
export function createPoolConfig() {
  if (process.env.DATABASE_URL) {
    const url = String(process.env.DATABASE_URL);
    const needsSsl =
      process.env.DB_SSL === "true" ||
      url.includes("neon.tech") ||
      url.includes("amazonaws.com") ||
      url.includes("supabase.co");
    return {
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    };
  }
  if (!process.env.DB_HOST) return null;
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
  };
}

export async function connectPostgres() {
  const cfg = createPoolConfig();
  if (!cfg) {
    console.log("[db] No DATABASE_URL or DB_HOST — API state stays in memory only.");
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
