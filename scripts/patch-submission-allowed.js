/**
 * One-time fix: set submissionAllowed=true on all seller/buyer accounts
 * that have submissionAllowed=false or missing (new sellers blocked by default).
 * Run: node scripts/patch-submission-allowed.js
 */
import "dotenv/config";
import { createPgPool } from "../src/config/db.js";

const pool = createPgPool();
try {
  // Fix sellers whose submissionAllowed is false or missing
  const res = await pool.query(`
    UPDATE sl_users
    SET profile = profile
      || jsonb_build_object(
           'submissionAllowed', true,
           'niaStatus', COALESCE(profile->>'niaStatus', 'verified'),
           'verified', COALESCE(profile->>'verified', 'false')
         ),
        updated_at = NOW()
    WHERE profile->>'role' IN ('seller', 'buyer')
      AND (profile->>'submissionAllowed' IS NULL OR profile->>'submissionAllowed' = 'false')
    RETURNING id, email, profile->>'role' as role, profile->>'name' as name
  `);
  console.log(`Patched ${res.rowCount} seller/buyer account(s):`);
  res.rows.forEach(r => console.log(" -", r.email, `(${r.role})`, r.name));

  // Also ensure niaStatus is set for LC/admin users so their features work
  const res2 = await pool.query(`
    UPDATE sl_users
    SET profile = profile
      || jsonb_build_object('niaStatus', 'verified', 'verified', 'true'),
        updated_at = NOW()
    WHERE profile->>'role' IN ('lands_commission', 'admin', 'arbitrator')
      AND (profile->>'niaStatus' IS NULL OR profile->>'verified' != 'true')
    RETURNING id, email, profile->>'role' as role
  `);
  console.log(`Patched ${res2.rowCount} staff account(s) (niaStatus/verified).`);
  res2.rows.forEach(r => console.log(" -", r.email, `(${r.role})`));

  console.log("\nDone. Render will reload these on next cold-start or periodic flush.");
} finally {
  await pool.end();
}
