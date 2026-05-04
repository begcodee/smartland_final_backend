/**
 * Upsert a Lands Commission / admin login into sl_users with bcrypt password_hash.
 * Use when Render returns 401: wrong/missing hash, empty sl_users, or legacy hash stored only in profile JSON.
 *
 *   DEFAULT_ADMIN_EMAIL=you@example.com DEFAULT_ADMIN_PASSWORD='YourStrongPass' node scripts/ensure-admin-user.js
 *
 * Optional: DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_ROLE=admin|lands_commission, DEFAULT_ADMIN_ID, DEFAULT_ADMIN_STAFF_ID, DEFAULT_ADMIN_ORG
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { createPgPool } from "../src/config/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function ensureSchema(pool) {
  const sqlPath = join(__dirname, "..", "src", "config", "schema_sl.sql");
  const sql = readFileSync(sqlPath, "utf8");
  await pool.query(sql);
}

function buildProfile({ userId, email, name, role, staffId, organization }) {
  const now = new Date().toISOString();
  return {
    id: userId,
    email,
    name,
    role,
    phoneNumber: null,
    staffId,
    organization,
    arbitratorRegNo: null,
    createdAt: now,
    verified: true,
    niaStatus: "verified",
    niaReferenceId: null,
    niaVerifiedAt: now,
    idVerification: null,
    reputation: {
      score: 0,
      totalTransactions: 0,
      successfulTransactions: 0,
      disputesWon: 0,
      communityVotes: 0,
    },
    creditScore: {
      score: 0,
      rating: "Unscored",
      paymentHistory: 0,
      creditUtilization: 0,
      lengthOfHistory: 0,
      newCredit: 0,
      creditMix: 0,
    },
  };
}

async function main() {
  const email = String(
    process.env.DEFAULT_ADMIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || ""
  )
    .trim()
    .toLowerCase();
  const password = process.env.DEFAULT_ADMIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error(
      "Set DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD (or BOOTSTRAP_ADMIN_*) in the environment."
    );
    process.exit(1);
  }

  const name = String(process.env.DEFAULT_ADMIN_NAME || "Ghana Lands Commission Admin").trim();
  const roleRaw = String(process.env.DEFAULT_ADMIN_ROLE || "admin").trim().toLowerCase();
  const role = roleRaw === "lands_commission" ? "lands_commission" : "admin";
  const staffId = String(process.env.DEFAULT_ADMIN_STAFF_ID || "GLC-ADMIN-001").trim();
  const organization = String(process.env.DEFAULT_ADMIN_ORG || "Ghana Lands Commission").trim();
  const fixedId = process.env.DEFAULT_ADMIN_ID?.trim();

  const pool = createPgPool();
  try {
    await ensureSchema(pool);

    const strip = await pool.query(`
      UPDATE sl_users
      SET profile = profile - 'passwordHash' - 'password_hash' - 'password'
      WHERE profile ? 'passwordHash' OR profile ? 'password_hash' OR profile ? 'password'
    `);
    if (strip.rowCount > 0) {
      console.log(`Stripped password fields from profile JSON on ${strip.rowCount} row(s) (use password_hash column only).`);
    }

    const passwordHash = bcrypt.hashSync(String(password), 10);
    const { rows } = await pool.query(`SELECT id FROM sl_users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`, [email]);

    if (rows.length) {
      const userId = rows[0].id;
      const profile = buildProfile({ userId, email, name, role, staffId, organization });
      await pool.query(
        `UPDATE sl_users
         SET password_hash = $2,
             profile = COALESCE(profile, '{}'::jsonb) || $3::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [userId, passwordHash, JSON.stringify(profile)]
      );
      console.log(`Updated password_hash + profile for ${email} (id=${userId}).`);
    } else {
      const userId =
        fixedId || `user_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
      const profile = buildProfile({ userId, email, name, role, staffId, organization });
      await pool.query(
        `INSERT INTO sl_users (id, email, password_hash, profile, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())`,
        [userId, email, passwordHash, JSON.stringify(profile)]
      );
      console.log(`Inserted ${email} (id=${userId}, role=${role}).`);
    }

    console.log("Use POST /api/auth/login with this email and password (JSON body: { \"email\", \"password\" }).");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
