import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  user: process.env.PGUSER ?? "postgres",
  host: process.env.PGHOST ?? "localhost",
  database: process.env.PGDATABASE ?? "smartland",
  password: process.env.PGPASSWORD ?? "Leslie123",
  port: Number(process.env.PGPORT ?? 5432),
});

export default pool;
