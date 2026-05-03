import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

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
