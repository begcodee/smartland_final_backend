import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const SNAPSHOT_VERSION = 1;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function serializeStore(store) {
  return {
    version: SNAPSHOT_VERSION,
    users: Array.from(store.users.entries()),
    parcels: Array.from(store.parcels.entries()),
    conversations: Array.from(store.conversations.entries()),
    messages: Array.from(store.messages.entries()),
    payments: Array.from(store.payments.entries()),
    transfers: Array.from(store.transfers.entries()),
    ratings: store.ratings,
    niaEmployees: Array.from(store.niaEmployees.entries()),
    employeeAttempts: store.employeeAttempts,
    auditLogs: store.auditLogs,
    notifications: store.notifications,
    documentHashes: Array.from(store.documentHashes.entries()),
    imageHashes: Array.from(store.imageHashes.entries()),
    laws: store.laws,
  };
}

export function hydrateStore(store, data) {
  if (!data || data.version !== SNAPSHOT_VERSION) return false;

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

  for (const [k, v] of data.users || []) store.users.set(k, v);
  for (const [k, v] of data.parcels || []) store.parcels.set(k, v);
  for (const [k, v] of data.conversations || []) store.conversations.set(k, v);
  for (const [k, v] of data.messages || []) store.messages.set(k, Array.isArray(v) ? v : []);
  for (const [k, v] of data.payments || []) store.payments.set(k, v);
  for (const [k, v] of data.transfers || []) store.transfers.set(k, v);
  for (const [k, v] of data.niaEmployees || []) store.niaEmployees.set(k, v);
  for (const [k, v] of data.documentHashes || []) store.documentHashes.set(k, v);
  for (const [k, v] of data.imageHashes || []) store.imageHashes.set(k, v);

  if (Array.isArray(data.ratings)) store.ratings.push(...data.ratings);
  if (Array.isArray(data.employeeAttempts)) store.employeeAttempts.push(...data.employeeAttempts);
  if (Array.isArray(data.auditLogs)) store.auditLogs.push(...data.auditLogs);
  if (Array.isArray(data.notifications)) store.notifications.push(...data.notifications);
  if (Array.isArray(data.laws)) store.laws.push(...data.laws);

  return true;
}

export async function ensureSnapshotTable(pool) {
  const schemaPath = join(__dirname, "..", "config", "schema_snapshot.sql");
  const sql = readFileSync(schemaPath, "utf8");
  await pool.query(sql);
}

export async function loadStoreSnapshot(pool) {
  const { rows } = await pool.query(
    "SELECT payload FROM app_snapshots WHERE singleton = 1 LIMIT 1"
  );
  if (!rows.length || !rows[0].payload) return null;
  return rows[0].payload;
}

export async function saveStoreSnapshot(pool, store) {
  if (!pool) return;
  try {
    const payload = serializeStore(store);
    await pool.query(
      `INSERT INTO app_snapshots (singleton, payload, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (singleton) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [payload]
    );
  } catch (e) {
    console.error("[db] Snapshot save failed:", e.message);
  }
}

export function startSnapshotScheduler(pool, store, intervalMs = 8000) {
  return setInterval(() => {
    void saveStoreSnapshot(pool, store);
  }, intervalMs);
}
