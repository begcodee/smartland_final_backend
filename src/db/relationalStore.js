import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { getPool } from "../config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Allowed tables/columns for orphan cleanup (SQL identifiers only). */
const ORPHAN_TARGETS = [
  ["sl_notifications", "id"],
  ["sl_transfers", "id"],
  ["sl_payments", "reference"],
  ["sl_conversations", "id"],
  ["sl_parcels", "id"],
  ["sl_nia_employees", "staff_id"],
  ["sl_document_hashes", "hash"],
  ["sl_image_hashes", "hash"],
  ["sl_users", "id"],
];

export async function ensureSmartlandSchema(pool) {
  const sqlPath = join(__dirname, "..", "config", "schema_sl.sql");
  const sql = readFileSync(sqlPath, "utf8");
  await pool.query(sql);
}

function userToProfile(user) {
  const { id, email, passwordHash, ...rest } = user;
  return rest;
}

function rowToUser(row) {
  const raw = row.profile;
  const p =
    raw && typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...raw } : {};
  const columnHash =
    row.password_hash != null && String(row.password_hash).trim() !== "" ? String(row.password_hash) : null;
  const legacyProfileHash =
    typeof p.passwordHash === "string" && String(p.passwordHash).trim() !== ""
      ? String(p.passwordHash).trim()
      : typeof p.password_hash === "string" && String(p.password_hash).trim() !== ""
        ? String(p.password_hash).trim()
        : null;
  const passwordHash = columnHash || legacyProfileHash || null;
  delete p.passwordHash;
  delete p.password_hash;
  delete p.password;
  delete p.id;
  if (p.email != null) delete p.email;
  return {
    ...p,
    id: row.id,
    email: String(row.email || "").trim().toLowerCase(),
    passwordHash,
  };
}

export async function loadStoreFromPostgres(pool, store) {
  store.users.clear();
  store.parcels.clear();
  store.conversations.clear();
  store.messages.clear();
  store.payments.clear();
  store.transfers.clear();
  store.niaEmployees.clear();
  store.documentHashes.clear();
  store.imageHashes.clear();
  store.ratings.length = 0;
  store.employeeAttempts.length = 0;
  store.auditLogs.length = 0;
  store.notifications.length = 0;
  store.laws.length = 0;

  const { rows: users } = await pool.query(
    `SELECT id, email, password_hash, profile FROM sl_users`
  );
  for (const r of users) store.users.set(r.id, rowToUser(r));

  const { rows: parcels } = await pool.query(`SELECT id, seller_id, body FROM sl_parcels`);
  for (const r of parcels) {
    const p = typeof r.body === "object" && r.body !== null ? r.body : {};
    const parcel = { ...p, id: r.id, sellerId: r.seller_id || p.sellerId };
    store.parcels.set(r.id, parcel);
  }

  const { rows: convos } = await pool.query(
    `SELECT id, parcel_id, buyer_id, seller_id, created_at, messages FROM sl_conversations`
  );
  for (const r of convos) {
    store.conversations.set(r.id, {
      id: r.id,
      parcelId: r.parcel_id,
      buyerId: r.buyer_id,
      sellerId: r.seller_id,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    });
    const msgs = Array.isArray(r.messages) ? r.messages : [];
    store.messages.set(r.id, msgs);
  }

  const { rows: pays } = await pool.query(`SELECT reference, body FROM sl_payments`);
  for (const r of pays) {
    const b = typeof r.body === "object" && r.body !== null ? r.body : {};
    store.payments.set(r.reference, { ...b, reference: r.reference });
  }

  const { rows: txs } = await pool.query(`SELECT id, body FROM sl_transfers`);
  for (const r of txs) {
    const b = typeof r.body === "object" && r.body !== null ? r.body : {};
    store.transfers.set(r.id, { ...b, id: r.id });
  }

  const { rows: ratings } = await pool.query(`SELECT id, body FROM sl_ratings ORDER BY id`);
  for (const r of ratings) {
    const b = typeof r.body === "object" && r.body !== null ? r.body : {};
    store.ratings.push({ ...b, id: r.id });
  }

  const { rows: staff } = await pool.query(`SELECT staff_id, body FROM sl_nia_employees`);
  for (const r of staff) {
    const b = typeof r.body === "object" && r.body !== null ? r.body : {};
    store.niaEmployees.set(r.staff_id, { ...b, staffId: r.staff_id });
  }

  const { rows: laws } = await pool.query(`SELECT id, body FROM sl_laws ORDER BY id`);
  for (const r of laws) {
    const b = typeof r.body === "object" && r.body !== null ? r.body : {};
    store.laws.push({ ...b, id: r.id });
  }

  const { rows: notifs } = await pool.query(
    `SELECT id, user_id, body FROM sl_notifications ORDER BY updated_at DESC NULLS LAST`
  );
  for (const r of notifs) {
    const b = typeof r.body === "object" && r.body !== null ? r.body : {};
    store.notifications.push({ ...b, id: r.id, userId: r.user_id });
  }

  const { rows: docHashes } = await pool.query(`SELECT hash, body FROM sl_document_hashes`);
  for (const r of docHashes) {
    const b = typeof r.body === "object" && r.body !== null ? r.body : {};
    store.documentHashes.set(r.hash, b);
  }

  const { rows: imgHashes } = await pool.query(`SELECT hash, body FROM sl_image_hashes`);
  for (const r of imgHashes) {
    const b = typeof r.body === "object" && r.body !== null ? r.body : {};
    store.imageHashes.set(r.hash, b);
  }

  const { rows: audits } = await pool.query(`SELECT id, body FROM sl_audit_logs ORDER BY seq ASC`);
  for (const r of audits) {
    const b = typeof r.body === "object" && r.body !== null ? r.body : {};
    store.auditLogs.push({ ...b, id: r.id });
  }

  const { rows: meta } = await pool.query(`SELECT key, value FROM sl_meta WHERE key = 'employee_attempts'`);
  if (meta.length && Array.isArray(meta[0].value)) {
    store.employeeAttempts.push(...meta[0].value);
  }
}

async function deleteOrphansSafe(client, table, idColumn, keepIds) {
  const ok = ORPHAN_TARGETS.some(([t, c]) => t === table && c === idColumn);
  if (!ok) throw new Error(`Invalid orphan delete target: ${table}.${idColumn}`);
  if (!keepIds.length) {
    await client.query(`DELETE FROM ${table}`);
    return;
  }
  await client.query(`DELETE FROM ${table} WHERE ${idColumn} <> ALL($1::text[])`, [keepIds]);
}

export async function flushStoreToPostgres(pool, store) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const [id, u] of store.users) {
      const profile = userToProfile(u);
      await client.query(
        `INSERT INTO sl_users (id, email, password_hash, profile, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           profile = EXCLUDED.profile,
           updated_at = NOW()`,
        [id, u.email, u.passwordHash, JSON.stringify(profile)]
      );
    }

    for (const [, p] of store.parcels) {
      await client.query(
        `INSERT INTO sl_parcels (id, seller_id, body, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET seller_id = EXCLUDED.seller_id, body = EXCLUDED.body, updated_at = NOW()`,
        [p.id, p.sellerId, JSON.stringify(p)]
      );
    }

    for (const [, c] of store.conversations) {
      const msgs = store.messages.get(c.id) || [];
      await client.query(
        `INSERT INTO sl_conversations (id, parcel_id, buyer_id, seller_id, created_at, messages, updated_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET
           parcel_id = EXCLUDED.parcel_id,
           buyer_id = EXCLUDED.buyer_id,
           seller_id = EXCLUDED.seller_id,
           messages = EXCLUDED.messages,
           updated_at = NOW()`,
        [c.id, c.parcelId, c.buyerId, c.sellerId, c.createdAt || null, JSON.stringify(msgs)]
      );
    }

    for (const [ref, pay] of store.payments) {
      await client.query(
        `INSERT INTO sl_payments (reference, body, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (reference) DO UPDATE SET body = EXCLUDED.body, updated_at = NOW()`,
        [ref, JSON.stringify(pay)]
      );
    }

    for (const [tid, t] of store.transfers) {
      await client.query(
        `INSERT INTO sl_transfers (id, body, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated_at = NOW()`,
        [tid, JSON.stringify(t)]
      );
    }

    await client.query(`DELETE FROM sl_ratings`);
    for (const r of store.ratings) {
      const rid = r.id || `rating_${Math.random().toString(16).slice(2)}`;
      const { id: _omit, ...rest } = r;
      await client.query(`INSERT INTO sl_ratings (id, body) VALUES ($1, $2::jsonb)`, [
        rid,
        JSON.stringify({ ...rest, id: rid }),
      ]);
    }

    for (const [sid, s] of store.niaEmployees) {
      await client.query(
        `INSERT INTO sl_nia_employees (staff_id, body)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (staff_id) DO UPDATE SET body = EXCLUDED.body`,
        [sid, JSON.stringify(s)]
      );
    }

    await client.query(`DELETE FROM sl_laws`);
    for (const law of store.laws) {
      await client.query(`INSERT INTO sl_laws (id, body) VALUES ($1, $2::jsonb)`, [
        law.id,
        JSON.stringify(law),
      ]);
    }

    for (const n of store.notifications) {
      await client.query(
        `INSERT INTO sl_notifications (id, user_id, body, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, body = EXCLUDED.body, updated_at = NOW()`,
        [n.id, n.userId, JSON.stringify(n)]
      );
    }

    for (const [h, body] of store.documentHashes) {
      await client.query(
        `INSERT INTO sl_document_hashes (hash, body)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (hash) DO UPDATE SET body = EXCLUDED.body`,
        [h, JSON.stringify(body)]
      );
    }

    for (const [h, body] of store.imageHashes) {
      await client.query(
        `INSERT INTO sl_image_hashes (hash, body)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (hash) DO UPDATE SET body = EXCLUDED.body`,
        [h, JSON.stringify(body)]
      );
    }

    await client.query(`DELETE FROM sl_audit_logs`);
    for (const a of store.auditLogs) {
      await client.query(`INSERT INTO sl_audit_logs (id, body) VALUES ($1, $2::jsonb)`, [
        a.id,
        JSON.stringify(a),
      ]);
    }

    await client.query(
      `INSERT INTO sl_meta (key, value)
       VALUES ('employee_attempts', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(store.employeeAttempts)]
    );

    for (const [table, col] of ORPHAN_TARGETS) {
      let keepIds = [];
      if (table === "sl_notifications") keepIds = store.notifications.map((x) => x.id);
      else if (table === "sl_transfers") keepIds = [...store.transfers.keys()];
      else if (table === "sl_payments") keepIds = [...store.payments.keys()];
      else if (table === "sl_conversations") keepIds = [...store.conversations.keys()];
      else if (table === "sl_parcels") keepIds = [...store.parcels.keys()];
      else if (table === "sl_nia_employees") keepIds = [...store.niaEmployees.keys()];
      else if (table === "sl_document_hashes") keepIds = [...store.documentHashes.keys()];
      else if (table === "sl_image_hashes") keepIds = [...store.imageHashes.keys()];
      else if (table === "sl_users") keepIds = [...store.users.keys()];
      await deleteOrphansSafe(client, table, col, keepIds);
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[db] flushStoreToPostgres failed:", e.message);
    throw e;
  } finally {
    client.release();
  }
}

export function startFlushScheduler(pool, store, intervalMs = 8000) {
  return setInterval(() => {
    void flushStoreToPostgres(pool, store).catch((err) =>
      console.error("[db] scheduled flush failed:", err.message)
    );
  }, intervalMs);
}

/** Immediate flush after mutations (errors are logged, not thrown). */
export async function persistStoreNow(store) {
  const pool = getPool();
  if (!pool) return;
  try {
    await flushStoreToPostgres(pool, store);
  } catch (e) {
    console.error("[db] persistStoreNow:", e.message);
  }
}
