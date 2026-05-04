import "dotenv/config";
import { createPgPool } from "../src/config/db.js";

async function main() {
  const pool = createPgPool();
  const out = { usersReset: 0, slUsersReset: 0, slUsersSkipped: false, slUsersSkipReason: null };

  const r1 = await pool.query(
    `UPDATE users
     SET nia_status = 'pending',
         nia_reference_id = NULL,
         nia_verified_at = NULL,
         verified = FALSE
     WHERE nia_status IS DISTINCT FROM 'pending'
        OR nia_reference_id IS NOT NULL
        OR nia_verified_at IS NOT NULL
        OR verified IS TRUE`
  );
  out.usersReset = r1.rowCount || 0;

  try {
    const r2 = await pool.query(
      `UPDATE sl_users
       SET profile = (profile
         - 'niaStatus'
         - 'niaReferenceId'
         - 'niaVerifiedAt'
         - 'verified'
         - 'idVerification'
         - 'submissionAllowed'
         - 'riskScore'
         - 'riskReasons'
         - 'idVerificationRiskFlag'
         - 'documentSizeFlags'
         - 'biometricArbitratorNotified')
       WHERE (profile ? 'niaStatus')
          OR (profile ? 'niaReferenceId')
          OR (profile ? 'niaVerifiedAt')
          OR (profile ? 'verified')
          OR (profile ? 'idVerification')
          OR (profile ? 'submissionAllowed')
          OR (profile ? 'riskScore')
          OR (profile ? 'riskReasons')
          OR (profile ? 'idVerificationRiskFlag')
          OR (profile ? 'documentSizeFlags')
          OR (profile ? 'biometricArbitratorNotified')`
    );
    out.slUsersReset = r2.rowCount || 0;
  } catch (e) {
    out.slUsersSkipped = true;
    out.slUsersSkipReason = String(e?.message || e);
  }

  await pool.end();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

