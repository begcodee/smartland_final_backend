const express = require("express");
require("dotenv").config();
const pool = require("./src/config/db");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("SmartLand API running");
});

app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database not connected" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`🧪 Test DB: http://localhost:${PORT}/test-db`);
});