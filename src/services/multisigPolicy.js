/**
 * Multi-party approval policy for registry actions.
 *
 * This backend is authoritative for workflow enforcement, while the chain provides immutable anchoring.
 * Policy is environment-configurable so deployments can require e.g. Lands Commission + neutral arbitrator.
 */

function normalizeRole(r) {
  return String(r || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

export function approvalPolicy() {
  const raw = String(process.env.TRANSFER_APPROVAL_ROLES || "lands_commission,arbitrator");
  const roles = raw
    .split(",")
    .map((s) => normalizeRole(s))
    .filter(Boolean);

  const unique = Array.from(new Set(roles));
  const threshold = Math.max(
    1,
    Math.min(unique.length || 1, Number(process.env.TRANSFER_APPROVAL_THRESHOLD || unique.length || 1))
  );

  return { roles: unique.length ? unique : ["lands_commission", "arbitrator"], threshold };
}

export function requiredApprovalsForTransfer(_transfer, _parcel) {
  // Future: branch by risk/redFlag severity, amount, geo overlap, seller protocols, etc.
  return approvalPolicy();
}

