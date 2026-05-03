import pool from "../config/db.js";

// GET all users
export const getUsers = async (req, res) => {
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