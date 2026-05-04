/**
 * Smoke test for /api/lands/register and /api/lands/transfer
 * Usage:
 *   API_URL=http://localhost:5000 LAND_ID=1 DOCUMENT_HASH=ipfs://QmExample node scripts/test-lands-chain.mjs register
 *   API_URL=http://localhost:5000 LAND_ID=1 NEW_OWNER=0x... node scripts/test-lands-chain.mjs transfer
 */
const API_URL = process.env.API_URL || "http://localhost:5000";
const cmd = process.argv[2] || "register";

async function main() {
  if (cmd === "register") {
    const landId = process.env.LAND_ID || "1";
    const documentHash = process.env.DOCUMENT_HASH || "demo-document-hash";
    const res = await fetch(`${API_URL}/api/lands/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ landId, documentHash }),
    });
    const body = await res.text();
    console.log(res.status, body);
    process.exit(res.ok ? 0 : 1);
  }
  if (cmd === "transfer") {
    const landId = process.env.LAND_ID || "1";
    const newOwner = process.env.NEW_OWNER;
    if (!newOwner) {
      console.error("Set NEW_OWNER=0x...");
      process.exit(1);
    }
    const res = await fetch(`${API_URL}/api/lands/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ landId, newOwnerAddress: newOwner }),
    });
    const body = await res.text();
    console.log(res.status, body);
    process.exit(res.ok ? 0 : 1);
  }
  console.error("Usage: register | transfer");
  process.exit(1);
}

main();
