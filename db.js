import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

// Legacy pool helper (prefer `src/config/db.js` for main app runtime).
// Security hardening: never ship a default database password.
const pool = new Pool({
  user: process.env.PGUSER ?? "postgres",
  host: process.env.PGHOST ?? "localhost",
  database: process.env.PGDATABASE ?? "smartland",
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT ?? 5432),
});

if (!process.env.PGPASSWORD && (process.env.NODE_ENV === "production" || String(process.env.RENDER || "") === "true")) {
  throw new Error("[db] PGPASSWORD is required in production for legacy db.js pool");
}

export default pool;
