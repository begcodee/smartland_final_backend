import express from "express";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, safeParcel } from "../store.js";
import { audit } from "../services/audit.js";
import { attachProtocolCToParcel } from "../services/sellerProtocolGate.js";
import crypto from "crypto";
import { createNotification } from "./notifications.js";
import { z } from "zod";
import {
  polygonBbox,
  bboxArea,
  bboxIntersectionArea,
  geoFingerprint,
  polygonOverlapRatio,
  polygonAreaSqm,
  conflictRiskFromOverlap,
} from "../services/geo.js";
import { maybeRegisterParcelOnChain } from "../services/chainRegistry.js";

const router = express.Router();

router.get("/", (_req, res) => {
  seedIfEmpty();
  // Public list: neutral anonymity (seller is initials-only)
  const parcels = Array.from(store.parcels.values()).map((p) => safeParcel(p, { id: null, role: "public" }));
  res.json(parcels);
});

router.post("/", authenticate, requireRole("seller", "lands_commission", "admin"), (req, res) => {
  seedIfEmpty();
  const actor = store.users.get(req.user.id);
  // Parcel submission gate (KYC/risk must allow)
  if (actor?.role === "seller") {
    if (actor.niaStatus !== "verified" && actor.niaStatus != null) {
      audit(req, "parcel.create.blocked", { reason: "nia_not_verified" });
      return res.status(403).json({
        success: false,
        message: "Parcel submission blocked: Ghana Card prescreen must be verified by Lands Commission.",
      });
    }
    // Only block if explicitly set false by risk/admin — undefined (new seller) means not yet assessed → allow
    if (actor.submissionAllowed === false) {
      audit(req, "parcel.create.blocked", {
        reason: "submission_not_allowed",
        riskScore: actor.riskScore ?? null,
        flag: actor.idVerificationRiskFlag ?? null,
      });
      return res.status(403).json({
        success: false,
        message: "Parcel submission blocked: identity verification/risk review required.",
        riskScore: actor.riskScore ?? null,
        flag: actor.idVerificationRiskFlag ?? null,
      });
    }
  }

  const {
    title,
    location,
    priceGhs,
    price,
    size,
    boundaryPolygon,
    areaSqm,
    areaSqft,
    sitePlanOcrText,
    landDocumentOcrText,
    documents,
    images,
  } = req.body || {};
  const locationStr =
    typeof location === "string"
      ? location
      : location && typeof location === "object"
        ? String(location.address || location.region || "").trim() || JSON.stringify(location)
        : "";
  const priceVal = Number(priceGhs ?? price);
  if (!title || (!locationStr && !location) || !Number.isFinite(priceVal)) {
    return res.status(400).json({ error: "Missing title, location, or price (priceGhs)" });
  }

  // Conflict prevention: compute geo fingerprint + overlap risk (demo uses bbox overlap)
  let bbox = null;
  let fingerprint = null;
  let geoAreaSqm = null;
  let conflictRisk = { level: "medium", action: "review" };
  let overlapReport = null;

  if (boundaryPolygon) {
    bbox = polygonBbox(boundaryPolygon);
    if (bbox) {
      fingerprint = geoFingerprint(boundaryPolygon);
      geoAreaSqm = polygonAreaSqm(boundaryPolygon);

      const existing = Array.from(store.parcels.values()).filter((p) => p.bbox);
      let worst = { overlapRatio: 0, withParcelId: null };
      for (const p of existing) {
        // Fast bbox overlap estimate
        const a = bboxArea(bbox);
        const b = bboxArea(p.bbox);
        const inter = bboxIntersectionArea(bbox, p.bbox);
        const denom = Math.max(1e-12, Math.min(a, b));
        const bboxRatio = inter / denom;
        if (bboxRatio <= 0) continue;

        // Precise polygon overlap when both have boundary polygons
        let ratio = bboxRatio;
        if (p.boundaryPolygon) {
          const polyRatio = polygonOverlapRatio(boundaryPolygon, p.boundaryPolygon);
          if (typeof polyRatio === "number") ratio = polyRatio;
        }

        if (ratio > worst.overlapRatio) worst = { overlapRatio: ratio, withParcelId: p.id };
      }
      conflictRisk = conflictRiskFromOverlap(worst.overlapRatio);
      overlapReport = worst.withParcelId
        ? { overlapRatio: worst.overlapRatio, withParcelId: worst.withParcelId }
        : { overlapRatio: 0, withParcelId: null };

      if (conflictRisk.action === "block") {
        audit(req, "parcel.create.blocked", {
          reason: "boundary_overlap_high",
          overlap: overlapReport,
        });
        return res.status(409).json({
          success: false,
          message: "Parcel boundary overlaps an existing registered parcel. Manual verification required.",
          conflictRisk,
          overlap: overlapReport,
        });
      }
    }
  }

  // Fingerprint duplicate listing detector: same geo fingerprint already exists → flag
  if (fingerprint) {
    const dupe = Array.from(store.parcels.values()).find(
      (p) => p.geoFingerprint && String(p.geoFingerprint) === String(fingerprint)
    );
    if (dupe) {
      audit(req, "parcel.create.blocked", { reason: "geo_fingerprint_duplicate", existingParcelId: dupe.id });
      return res.status(409).json({
        success: false,
        message: "Parcel appears to be a duplicate listing (same boundary fingerprint). Manual verification required.",
        code: "DUPLICATE_GEO_FINGERPRINT",
        existingParcelId: dupe.id,
      });
    }
  }

  const id = `parcel_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const parcel = {
    id,
    title: String(title),
    location: locationStr || String(location),
    priceGhs: priceVal,
    size: size ? String(size) : null,
    areaSqm: typeof areaSqm === "number" ? areaSqm : typeof areaSqft === "number" ? Math.round(areaSqft / 10.7639104167) : null,
    areaSqft: typeof areaSqft === "number" ? areaSqft : typeof areaSqm === "number" ? Math.round(areaSqm * 10.7639104167) : null,
    geoAreaSqm,
    // Government approval layer: new parcels must be reviewed/approved by Lands Commission before listing.
    status: "pending_glc_review",
    registryClearance: "pending",
    redFlag: null,
    sellerId: req.user.id,
    createdAt: new Date().toISOString(),
    transfers: [],
    documents: Array.isArray(documents) ? documents : [],
    images: Array.isArray(images) ? images : [],
    boundaryPolygon: boundaryPolygon || null,
    bbox,
    geoFingerprint: fingerprint,
    conflictRisk,
    overlap: overlapReport,
  };

  // Key Chain security: document fingerprinting (SHA-256)
  if (!store.documentHashes) store.documentHashes = new Map();
  const docList = Array.isArray(documents) ? documents : [];
  const duplicates = [];
  for (const d of docList) {
    // Prefer server-trustable hashes or file IDs over raw base64 strings
    const preferred =
      typeof d === "string"
        ? d
        : String(d?.sha256 || d?.fileId || d?.url || d?.name || "");
    const material = preferred.trim();
    if (!material) continue;
    const h = crypto.createHash("sha256").update(material).digest("hex");
    if (store.documentHashes.has(h)) {
      duplicates.push({ hash: h, existing: store.documentHashes.get(h) });
    } else {
      store.documentHashes.set(h, { parcelId: parcel.id, docName: String(d?.name || "document"), createdAt: new Date().toISOString() });
    }
  }
  if (duplicates.length) {
    parcel.registryClearance = "flagged";
    parcel.status = "disputed";
    parcel.redFlag = {
      code: "DOCUMENT_DUPLICATE",
      message: "Duplicate document fingerprint detected. Manual review required.",
      raisedAt: new Date().toISOString(),
      duplicates: duplicates.slice(0, 3),
    };
    for (const u of Array.from(store.users.values())) {
      if (u.role !== "admin" && u.role !== "lands_commission" && u.role !== "arbitrator") continue;
      createNotification({
        userId: u.id,
        type: "red_flag",
        category: "security",
        title: "Security alert: duplicate document upload",
        message: `Parcel “${parcel.title}” was flagged because an uploaded document matches an existing fingerprint.`,
        actionUrl: u.role === "arbitrator" ? "/arbitrator" : "/admin",
      });
    }
    audit(req, "security.document_duplicate", { parcelId: parcel.id, duplicates: duplicates.length });
  }

  // Anti-impersonation: image fingerprinting (SHA-256) — flag duplicates across the registry.
  if (!store.imageHashes) store.imageHashes = new Map();
  const imgList = Array.isArray(images) ? images : [];
  const imgDupes = [];
  for (const im of imgList) {
    const raw =
      typeof im === "string"
        ? im
        : String(im?.dataUrl || im?.url || im?.name || "");
    const material = raw.trim();
    if (!material) continue;
    const h = crypto.createHash("sha256").update(material).digest("hex");
    const existing = store.imageHashes.get(h);
    if (existing) {
      imgDupes.push({ hash: h, existing });
    } else {
      store.imageHashes.set(h, {
        userId: req.user.id,
        parcelId: parcel.id,
        context: "parcel_create",
        createdAt: new Date().toISOString(),
      });
    }
  }
  if (imgDupes.length) {
    parcel.registryClearance = "flagged";
    parcel.status = "disputed";
    parcel.redFlag = {
      code: "IMAGE_DUPLICATE",
      message: "Duplicate image detected (possible impersonation). Manual review required.",
      raisedAt: new Date().toISOString(),
      duplicates: imgDupes.slice(0, 3),
    };

    // Block actor from further submissions/actions (demo-level enforcement).
    if (actor) {
      actor.submissionAllowed = false;
      actor.idVerificationRiskFlag = actor.idVerificationRiskFlag || "duplicate_image_upload";
    }

    // Alert Lands Commission/admins (and arbitrators) once.
    for (const u of Array.from(store.users.values())) {
      if (u.role !== "admin" && u.role !== "lands_commission" && u.role !== "arbitrator") continue;
      createNotification({
        userId: u.id,
        type: "red_flag",
        category: "security",
        title: "Security alert: duplicate image upload",
        message: `A parcel listing image matches an existing fingerprint. Seller: ${req.user.email || req.user.id}. Parcel: “${parcel.title}”.`,
        actionUrl: u.role === "arbitrator" ? "/arbitrator" : "/admin",
      });
    }
    audit(req, "security.image_duplicate", { parcelId: parcel.id, duplicates: imgDupes.length });
  }

  const ocrBlob = String(sitePlanOcrText || landDocumentOcrText || "").trim();
  attachProtocolCToParcel(parcel, ocrBlob);

  store.parcels.set(parcel.id, parcel);
  audit(req, "parcel.created", {
    parcelId: parcel.id,
    geoFingerprint: fingerprint,
    conflictRisk,
    overlap: overlapReport,
  });
  res.status(201).json(safeParcel(parcel, req.user));
});

// Lands Commission registry review gate (approve/reject a parcel submission)
router.patch(
  "/:id/review",
  authenticate,
  requireRole("lands_commission", "admin"),
  async (req, res) => {
    seedIfEmpty();
    const parcel = store.parcels.get(req.params.id);
    if (!parcel) return res.status(404).json({ error: "Parcel not found" });

    const parsed = z
      .object({
        action: z.enum(["approve", "reject"]),
        note: z.string().trim().max(2000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

    const action = parsed.data.action;
    const note = parsed.data.note || "";

    parcel.registryReview = parcel.registryReview || {};
    parcel.registryReview.lastReviewedAt = new Date().toISOString();
    parcel.registryReview.lastReviewedBy = req.user.id;
    parcel.registryReview.note = note;

    if (action === "reject") {
      parcel.registryClearance = "flagged";
      parcel.status = "disputed";
      parcel.redFlag = {
        code: "GLC_REJECTED",
        message: note || "Rejected by Lands Commission during registry review.",
        raisedAt: new Date().toISOString(),
      };
      audit(req, "parcel.registry.rejected", { parcelId: parcel.id, note });
      return res.json({ success: true, parcel: safeParcel(parcel, req.user) });
    }

    // approve
    parcel.registryClearance = "clear";
    parcel.status = "available";
    audit(req, "parcel.registry.approved", { parcelId: parcel.id, note });

    // Ethereum registry integration (v2): register parcel on-chain after Lands Commission approval.
    // Requires seller wallet address on file + CHAIN_* env.
    try {
      const seller = store.users.get(parcel.sellerId) || null;
      const ownerAddr = seller?.walletAddress || seller?.evmAddress || null;
      const r = await maybeRegisterParcelOnChain({
        parcel,
        ownerAddress: ownerAddr,
        metadataHash: null,
      });
      parcel.chainRegistry = {
        ...(parcel.chainRegistry || {}),
        lastAttemptAt: new Date().toISOString(),
        skipped: Boolean(r?.skipped),
        reason: r?.reason || null,
        txHash: r?.txHash || null,
        parcelIdBytes32: r?.parcelIdBytes32 || null,
        metadataHash: r?.metadataHash || null,
      };
      audit(req, "chain.registry.register_parcel", { parcelId: parcel.id, result: parcel.chainRegistry });
    } catch (e) {
      parcel.chainRegistry = {
        ...(parcel.chainRegistry || {}),
        lastAttemptAt: new Date().toISOString(),
        skipped: true,
        reason: "error",
        error: String(e?.message || e),
      };
      audit(req, "chain.registry.register_parcel_failed", { parcelId: parcel.id, error: parcel.chainRegistry.error });
    }

    return res.json({ success: true, parcel: safeParcel(parcel, req.user) });
  }
);

router.patch(
  "/:id/clear-red-flag",
  authenticate,
  requireRole("admin", "arbitrator"),
  (req, res) => {
    seedIfEmpty();
    const parcel = store.parcels.get(req.params.id);
    if (!parcel) return res.status(404).json({ error: "Parcel not found" });
    parcel.registryClearance = "clear";
    parcel.redFlag = null;
    if (parcel.status === "disputed") parcel.status = "available";
    audit(req, "parcel.red_flag_cleared", { parcelId: parcel.id });
    res.json(safeParcel(parcel));
  }
);

export default router;

