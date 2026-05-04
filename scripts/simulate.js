import { store, seedIfEmpty } from "../src/store.js";
import { LandConflictEngine } from "../src/services/landConflictEngine.js";

function resetStore() {
  // crude reset for simulation (keep maps)
  store.users = new Map();
  store.parcels = new Map();
  store.conversations = new Map();
  store.messages = new Map();
  store.payments = new Map();
  store.transfers = new Map();
  store.ratings = [];
  store.niaEmployees = new Map();
  store.employeeAttempts = [];
  store.auditLogs = [];
  store.notifications = [];
  store.documentHashes = new Map();
  store.imageHashes = new Map();
  store.files = new Map();
  store.fileTokens = new Map();
  store.laws = [];
}

function pickUser(role) {
  return Array.from(store.users.values()).find((u) => u.role === role) || null;
}

async function scenarioDoubleSaleAttempt() {
  const engine = new LandConflictEngine(store);
  const parcel = Array.from(store.parcels.values())[0] || null;
  const seller = parcel ? store.users.get(parcel.sellerId) : null;
  const buyerA = pickUser("buyer");
  const buyerB = Array.from(store.users.values()).find((u) => u.role === "buyer" && u.id !== buyerA?.id) || buyerA;
  if (!seller || !buyerA || !buyerB || !parcel) throw new Error("Missing demo actors");

  // Buyer A initiates a lock to simulate checkout in progress
  parcel.status = "locked_for_transaction";
  parcel.lockedUntil = Date.now() + 10 * 60_000;

  const evalB = await engine.evaluateTransaction({
    parcel_id: parcel.id,
    seller_id: parcel.sellerId,
    buyer_id: buyerB.id,
    transaction_type: "sale",
  });
  return { decision: evalB.decision, flags: evalB.flags };
}

async function scenarioUnauthorizedTransferAttempt() {
  const engine = new LandConflictEngine(store);
  const parcel = Array.from(store.parcels.values())[0] || null;
  const seller = parcel ? store.users.get(parcel.sellerId) : null;
  const attacker = pickUser("buyer"); // pretending to be seller in tx payload
  if (!seller || !attacker || !parcel) throw new Error("Missing demo actors");

  const evalTx = await engine.evaluateTransaction({
    parcel_id: parcel.id,
    seller_id: attacker.id, // mismatch
    buyer_id: attacker.id,
    transaction_type: "sale",
  });
  return { decision: evalTx.decision, flags: evalTx.flags };
}

async function main() {
  resetStore();
  seedIfEmpty();

  const results = [];
  results.push({ name: "double_sale_attempt", ...(await scenarioDoubleSaleAttempt()) });
  results.push({ name: "unauthorized_transfer_attempt", ...(await scenarioUnauthorizedTransferAttempt()) });

  const summary = {
    at: new Date().toISOString(),
    scenarios: results,
    successRate: results.filter((r) => r.decision === "AUTO").length / Math.max(1, results.length),
    blockedOrFlagged: results.filter((r) => r.decision !== "AUTO").length,
    auditLogEntries: store.auditLogs?.length || 0,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

