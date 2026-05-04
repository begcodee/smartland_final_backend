/**
 * SmartLand Immutability Layer
 *
 * Once a parcel is anchored on-chain:
 *   - Its content (title, location, price, documents, boundary) is FROZEN
 *   - Any attempt to modify these fields is rejected with 403
 *   - The blockchain record (Polygon Amoy) is the canonical truth
 *
 * A unique CONTENT HASH is computed for every parcel submission:
 *   SHA-256( sorted canonical JSON of title + location + documents + boundary )
 * This prevents the same parcel from being submitted twice under a different ID.
 */

import crypto from "crypto";
import { ethers } from "ethers";

// ─── Fields that are immutable once on-chain ──────────────────────────────
export const IMMUTABLE_FIELDS = [
  "title",
  "location",
  "priceGhs",
  "size",
  "areaSqm",
  "boundaryPolygon",
  "geoFingerprint",
  "documents",
  "documentBundle",
  "sellerId",
];

// ─── Content hash ─────────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 content hash from the parcel's canonical fields.
 * Two parcels with identical title + location + document bundle will produce the same hash.
 */
export function computeParcelContentHash(parcel) {
  const docs = Array.isArray(parcel.documents) ? parcel.documents : [];
  const docFingerprints = docs
    .map((d) => ({
      type: String(d?.type || ""),
      sha256: String(d?.sha256 || d?.fileId || d?.url || d?.name || ""),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));

  const canonical = {
    title: String(parcel.title || "").trim().toLowerCase(),
    location: String(parcel.location || "").trim().toLowerCase(),
    priceGhs: Number(parcel.priceGhs || 0),
    size: String(parcel.size || "").trim().toLowerCase(),
    geoFingerprint: parcel.geoFingerprint || null,
    documents: docFingerprints,
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

/**
 * Convert the content hash to a bytes32 for the smart contract (keccak256 of the hex string).
 */
export function contentHashToBytes32(contentHash) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(contentHash)));
}

// ─── Anchor state checks ──────────────────────────────────────────────────

/** Returns true if this parcel has been anchored on the blockchain. */
export function isChainAnchored(parcel) {
  return Boolean(
    parcel?.chainAnchor?.txHash ||
    parcel?.chainRegistry?.txHash ||
    parcel?.blockchainHash
  );
}

/**
 * Throws an error object (suitable for res.status(403).json) if the parcel is on-chain.
 * Use before any mutation that would violate immutability.
 */
export function assertNotAnchored(parcel) {
  if (!isChainAnchored(parcel)) return;
  throw {
    status: 403,
    code: "PARCEL_IMMUTABLE",
    message:
      "This parcel is anchored on the blockchain and its data is immutable. " +
      "No modifications are permitted after on-chain registration. " +
      `Chain tx: ${parcel?.chainAnchor?.txHash || parcel?.chainRegistry?.txHash || parcel?.blockchainHash}`,
    chainAnchor: parcel.chainAnchor || parcel.chainRegistry || null,
  };
}

/**
 * Check whether a content hash already exists in the parcel store (duplicate submission).
 * Returns the existing parcel if found, or null.
 */
export function findDuplicateByContentHash(contentHash, store, excludeParcelId = null) {
  if (!contentHash) return null;
  for (const p of store.parcels.values()) {
    if (excludeParcelId && p.id === excludeParcelId) continue;
    if (p.contentHash && String(p.contentHash) === String(contentHash)) return p;
  }
  return null;
}

// ─── Blockchain anchor ────────────────────────────────────────────────────

/**
 * Attempt to register a parcel on Polygon Amoy after LC approval.
 * Uses the v2 SmartLandRegistry contract (registerParcel).
 * Falls back gracefully if chain env is not configured.
 */
export async function anchorParcelOnChain({ parcel, ownerWalletAddress }) {
  let maybeRegister;
  try {
    const mod = await import("./chainRegistry.js");
    maybeRegister = mod.maybeRegisterParcelOnChain;
  } catch {
    return { skipped: true, reason: "chainRegistry_import_failed" };
  }

  const contentHash = parcel.contentHash || computeParcelContentHash(parcel);
  const metadataHash = contentHashToBytes32(contentHash);

  const result = await maybeRegister({
    parcel,
    ownerAddress: ownerWalletAddress,
    metadataHash,
  });

  return {
    ...result,
    contentHash,
    metadataHashBytes32: metadataHash,
    anchoredAt: new Date().toISOString(),
  };
}

/**
 * Attempt to execute a land transfer on Polygon Amoy via the v2 smart contract.
 * Builds the typed data, collects LC signature, and calls executeTransfer.
 * Falls back gracefully if chain env is not configured.
 */
export async function executeTransferOnChain({ parcel, transfer, fromAddress, toAddress }) {
  let chainMod;
  try {
    chainMod = await import("./chainRegistry.js");
  } catch {
    return { skipped: true, reason: "chainRegistry_import_failed" };
  }

  const {
    getRegistryContract,
    parcelIdToBytes32,
    transferIdToBytes32,
    metadataToBytes32,
    executeTransferOnChain: chainExecTransfer,
  } = chainMod;

  if (typeof chainExecTransfer === "function") {
    return chainExecTransfer({ parcel, transfer, fromAddress, toAddress });
  }

  // Fallback: attempt direct execution via contract
  const ctx = await getRegistryContract();
  if (!ctx) return { skipped: true, reason: "missing_chain_env" };

  let from, to;
  try {
    from = ethers.getAddress(String(fromAddress || ""));
    to = ethers.getAddress(String(toAddress || ""));
  } catch {
    return { skipped: true, reason: "invalid_wallet_addresses" };
  }

  const pid = parcelIdToBytes32(parcel.id);
  const tid = transferIdToBytes32(transfer.id);
  const mh = metadataToBytes32(JSON.stringify({ parcelId: parcel.id, transferId: transfer.id }));

  let nonce;
  try {
    nonce = await ctx.contract.parcelNonce(pid);
  } catch {
    return { skipped: true, reason: "parcel_not_on_chain_yet" };
  }

  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

  const transferStruct = {
    transferId: tid,
    parcelId: pid,
    from,
    to,
    nonce,
    deadline,
    metadataHash: mh,
  };

  try {
    const tx = await ctx.contract.executeTransfer(transferStruct, []); // no multisig in simple path
    const receipt = await tx.wait();
    return {
      skipped: false,
      txHash: receipt?.hash || tx.hash,
      parcelIdBytes32: pid,
      transferIdBytes32: tid,
      from,
      to,
      nonce: nonce.toString(),
      executedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      skipped: true,
      reason: "chain_tx_failed",
      error: String(e?.message || e),
    };
  }
}
