import express from "express";
import { authenticate } from "../auth.js";
import { seedIfEmpty, store } from "../store.js";
import { initializeTransaction, verifyTransaction } from "../services/paystack.js";
import { z } from "zod";
import { LandConflictEngine } from "../services/landConflictEngine.js";
import { audit } from "../services/audit.js";
import { createNotification } from "./notifications.js";
import { runFraudChecks, applyFraudFindingsToParcel, sendFraudAlerts } from "../services/fraudDetection.js";

const router = express.Router();

function redFlagFromEvaluation(evaluation) {
  const flags = Array.isArray(evaluation?.flags) ? evaluation.flags : [];
  // Prefer specific / high-signal causes first
  const priority = [
    "SELLER_NOT_REGISTERED_OWNER",
    "REGISTRY_NOT_CLEAR",
    "BIOMETRIC_BINDING_FAILED",
    "PROTOCOL_A_FAILED",
    "LAND_DOCUMENT_UNVERIFIED",
    "PROTOCOL_B_PENDING_MANUAL_NIA",
    "PROTOCOL_SNAPSHOT_REQUIRED",
    "NIA_IDENTITY_NOT_VERIFIED",
    "TITLE_CHAIN_GAP",
    "GEOMETRIC_OVERLAP_DETECTED",
    "ACTIVE_TRANSACTION_EXISTS",
  ];
  const primary = priority.find((f) => flags.includes(f)) || flags[0] || "RED_FLAG";
  const messages = {
    REGISTRY_NOT_CLEAR: "Registry clearance is not clear. Automated settlement is paused pending review.",
    BIOMETRIC_BINDING_FAILED: "Biometric binding failed (Protocol B). Automated settlement is paused pending arbitrator review.",
    PROTOCOL_A_FAILED: "Ghana Card IVS simulation failed (Protocol A). Automated settlement is paused pending review.",
    LAND_DOCUMENT_UNVERIFIED: "Land document verification failed (Protocol C). Automated settlement is paused pending review.",
    PROTOCOL_B_PENDING_MANUAL_NIA:
      "Biometric verification requires manual Lands Commission review. Automated settlement is paused.",
    PROTOCOL_SNAPSHOT_REQUIRED: "Verification protocol snapshot missing. Automated settlement is paused pending review.",
    NIA_IDENTITY_NOT_VERIFIED:
      "Seller identity prescreen is not verified by Lands Commission. Automated settlement is paused.",
    TITLE_CHAIN_GAP: "Title chain inconsistency detected. Automated settlement is paused pending review.",
    GEOMETRIC_OVERLAP_DETECTED: "Geometric overlap risk detected. Automated settlement is paused pending review.",
    ACTIVE_TRANSACTION_EXISTS: "An active transaction/lock exists for this parcel. Automated settlement is paused.",
  };
  return {
    code: primary,
    message:
      primary === "SELLER_NOT_REGISTERED_OWNER"
        ? "Listed seller does not match the registered title holder. Automated settlement is blocked pending arbitrator review."
        : messages[primary] || "Red flag raised — automated settlement is paused pending review.",
  };
}

function raiseOwnershipRedFlag(req, parcel, { buyerId, engine }) {
  const recordedOwnerId = engine.currentOwnerId(parcel);
  const firstTime = parcel.registryClearance !== "flagged" || parcel.redFlag?.code !== "SELLER_NOT_REGISTERED_OWNER";
  parcel.registryClearance = "flagged";
  parcel.redFlag = {
    code: "SELLER_NOT_REGISTERED_OWNER",
    message:
      "Listed seller does not match the registered title holder. Automated settlement is blocked pending arbitrator review.",
    raisedAt: new Date().toISOString(),
    listedSellerId: parcel.sellerId,
    recordedOwnerId,
    buyerId: String(buyerId),
  };
  parcel.status = "disputed";
  parcel.lockedUntil = null;
  if (firstTime) {
    for (const u of Array.from(store.users.values())) {
      if (u.role !== "arbitrator") continue;
      createNotification({
        userId: u.id,
        type: "red_flag",
        title: "Red flag: ownership mismatch",
        message: `Parcel “${parcel.title}” (${parcel.id}) — seller is not the recorded owner. Review required.`,
        category: "arbitration",
        actionUrl: "/arbitrator",
      });
    }
    audit(req, "red_flag.ownership_parcel", {
      parcelId: parcel.id,
      buyerId: String(buyerId),
      recordedOwnerId,
      listedSellerId: parcel.sellerId,
    });
  }
}

function raiseParcelRedFlag(req, parcel, { buyerId, engine, evaluation, source }) {
  const flags = Array.isArray(evaluation?.flags) ? evaluation.flags : [];

  if (flags.includes("SELLER_NOT_REGISTERED_OWNER")) {
    raiseOwnershipRedFlag(req, parcel, { buyerId, engine });
    return;
  }

  const firstTime = parcel.registryClearance !== "flagged" || parcel.redFlag?.code !== redFlagFromEvaluation(evaluation).code;
  const rf = redFlagFromEvaluation(evaluation);

  parcel.registryClearance = "flagged";
  parcel.redFlag = {
    code: rf.code,
    message: rf.message,
    raisedAt: new Date().toISOString(),
    listedSellerId: parcel.sellerId,
    buyerId: String(buyerId),
    // keep evaluation flags for audit / UX
    flags,
    source: source || "payments",
  };
  parcel.status = "disputed";
  parcel.lockedUntil = null;

  if (firstTime) {
    for (const u of Array.from(store.users.values())) {
      if (u.role !== "arbitrator") continue;
      createNotification({
        userId: u.id,
        type: "red_flag",
        title: `Red flag: ${rf.code}`,
        message: `Parcel “${parcel.title}” (${parcel.id}) — ${rf.message}`,
        category: "arbitration",
        actionUrl: "/arbitrator",
      });
    }
    audit(req, "red_flag.parcel", {
      parcelId: parcel.id,
      buyerId: String(buyerId),
      code: rf.code,
      flags,
      source: source || "payments",
    });
  }
}

function toPesewas(amountGhs) {
  const n = Number(amountGhs);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid amountGhs");
  return Math.round(n * 100);
}

router.post("/initialize", authenticate, async (req, res) => {
  seedIfEmpty();

  const parsed = z
    .object({
      parcelId: z.string().min(1).optional(),
      landParcelId: z.string().min(1).optional(),
      amountGhs: z.number().positive().optional(),
      channel: z.enum(["mobile_money", "bank"]).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
  const parcelId = parsed.data.parcelId ?? parsed.data.landParcelId;
  const { amountGhs, channel } = parsed.data;
  if (!parcelId) return res.status(400).json({ error: "landParcelId is required" });

  const parcel = store.parcels.get(parcelId);
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  // ── Fraud gate: re-run checks at transaction time ──────────────────────
  // Catches new fraud signals (e.g. double-sale from concurrent requests)
  if (parcel.fraudLocked) {
    return res.status(409).json({
      success: false,
      error: "FRAUD_LOCKED",
      message:
        "This parcel has been locked due to suspected fraud. " +
        "The transaction cannot proceed until Lands Commission resolves the investigation.",
      redFlag: parcel.redFlag,
    });
  }
  const fraudCheck = runFraudChecks(parcel, store);
  if (!fraudCheck.clean && fraudCheck.action === "BLOCK_AND_LOCK") {
    applyFraudFindingsToParcel(parcel, fraudCheck);
    sendFraudAlerts({ parcel, fraudResult: fraudCheck, store, createNotification, audit, req });
    return res.status(409).json({
      success: false,
      error: "FRAUD_DETECTED",
      message: `Transaction blocked — fraud signals detected: ${fraudCheck.findings.map((f) => f.flag).join(", ")}. Parcel locked pending LC review.`,
      fraudFindings: fraudCheck.findings.map((f) => ({ flag: f.flag, severity: f.severity, detail: f.detail })),
    });
  }

  // Conflict-prevention engine (pre-dispute layer): evaluate BEFORE locking/checkout
  const engine = new LandConflictEngine(store);
  const evaluation = await engine.evaluateTransaction({
    parcel_id: parcelId,
    seller_id: parcel.sellerId,
    buyer_id: req.user.id,
    geo_polygon: parcel.boundaryPolygon || null,
    title_chain: parcel.transfers || [],
    transaction_type: "sale",
  });

  audit(req, "conflict_engine.evaluate", {
    parcelId,
    result: evaluation,
  });

  if (evaluation.decision === "BLOCK") {
    return res.status(409).json({
      success: false,
      message: "Transaction blocked due to land conflict risk.",
      conflict: evaluation,
    });
  }

  if (evaluation.decision === "RED_FLAG") {
    raiseParcelRedFlag(req, parcel, { buyerId: req.user.id, engine, evaluation, source: "payments.initialize" });
    audit(req, "red_flag.checkout_blocked", { parcelId, evaluation });
    return res.status(409).json({
      success: false,
      message:
        "Red flag raised — automated settlement (fiat + on-chain anchor) is paused until review.",
      redFlag: true,
      conflict: evaluation,
    });
  }
  const now = Date.now();
  if (parcel.lockedUntil && now < parcel.lockedUntil) {
    return res.status(409).json({ error: "Parcel is locked for another transaction. Try again shortly." });
  }
  if (parcel.status !== "available") {
    return res.status(400).json({ error: "Parcel is not available" });
  }

  // Transaction locking mechanism (prevents parallel/double sale)
  const lockMs = Number(process.env.TRANSACTION_LOCK_MS || 15 * 60_000);
  parcel.status = "locked_for_transaction";
  parcel.lockedUntil = now + lockMs;

  const amount = amountGhs ?? parcel.priceGhs;
  let amountPesewas;
  try {
    amountPesewas = toPesewas(amount);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const channels =
    channel === "bank"
      ? ["bank", "card"]
      : channel === "mobile_money"
        ? ["mobile_money", "ussd"]
        : ["mobile_money", "ussd", "bank", "card"];

  const metadata = {
    parcelId: String(parcelId),
    buyerId: String(req.user.id),
  };

  try {
    const callback_url =
      process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/payment/callback` : undefined;

    const data = await initializeTransaction({
      email: req.user.email,
      amountPesewas,
      currency: "GHS",
      channels,
      metadata,
      callback_url,
    });

    const payment = {
      reference: data.reference,
      status: "pending",
      parcelId: String(parcelId),
      buyerId: String(req.user.id),
      amountPesewas,
      currency: "GHS",
      createdAt: new Date().toISOString(),
    };
    store.payments.set(payment.reference, payment);

    res.json({
      success: true,
      reference: data.reference,
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
    });
  } catch (e) {
    // Demo fallback when Paystack isn't configured
    if (!process.env.PAYSTACK_SECRET_KEY) {
      const reference = `DEMO_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
      store.payments.set(reference, {
        reference,
        status: "success",
        parcelId: String(parcelId),
        buyerId: String(req.user.id),
        amountPesewas,
        currency: "GHS",
        createdAt: new Date().toISOString(),
        demo: true,
      });
      // In demo mode, treat as immediate success; keep lock short and let verify finalize.
      return res.json({
        success: true,
        reference,
        authorizationUrl: `${process.env.FRONTEND_URL || "http://localhost:5173"}/payment/callback?reference=${reference}`,
        accessCode: reference,
        demo: true,
      });
    }
    res.status(500).json({ error: e.message || "Failed to initialize payment" });
  }
});

router.get("/verify", authenticate, async (req, res) => {
  seedIfEmpty();

  const reference = z.string().min(1).safeParse(req.query.reference);
  if (!reference.success) return res.status(400).json({ error: "reference is required" });
  const ref = reference.data;

  const existing = store.payments.get(ref);
  if (!existing) return res.status(404).json({ error: "Payment not found" });

  // Authorization: only the buyer who initiated the payment (or registry staff) may verify/finalize.
  // Prevents an attacker from finalizing someone else's checkout by guessing a reference.
  const actor = store.users.get(req.user.id) || null;
  const staffRoles = new Set(["admin", "lands_commission", "arbitrator"]);
  const isStaff = actor && staffRoles.has(actor.role);
  if (!isStaff && String(existing.buyerId) !== String(req.user.id)) {
    audit(req, "payment.verify.forbidden", { reference: ref, buyerId: existing.buyerId });
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    let verified;
    if (existing.demo) {
      verified = { status: "success", reference: ref };
    } else {
      verified = await verifyTransaction(ref);
    }

    const status = verified.status;
    if (status === "success") {
      existing.status = "success";
      existing.verifiedAt = new Date().toISOString();

      const parcel = store.parcels.get(existing.parcelId);
      let transferCreatedOrFound = null;
      if (parcel && (parcel.status === "available" || parcel.status === "locked_for_transaction")) {
        const settleEngine = new LandConflictEngine(store);
        const settlementEval = await settleEngine.evaluateTransaction({
          parcel_id: parcel.id,
          seller_id: parcel.sellerId,
          buyer_id: existing.buyerId,
          geo_polygon: parcel.boundaryPolygon || null,
          title_chain: parcel.transfers || [],
          transaction_type: "sale",
        });

        if (settlementEval.decision !== "AUTO") {
          audit(req, "payment.verify.automation_blocked", {
            reference: ref,
            evaluation: settlementEval,
          });
          if (settlementEval.decision === "RED_FLAG") {
            raiseParcelRedFlag(req, parcel, {
              buyerId: existing.buyerId,
              engine: settleEngine,
              evaluation: settlementEval,
              source: "payments.verify",
            });
          }
          existing.status = "success_no_transfer";
          // If we were mid-lock, release it. For RED_FLAG we keep parcel in disputed (set above).
          if (parcel.status === "locked_for_transaction") parcel.lockedUntil = null;
          return res.json({
            success: true,
            status: existing.status,
            message:
              "Payment verified but automated registry settlement did not run due to a red flag or conflict.",
            payment: {
              reference: ref,
              status: existing.status,
              landParcelId: existing.parcelId,
              buyerId: existing.buyerId,
              amountPesewas: existing.amountPesewas,
              currency: existing.currency,
            },
            transfer: null,
            redFlag: settlementEval.decision === "RED_FLAG",
            blocked: true,
            evaluation: settlementEval,
          });
        }

        // Escrow + multisig registry approval gate:
        // Payment success locks funds, but ownership transfer + on-chain anchoring only occur after
        // multi-party approval (Lands Commission + neutral arbitrator by default).
        parcel.status = "pending_transfer_approval";
        parcel.lockedUntil = null;
        const transferId = `transfer_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
        const transfer = {
          id: transferId,
          parcelId: parcel.id,
          sellerId: parcel.sellerId,
          buyerId: existing.buyerId,
          paystackReference: ref,
          createdAt: new Date().toISOString(),
          status: "pending_glc_approval",
          chainTxHash: null,
          chainNetwork: null,
          chainSaleId: null,
          chainAnchoredAt: null,
        };
        store.transfers.set(transfer.id, transfer);
        parcel.transfers = [...(parcel.transfers || []), transfer];
        transferCreatedOrFound = transfer;

        // Notify buyer + seller + Lands Commission/admins that escrow is pending approval.
        const buyer = store.users.get(existing.buyerId) || null;
        const seller = store.users.get(parcel.sellerId) || null;
        if (buyer) {
          createNotification({
            userId: buyer.id,
            type: "info",
            category: "transaction",
            title: "Payment received — pending registry approval",
            message: `Your payment for “${parcel.title}” is in escrow. Transfer ID: ${transfer.id}. Lands Commission approval is required before ownership is committed.`,
            actionUrl: "/buyer",
          });
        }
        if (seller) {
          createNotification({
            userId: seller.id,
            type: "info",
            category: "transaction",
            title: "Payment received — pending registry approval",
            message: `A buyer paid for “${parcel.title}”. Funds are held in escrow pending Lands Commission approval. Transfer ID: ${transfer.id}.`,
            actionUrl: "/seller",
          });
        }
        const admins = Array.from(store.users.values()).filter(
          (u) => u.role === "lands_commission" || u.role === "admin"
        );
        for (const a of admins) {
          createNotification({
            userId: a.id,
            type: "info",
            category: "transaction",
            title: "Transfer pending approval",
            message: `Escrow payment received for “${parcel.title}” (${parcel.id}). Review + approve to commit ownership. Buyer: ${buyer?.email || buyer?.id || "unknown"} · Seller: ${seller?.email || seller?.id || "unknown"} · Transfer: ${transfer.id}.`,
            actionUrl: "/admin",
          });
        }

        const arbitrators = Array.from(store.users.values()).filter((u) => u.role === "arbitrator");
        for (const a of arbitrators) {
          createNotification({
            userId: a.id,
            type: "info",
            category: "arbitration",
            title: "Transfer awaiting neutral approval",
            message: `Transfer ${transfer.id} for parcel “${parcel.title}” requires arbitrator approval before finalization.`,
            actionUrl: "/arbitrator",
          });
        }
        audit(req, "settlement.escrow.pending_approval", {
          parcelId: parcel.id,
          transferId: transfer.id,
          buyerId: existing.buyerId,
          sellerId: parcel.sellerId,
          paystackReference: ref,
        });
      } else {
        // If already finalized earlier, return the most recent transfer for this reference (if any)
        const maybe = Array.from(store.transfers.values()).find((t) => t.paystackReference === ref);
        if (maybe) transferCreatedOrFound = maybe;
      }
    } else if (status === "failed" || status === "abandoned") {
      existing.status = "failed";
      const parcel = store.parcels.get(existing.parcelId);
      if (parcel && parcel.status === "locked_for_transaction") {
        parcel.status = "available";
        parcel.lockedUntil = null;
      }
    }

    res.json({
      success: true,
      status: existing.status,
      payment: {
        reference: ref,
        status: existing.status,
        landParcelId: existing.parcelId,
        buyerId: existing.buyerId,
        amountPesewas: existing.amountPesewas,
        currency: existing.currency,
      },
      transfer: transferCreatedOrFound,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to verify payment" });
  }
});

export default router;

