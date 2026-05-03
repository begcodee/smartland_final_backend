import "dotenv/config";

import { createPgPool } from "./src/config/db.js";

let pool;
try {
  pool = createPgPool();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

async function checkDatabase() {
  try {
    console.log("🔍 Checking existing database structure...\n");
    
    // Check what tables exist
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log("📋 Existing tables:");
    tables.rows.forEach(row => console.log(`  - ${row.table_name}`));
    
    // Check lands table structure if it exists
    if (tables.rows.some(row => row.table_name === 'lands')) {
      console.log("\n📊 Lands table columns:");
      const columns = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'lands'
        ORDER BY ordinal_position
      `);
      columns.rows.forEach(row => console.log(`  - ${row.column_name}: ${row.data_type}`));
    }
    
    // Check users table structure if it exists
    if (tables.rows.some(row => row.table_name === 'users')) {
      console.log("\n👥 Users table columns:");
      const columns = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'users'
        ORDER BY ordinal_position
      `);
      columns.rows.forEach(row => console.log(`  - ${row.column_name}: ${row.data_type}`));
    }
    
  } catch (error) {
    console.error("❌ Error:", error.message);
  } finally {
    await pool.end();
  }
}

checkDatabase();
