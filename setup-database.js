import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function setupDatabase() {
  const client = await pool.connect();
  
  try {
    console.log("🔗 Connecting to PostgreSQL...");
    
    // Read the schema file
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // Primary: single-row JSON snapshot (matches runtime persistence in index.js).
    const snapshotPath = join(__dirname, "src", "config", "schema_snapshot.sql");
    const snapshotSql = readFileSync(snapshotPath, "utf8");

    // Optional relational schema (drops/recreates tables — use only for greenfield SQL-backed apps).
    const relationalPath = join(__dirname, "src", "config", "schema.sql");
    let relationalSql = "";
    try {
      relationalSql = readFileSync(relationalPath, "utf8");
    } catch {
      relationalSql = "";
    }
    
    console.log("📝 Running database schema...");
    
    // Execute the schema in a transaction
    await client.query('BEGIN');
    await client.query(snapshotSql);
    if (process.env.RUN_RELATIONAL_SCHEMA === "1" && relationalSql) {
      console.log("📝 RUN_RELATIONAL_SCHEMA=1 — applying schema.sql (destructive DROP)…");
      await client.query(relationalSql);
    }
    await client.query('COMMIT');
    
    console.log("✅ Database setup completed successfully!");
    console.log("\nCreated / updated:");
    console.log("  - app_snapshots (JSON application state)");
    if (process.env.RUN_RELATIONAL_SCHEMA === "1") {
      console.log("  - users, lands, payments, … (relational schema.sql)");
    }
    console.log("\nStart the API with Postgres env vars set — state persists automatically.");
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("❌ Error setting up database:");
    console.error(error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setupDatabase();
