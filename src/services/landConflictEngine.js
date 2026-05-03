import { polygonOverlapRatio } from "./geo.js";
import {
  sellerProtocolsAllowTransaction,
  parcelDocumentProtocolOk,
} from "./sellerProtocolGate.js";

function riskLevelFromScore(score) {
  if (score >= 70) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}

/** Severe risk → hard stop (no automated settlement). */
function decisionFromScore(score) {
  if (score >= 70) return "BLOCK";
  if (score >= 40) return "RED_FLAG";
  return "AUTO";
}

function weights() {
  return {
    ACTIVE_TRANSACTION_EXISTS: Number(process.env.RISK_W_ACTIVE_TX || 40),
    GEOMETRIC_OVERLAP_DETECTED: Number(process.env.RISK_W_GEO_OVERLAP || 30),
    SELLER_NOT_REGISTERED_OWNER: Number(process.env.RISK_W_OWNER_MISMATCH || 50),
    IDENTITY_NOT_VERIFIED: Number(process.env.RISK_W_IDENTITY || 50),
    TITLE_CHAIN_GAP: Number(process.env.RISK_W_TITLE_CHAIN || 35),
    DECLARED_DOC_MISMATCH: Number(process.env.RISK_W_AREA_DECLARED_DOC || 30),
    DOC_GEO_MISMATCH: Number(process.env.RISK_W_AREA_DOC_GEO || 40),
    DECLARED_GEO_MISMATCH: Number(process.env.RISK_W_AREA_DECLARED_GEO || 25),
  };
}

function calculateVariance(a, b) {
  const A = Number(a);
  const B = Number(b);
  if (!Number.isFinite(A) || !Number.isFinite(B) || A <= 0 || B <= 0) return null;
  return Math.abs(A - B) / ((A + B) / 2);
}

function areaThresholds() {
  return {
    ok: Number(process.env.AREA_VAR_OK || 0.05),
    review: Number(process.env.AREA_VAR_REVIEW || 0.15),
  };
}

/**
 * Land conflict detection engine — **Red Flag model**:
 * - `AUTO`: fiat + registrar anchoring may proceed (smart-contract path).
 * - `RED_FLAG`: automation stops; arbitrator / manual review (criteria failed or elevated risk).
 * - `BLOCK`: severe conflict; do not proceed.
 */
export class LandConflictEngine {
  constructor(store) {
    this.store = store;
  }

  getParcel(parcelId) {
    return this.store.parcels.get(parcelId) || null;
  }

  getActiveTransaction(parcelId) {
    const parcel = this.getParcel(parcelId);
    if (!parcel) return null;
    const now = Date.now();
    if (parcel.status === "locked_for_transaction" && parcel.lockedUntil && now < parcel.lockedUntil) {
      return { type: "lock", lockedUntil: parcel.lockedUntil };
    }

    const pendingPayment = Array.from(this.store.payments.values()).find(
      (p) => p.parcelId === parcelId && p.status === "pending"
    );
    if (pendingPayment) return { type: "payment_pending", reference: pendingPayment.reference };

    return null;
  }

  getAllParcels() {
    return Array.from(this.store.parcels.values());
  }

  currentOwnerId(parcel) {
    const last = Array.isArray(parcel.transfers) && parcel.transfers.length
      ? parcel.transfers[parcel.transfers.length - 1]
      : null;
    return last?.buyerId || parcel.sellerId;
  }

  hasTitleChainGap(parcel) {
    // Demo rule: if parcel is sold but has no transfer record, chain is inconsistent.
    if (parcel.status === "sold" && (!Array.isArray(parcel.transfers) || parcel.transfers.length === 0)) return true;
    return false;
  }

  /** Criterion 1 — Seller identity via NIA (SSI): must be NIA-verified. */
  sellerNiaVerified(userId) {
    const u = this.store.users.get(userId);
    if (!u) return false;
    return u.niaStatus === "verified";
  }

  async verifyIdentity(userId) {
    return this.sellerNiaVerified(userId);
  }

  async evaluateTransaction(tx) {
    const W = weights();
    const T = areaThresholds();
    const flags = [];
    let riskScore = 0;

    const parcel = this.getParcel(tx.parcel_id);
    if (!parcel) {
      flags.push("PARCEL_NOT_FOUND");
      riskScore = 100;
      return {
        risk_score: riskScore,
        risk_level: "HIGH",
        flags,
        decision: "BLOCK",
      };
    }

    // Criterion 2 — Parcel must be in **clear** registry status for automated settlement.
    if (parcel.registryClearance === "flagged") {
      flags.push("REGISTRY_NOT_CLEAR");
    }

    // MODULE B — DOUBLE SALE DETECTOR
    const activeTx = this.getActiveTransaction(tx.parcel_id);
    if (activeTx) {
      flags.push("ACTIVE_TRANSACTION_EXISTS");
      riskScore += W.ACTIVE_TRANSACTION_EXISTS;
    }

    // MODULE D — GEO OVERLAP DETECTOR (polygon intersection ratio)
    const geo = tx.geo_polygon || parcel.boundaryPolygon;
    if (geo) {
      const existingParcels = this.getAllParcels();
      for (const p of existingParcels) {
        if (p.id === tx.parcel_id) continue;
        if (!p.boundaryPolygon) continue;
        const overlap = polygonOverlapRatio(geo, p.boundaryPolygon);
        if (typeof overlap === "number" && overlap > 0.05) {
          flags.push("GEOMETRIC_OVERLAP_DETECTED");
          riskScore += W.GEOMETRIC_OVERLAP_DETECTED;
          break;
        }
      }
    }

    // MODULE C — OWNERSHIP CHAIN VALIDATOR
    if (this.hasTitleChainGap(parcel)) {
      flags.push("TITLE_CHAIN_GAP");
      riskScore += W.TITLE_CHAIN_GAP;
    }

    // MODULE E — Criterion 3 (ownership) + Criterion 1 (NIA / SSI)
    const currentOwner = this.currentOwnerId(parcel);
    if (currentOwner !== tx.seller_id) {
      flags.push("SELLER_NOT_REGISTERED_OWNER");
      riskScore += W.SELLER_NOT_REGISTERED_OWNER;
    }

    const identityValid = await this.verifyIdentity(tx.seller_id);
    if (!identityValid) {
      flags.push("NIA_IDENTITY_NOT_VERIFIED");
      riskScore += W.IDENTITY_NOT_VERIFIED;
    }

    // MODULE G — Mock NIA / Lands verification protocols (dashboard rule enforcement)
    const sellerUser = this.store.users.get(tx.seller_id);
    if (sellerUser) {
      const sg = sellerProtocolsAllowTransaction(sellerUser);
      if (!sg.ok) {
        if (sg.reasons.includes("PROTOCOL_A_FAILED")) {
          flags.push("PROTOCOL_A_FAILED");
          riskScore += 50;
        }
        if (sg.reasons.includes("PROTOCOL_B_BIOMETRIC_FAILED")) {
          flags.push("BIOMETRIC_BINDING_FAILED");
          riskScore += 55;
        }
        if (sg.reasons.includes("PROTOCOL_B_PENDING_MANUAL_NIA")) {
          flags.push("PROTOCOL_B_PENDING_MANUAL_NIA");
          riskScore += 42;
        }
        if (sg.reasons.includes("PROTOCOL_SNAPSHOT_REQUIRED")) {
          flags.push("PROTOCOL_SNAPSHOT_REQUIRED");
          riskScore += 38;
        }
        if (sg.reasons.includes("NIA_NOT_VERIFIED") && !flags.includes("NIA_IDENTITY_NOT_VERIFIED")) {
          flags.push("NIA_NOT_VERIFIED");
          riskScore += W.IDENTITY_NOT_VERIFIED;
        }
      }
    }

    if (!parcelDocumentProtocolOk(parcel)) {
      flags.push("LAND_DOCUMENT_UNVERIFIED");
      riskScore += 50;
    }

    // MODULE F — AREA CONSISTENCY CHECK (tolerance + scoring; do not strict-reject)
    // Normalize all to sqm before comparing:
    // - declared: parcel.areaSqm
    // - document: parcel.documentAreaSqm (optional)
    // - geo: parcel.geoAreaSqm (optional, from boundary polygon)
    const declaredSqm = parcel.areaSqm ?? null;
    const documentSqm = parcel.documentAreaSqm ?? null;
    const geoSqm = parcel.geoAreaSqm ?? null;

    const addVarianceFlag = (flag, variance, weight) => {
      if (variance === null) return;
      if (variance > T.review) {
        flags.push(flag);
        riskScore += weight;
      } else if (variance > T.ok) {
        flags.push(flag);
        riskScore += Math.max(10, Math.round(weight / 2));
      }
    };

    addVarianceFlag("DECLARED_DOC_MISMATCH", calculateVariance(declaredSqm, documentSqm), W.DECLARED_DOC_MISMATCH);
    addVarianceFlag("DOC_GEO_MISMATCH", calculateVariance(documentSqm, geoSqm), W.DOC_GEO_MISMATCH);
    addVarianceFlag("DECLARED_GEO_MISMATCH", calculateVariance(declaredSqm, geoSqm), W.DECLARED_GEO_MISMATCH);

    const risk_level = riskLevelFromScore(riskScore);
    let decision = decisionFromScore(riskScore);

    // Red-flag pillars: stop automated registrar / chain settlement (arbitrator queue).
    const pillarRedFlag =
      flags.includes("SELLER_NOT_REGISTERED_OWNER") ||
      flags.includes("REGISTRY_NOT_CLEAR") ||
      flags.includes("NIA_IDENTITY_NOT_VERIFIED") ||
      flags.includes("PROTOCOL_A_FAILED") ||
      flags.includes("BIOMETRIC_BINDING_FAILED") ||
      flags.includes("LAND_DOCUMENT_UNVERIFIED") ||
      flags.includes("PROTOCOL_B_PENDING_MANUAL_NIA") ||
      flags.includes("PROTOCOL_SNAPSHOT_REQUIRED");

    if (riskScore >= 70) {
      decision = "BLOCK";
    } else if (pillarRedFlag || decision === "RED_FLAG") {
      decision = "RED_FLAG";
    } else {
      decision = "AUTO";
    }

    return {
      risk_score: riskScore,
      risk_level,
      flags,
      decision,
      recorded_owner_id: this.currentOwnerId(parcel),
      listed_seller_id: tx.seller_id,
    };
  }
}

