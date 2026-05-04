import express from "express";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, safeParcel } from "../store.js";
import { audit } from "../services/audit.js";
import { attachProtocolCToParcel } from "../services/sellerProtocolGate.js";
import crypto from "crypto";
import { createNotification } from "./notifications.js";
import {
  polygonBbox,
  bboxArea,
  bboxIntersectionArea,
  geoFingerprint,
  polygonOverlapRatio,
  polygonAreaSqm,
  conflictRiskFromOverlap,
} from "../services/geo.js";

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
    if (actor.niaStatus !== "verified") {
      audit(req, "parcel.create.blocked", { reason: "nia_not_verified" });
      return res.status(403).json({
        success: false,
        message: "Parcel submission blocked: NIA identity verification required.",
      });
    }
    if (!actor.submissionAllowed) {
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
    status: "available",
    registryClearance: "clear",
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
  res.status(201).json(safeParcel(parcel));
});

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

