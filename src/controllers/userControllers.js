import { getPool } from "../config/db.js";

// GET all users
export const getUsers = async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not configured" });
  try {
    const result = await pool.query("SELECT * FROM users");
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// POST create user
export const createUser = async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database not configured" });
  try {
    const { full_name, email, national_id } = req.body;

    const result = await pool.query(
      `INSERT INTO users (full_name, email, national_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [full_name, email, national_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create user" });
  }
};