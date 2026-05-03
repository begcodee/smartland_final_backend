import pool from "../config/db.js";

// GET all lands
export const getLands = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        lands.*,
        users.full_name as owner_name,
        users.email as owner_email
      FROM lands
      LEFT JOIN users ON lands.owner_id = users.id
      ORDER BY lands.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch lands" });
  }
};

// GET lands by user
export const getLandsByUser = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      `SELECT 
        lands.*,
        users.full_name as owner_name,
        users.email as owner_email
      FROM lands
      LEFT JOIN users ON lands.owner_id = users.id
      WHERE lands.owner_id = $1
      ORDER BY lands.created_at DESC`,
      [userId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch user lands" });
  }
};

// POST create land
export const createLand = async (req, res) => {
  try {
    const { 
      land_name, 
      location, 
      size, 
      coordinates, 
      owner_id, 
      land_type, 
      description 
    } = req.body;

    // Validate required fields
    if (!land_name || !location || !size || !owner_id) {
      return res.status(400).json({ 
        error: "Missing required fields: land_name, location, size, owner_id" 
      });
    }

    // Check if owner exists
    const ownerCheck = await pool.query(
      "SELECT id FROM users WHERE id = $1",
      [owner_id]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json({ error: "Owner user not found" });
    }

    const result = await pool.query(
      `INSERT INTO lands (land_name, location, size, coordinates, owner_id, land_type, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [land_name, location, size, coordinates, owner_id, land_type, description]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create land" });
  }
};

// POST transfer land ownership
export const transferLandOwnership = async (req, res) => {
  try {
    const { id } = req.params;
    const { new_owner_id, transfer_reason } = req.body;

    if (!new_owner_id) {
      return res.status(400).json({ error: "new_owner_id is required" });
    }

    // Start a transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if land exists and get current owner
      const landCheck = await client.query(
        "SELECT * FROM lands WHERE id = $1",
        [id]
      );

      if (landCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "Land not found" });
      }

      const land = landCheck.rows[0];

      // Check if new owner exists
      const newOwnerCheck = await client.query(
        "SELECT id, full_name FROM users WHERE id = $1",
        [new_owner_id]
      );

      if (newOwnerCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "New owner user not found" });
      }

      // Check if new owner is different from current owner
      if (land.owner_id === parseInt(new_owner_id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: "New owner is the same as current owner" 
        });
      }

      // Get current owner info
      const currentOwnerResult = await client.query(
        "SELECT full_name FROM users WHERE id = $1",
        [land.owner_id]
      );

      // Update land ownership
      const updateResult = await client.query(
        `UPDATE lands 
         SET owner_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [new_owner_id, id]
      );

      // Record the transfer in a transfers table (if it exists)
      // This is optional but good practice for audit trail
      try {
        await client.query(
          `INSERT INTO land_transfers 
           (land_id, from_owner_id, to_owner_id, transfer_reason, transfer_date)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
          [id, land.owner_id, new_owner_id, transfer_reason || 'Ownership transfer']
        );
      } catch (transferLogError) {
        // If transfers table doesn't exist, continue anyway
        console.log("Transfer log table may not exist, skipping...");
      }

      await client.query('COMMIT');

      res.json({
        message: "Land ownership transferred successfully",
        land: updateResult.rows[0],
        transfer_details: {
          from: currentOwnerResult.rows[0]?.full_name || "Unknown",
          to: newOwnerCheck.rows[0].full_name,
          reason: transfer_reason || "Ownership transfer"
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to transfer land ownership" });
  }
};
