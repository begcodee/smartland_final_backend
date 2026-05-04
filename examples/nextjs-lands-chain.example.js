/**
 * Example: call SmartLand chain endpoints from Next.js (client or Server Action).
 * Set NEXT_PUBLIC_API_URL e.g. http://localhost:5000
 */

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

export async function registerLandOnChain({ landId, documentHash }) {
  const res = await fetch(`${API}/api/lands/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      landId,
      documentHash,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export async function transferLandOnChain({ landId, newOwnerAddress }) {
  const res = await fetch(`${API}/api/lands/transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      landId,
      newOwnerAddress,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
