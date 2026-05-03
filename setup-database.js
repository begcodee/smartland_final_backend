import "dotenv/config";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

import { createPgPool } from "./src/config/db.js";

let pool;
try {
  pool = createPgPool();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

async function setupDatabase() {
  const client = await pool.connect();

  try {
    console.log("🔗 Connecting to PostgreSQL…");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    const smartlandPath = join(__dirname, "src", "config", "schema_sl.sql");
    const smartlandSql = readFileSync(smartlandPath, "utf8");

    const relationalPath = join(__dirname, "src", "config", "schema.sql");
    let relationalSql = "";
    try {
      relationalSql = readFileSync(relationalPath, "utf8");
    } catch {
      relationalSql = "";
    }

    console.log("📝 Running database schema…");

    await client.query("BEGIN");
    await client.query(smartlandSql);
    if (process.env.RUN_RELATIONAL_SCHEMA === "1" && relationalSql) {
      console.log("📝 RUN_RELATIONAL_SCHEMA=1 — applying schema.sql (destructive DROP)…");
      await client.query(relationalSql);
    }
    await client.query("COMMIT");

    console.log("✅ Database setup completed successfully!");
    console.log("\nCreated / updated:");
    console.log("  - sl_users, sl_parcels, sl_conversations, sl_payments, … (SmartLand relational tables)");
    if (process.env.RUN_RELATIONAL_SCHEMA === "1") {
      console.log("  - legacy users, lands, … (schema.sql)");
    }
    console.log("\nStart the API with DATABASE_URL set — state persists to sl_* tables.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error setting up database:");
    console.error(error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setupDatabase();
