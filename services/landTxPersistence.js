/**
 * Store chain tx hash without requiring a specific table layout.
 * 1) land_transactions (if your Neon schema has it)
 * 2) lands.blockchain_hash (exists in src/config/schema.sql)
 */

export async function persistLandChainTx(pool, { landId, action, txHash }) {
  const id = Number(landId);
  if (!Number.isFinite(id)) return { stored: false, reason: "bad_land_id" };

  try {
    await pool.query(
      `INSERT INTO land_transactions (land_id, action, tx_hash, created_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [id, action, txHash]
    );
    return { stored: true, via: "land_transactions" };
  } catch {
    // table missing or column mismatch
  }

  try {
    await pool.query(
      `UPDATE lands SET blockchain_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [txHash, id]
    );
    return { stored: true, via: "lands.blockchain_hash" };
  } catch (e) {
    console.warn("[chain] persistLandChainTx fallback failed:", e.message);
    return { stored: false, reason: String(e.message || e) };
  }
}
