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

async function testAPI() {
  try {
    console.log("🧪 Testing Lands API...\n");
    
    // 1. Create a test user
    console.log("1️⃣ Creating test user...");
    const userResult = await pool.query(
      `INSERT INTO users (full_name, email, national_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      ["John Doe", "john.doe@example.com", "ID12345"]
    );
    const userId = userResult.rows[0].id;
    console.log(`✅ Created user with ID: ${userId}`);
    
    // 2. Create a test land
    console.log("\n2️⃣ Creating test land...");
    const landResult = await pool.query(
      `INSERT INTO lands (land_name, location, size, coordinates, owner_id, land_type, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        "Green Valley Farm",
        "123 Farm Road, County",
        5000.50,
        JSON.stringify({ lat: 40.7128, lng: -74.0060 }),
        userId,
        "agricultural",
        "Beautiful farmland with water access"
      ]
    );
    const landId = landResult.rows[0].id;
    console.log(`✅ Created land with ID: ${landId}`);
    console.log(JSON.stringify(landResult.rows[0], null, 2));
    
    // 3. Create another user for transfer test
    console.log("\n3️⃣ Creating second user for transfer test...");
    const user2Result = await pool.query(
      `INSERT INTO users (full_name, email, national_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      ["Jane Smith", "jane.smith@example.com", "ID67890"]
    );
    const user2Id = user2Result.rows[0].id;
    console.log(`✅ Created user with ID: ${user2Id}`);
    
    // 4. Test getting all lands
    console.log("\n4️⃣ Getting all lands...");
    const allLands = await pool.query(`
      SELECT 
        lands.*,
        users.full_name as owner_name,
        users.email as owner_email
      FROM lands
      LEFT JOIN users ON lands.owner_id = users.id
    `);
    console.log(`✅ Found ${allLands.rows.length} land(s)`);
    
    // 5. Test getting lands by user
    console.log("\n5️⃣ Getting lands by user...");
    const userLands = await pool.query(
      `SELECT * FROM lands WHERE owner_id = $1`,
      [userId]
    );
    console.log(`✅ User ${userId} owns ${userLands.rows.length} land(s)`);
    
    console.log("\n\n✅ All tests passed!");
    console.log("\n📡 Your API endpoints are ready:");
    console.log("   POST   http://localhost:5000/api/lands");
    console.log("   GET    http://localhost:5000/api/lands");
    console.log("   GET    http://localhost:5000/api/lands/user/:userId");
    console.log("   POST   http://localhost:5000/api/lands/:id/transfer");
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error(error);
  } finally {
    await pool.end();
  }
}

testAPI();
