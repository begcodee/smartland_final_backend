import express from "express";
import jwt from "jsonwebtoken";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, safeParcel } from "../store.js";
import { audit } from "../services/audit.js";
import { attachProtocolCToParcel } from "../services/sellerProtocolGate.js";
import crypto from "crypto";
import { createNotification } from "./notifications.js";
import { z } from "zod";
import {
  runFraudChecks,
  applyFraudFindingsToParcel,
  sendFraudAlerts,
} from "../services/fraudDetection.js";
import {
  computeParcelContentHash,
  findDuplicateByContentHash,
  anchorParcelOnChain,
  isChainAnchored,
  assertNotAnchored,
  IMMUTABLE_FIELDS,
} from "../services/immutability.js";
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

// ─── Required document bundle ──────────────────────────────────────────────
export const REQUIRED_DOCUMENT_TYPES = [
  {
    type: "land_certificate",
    label: "Land Certificate",
    description: "Official land title / land certificate issued by Lands Commission",
  },
  {
    type: "indenture",
    label: "Indenture (Deed of Conveyance / Lease)",
    description: "Signed indenture, deed of conveyance, or registered lease document",
  },
  {
    type: "survey_plan",
    label: "Certified Survey Plan",
    description: "Certified survey plan / site plan stamped by a licensed surveyor",
  },
  {
    type: "site_plan",
    label: "Site Plan (Geospatial Context)",
    description: "Geospatial site plan showing plot boundaries and surrounding context",
  },
];

const REQUIRED_TYPES = REQUIRED_DOCUMENT_TYPES.map((d) => d.type);

/**
 * Check that all 4 required document types are present in the submitted documents array.
 * Returns the list of missing types (empty = all present).
 */
function missingRequiredDocumentTypes(documents) {
  if (!Array.isArray(documents) || documents.length === 0) return [...REQUIRED_TYPES];
  const submitted = new Set(
    documents.map((d) => String(d?.type || d?.documentType || d?.docType || "").trim().toLowerCase())
  );
  return REQUIRED_TYPES.filter((t) => !submitted.has(t));
}

// ─── GET /api/parcels/required-documents ──────────────────────────────────
// Public endpoint — frontend can fetch and render the upload form dynamically
router.get("/required-documents", (_req, res) => {
  res.json({
    success: true,
    requiredDocuments: REQUIRED_DOCUMENT_TYPES,
    rule: "All 4 documents must be uploaded. Submission is auto-rejected if any is missing.",
    order: ["land_certificate", "survey_plan", "site_plan", "indenture"],
  });
});

// ─── GET /api/parcels ──────────────────────────────────────────────────────
// Role-based visibility:
//   public / buyer     → only "available" (LC-approved) parcels
//   seller             → own parcels (any status) + available from others
//   lands_commission / admin / arbitrator → all parcels
router.get("/", (req, res) => {
  seedIfEmpty();

  // Optional auth — public browsing still works without a token
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  let viewer = { id: null, role: "public" };
  if (token) {
    try {
      const secret = process.env.JWT_SECRET?.trim() || "dev-secret-change-me";
      const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
      const u = store.users.get(payload.sub);
      if (u && u.role !== "nia") viewer = { id: u.id, role: u.role };
    } catch { /* treat as unauthenticated */ }
  }

  const all = Array.from(store.parcels.values());
  let visible;

  if (["lands_commission", "admin", "arbitrator"].includes(viewer.role)) {
    visible = all;
  } else if (viewer.role === "seller") {
    visible = all.filter((p) => p.status === "available" || p.sellerId === viewer.id);
  } else {
    // buyer / public — only LC-approved parcels
    visible = all.filter((p) => p.status === "available");
  }

  res.json(visible.map((p) => safeParcel(p, viewer)));
});

// ─── GET /api/parcels/:id ─────────────────────────────────────────────────
router.get("/:id", (req, res) => {
  seedIfEmpty();
  const parcel = store.parcels.get(String(req.params.id));
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  let viewer = { id: null, role: "public" };
  if (token) {
    try {
      const secret = process.env.JWT_SECRET?.trim() || "dev-secret-change-me";
      const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
      const u = store.users.get(payload.sub);
      if (u && u.role !== "nia") viewer = { id: u.id, role: u.role };
    } catch { /* unauthenticated */ }
  }

  // Access control: non-staff can only view available parcels (or own)
  const isStaff = ["lands_commission", "admin", "arbitrator"].includes(viewer.role);
  const isOwner = viewer.id && parcel.sellerId === viewer.id;
  if (!isStaff && !isOwner && parcel.status !== "available") {
    return res.status(404).json({ error: "Parcel not found" });
  }

  res.json(safeParcel(parcel, viewer));
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

  // ── Immutability: reject if seller already has an on-chain anchored parcel ──
  // (Content-hash duplicate check runs after docs are known — see below)

  // ── Mandatory Document Bundle Validation ──────────────────────────────────
  // All 4 document types are REQUIRED. Submission is auto-rejected if any is missing.
  const missingDocs = missingRequiredDocumentTypes(documents);
  if (missingDocs.length > 0) {
    const labels = missingDocs.map(
      (t) => REQUIRED_DOCUMENT_TYPES.find((d) => d.type === t)?.label || t
    );
    audit(req, "parcel.create.rejected", {
      reason: "missing_required_documents",
      missing: missingDocs,
    });
    return res.status(400).json({
      success: false,
      error: "Incomplete document bundle. Submission rejected.",
      message:
        "A valid land submission must include ALL 4 required documents: " +
        "Land Certificate, Indenture (Deed of Conveyance/Lease), Certified Survey Plan, and Site Plan. " +
        `Missing: ${labels.join("; ")}.`,
      requiredDocuments: REQUIRED_DOCUMENT_TYPES,
      missingTypes: missingDocs,
      missingLabels: labels,
    });
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

  // Normalise documents: ensure each has type, name, uploadedAt
  const normalisedDocs = (Array.isArray(documents) ? documents : []).map((d) => ({
    type: String(d?.type || d?.documentType || d?.docType || ""),
    name: String(d?.name || d?.filename || d?.label || d?.type || "document"),
    url: d?.url || d?.fileUrl || null,
    fileId: d?.fileId || null,
    sha256: d?.sha256 || null,
    uploadedAt: new Date().toISOString(),
  }));

  const parcel = {
    id,
    title: String(title),
    location: locationStr || String(location),
    priceGhs: priceVal,
    size: size ? String(size) : null,
    areaSqm: typeof areaSqm === "number" ? areaSqm : typeof areaSqft === "number" ? Math.round(areaSqft / 10.7639104167) : null,
    areaSqft: typeof areaSqft === "number" ? areaSqft : typeof areaSqm === "number" ? Math.round(areaSqm * 10.7639104167) : null,
    geoAreaSqm,
    // Parcels are NOT visible to buyers until Lands Commission reviews and approves
    status: "pending_glc_review",
    registryClearance: "pending",
    redFlag: null,
    sellerId: req.user.id,
    createdAt: new Date().toISOString(),
    transfers: [],
    documents: normalisedDocs,
    images: Array.isArray(images) ? images : [],
    boundaryPolygon: boundaryPolygon || null,
    bbox,
    geoFingerprint: fingerprint,
    conflictRisk,
    overlap: overlapReport,
    // Track required bundle fulfilment
    documentBundle: {
      land_certificate: normalisedDocs.some((d) => d.type === "land_certificate"),
      indenture: normalisedDocs.some((d) => d.type === "indenture"),
      survey_plan: normalisedDocs.some((d) => d.type === "survey_plan"),
      site_plan: normalisedDocs.some((d) => d.type === "site_plan"),
      complete: true, // validated above — if we reach here all 4 are present
    },
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

  // ── Content hash: compute and check for duplicate submissions ───────────
  const contentHash = computeParcelContentHash(parcel);
  parcel.contentHash = contentHash;

  const dupParcel = findDuplicateByContentHash(contentHash, store);
  if (dupParcel) {
    audit(req, "parcel.create.rejected", {
      reason: "duplicate_content_hash",
      duplicateParcelId: dupParcel.id,
      contentHash,
    });
    return res.status(409).json({
      success: false,
      error: "DUPLICATE_PARCEL_SUBMISSION",
      message:
        "This parcel submission is identical to an existing record. " +
        "Each parcel can only be registered once. " +
        (isChainAnchored(dupParcel)
          ? "The original is already anchored on the blockchain and is immutable."
          : `An identical submission already exists (id: ${dupParcel.id}, status: ${dupParcel.status}).`),
      existingParcelId: dupParcel.id,
      existingStatus: dupParcel.status,
      chainAnchored: isChainAnchored(dupParcel),
    });
  }

  // ── Fraud Detection ──────────────────────────────────────────────────────
  // Run all 5 fraud rules before persisting
  const fraudResult = runFraudChecks(parcel, store);
  if (!fraudResult.clean) {
    applyFraudFindingsToParcel(parcel, fraudResult);
  }

  store.parcels.set(parcel.id, parcel);

  // Register document hashes for future forgery detection
  for (const doc of parcel.documents) {
    const material = String(doc?.sha256 || doc?.fileId || doc?.url || doc?.name || "").trim();
    if (!material) continue;
    const h = crypto.createHash("sha256").update(material).digest("hex");
    if (!store.documentHashes.has(h)) {
      store.documentHashes.set(h, {
        parcelId: parcel.id,
        docType: doc.type,
        docName: doc.name,
        createdAt: new Date().toISOString(),
      });
    }
  }

  audit(req, "parcel.created", {
    parcelId: parcel.id,
    geoFingerprint: fingerprint,
    conflictRisk,
    overlap: overlapReport,
    documentBundle: parcel.documentBundle,
    fraudClean: fraudResult.clean,
    fraudFlags: fraudResult.findings.map((f) => f.flag),
  });

  // Send fraud alerts (owner + LC + audit trail) if any findings
  if (!fraudResult.clean) {
    sendFraudAlerts({ parcel, fraudResult, store, createNotification, audit, req });
  }

  // Notify LC for standard review (only if not already fraud-locked)
  if (fraudResult.clean || fraudResult.action === "FLAG_REVIEW") {
    for (const u of Array.from(store.users.values())) {
      if (u.role !== "lands_commission" && u.role !== "admin") continue;
      createNotification({
        userId: u.id,
        type: fraudResult.clean ? "info" : "warning",
        category: "parcel_review",
        title: fraudResult.clean
          ? `New parcel awaiting review: "${parcel.title}"`
          : `⚠ Parcel flagged for review: "${parcel.title}"`,
        message: fraudResult.clean
          ? `Submitted by ${actor?.name || req.user.email}. All 4 required documents present. Please review and approve/reject.`
          : `Submitted by ${actor?.name || req.user.email}. Fraud indicators detected: ${fraudResult.findings.map((f) => f.flag).join(", ")}. Manual review required.`,
        actionUrl: "/admin",
      });
    }
  }

  const responseStatus = fraudResult.action === "BLOCK_AND_LOCK" ? 201 : 201;
  res.status(responseStatus).json({
    success: true,
    fraudClean: fraudResult.clean,
    fraudAction: fraudResult.action,
    fraudFindings: fraudResult.clean ? [] : fraudResult.findings.map((f) => ({
      flag: f.flag, severity: f.severity, detail: f.detail,
    })),
    message: fraudResult.clean
      ? "Parcel submitted successfully. Pending Lands Commission review. Visible to buyers only after approval."
      : fraudResult.action === "BLOCK_AND_LOCK"
        ? `Parcel submission flagged as HIGH/CRITICAL risk (${fraudResult.findings.map((f) => f.flag).join(", ")}). Transaction locked pending LC investigation.`
        : `Parcel submitted with warnings. LC notified for priority review. Flags: ${fraudResult.findings.map((f) => f.flag).join(", ")}.`,
    parcel: safeParcel(parcel, req.user),
  });
});

// ─── GET /api/parcels/:id/fraud-report (LC/admin only) ───────────────────
router.get("/:id/fraud-report", authenticate, requireRole("lands_commission", "admin", "arbitrator"), (req, res) => {
  seedIfEmpty();
  const parcel = store.parcels.get(String(req.params.id));
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });
  const freshCheck = runFraudChecks(parcel, store);
  res.json({
    success: true,
    parcelId: parcel.id,
    parcelTitle: parcel.title,
    fraudLocked: Boolean(parcel.fraudLocked),
    fraudLockedAt: parcel.fraudLockedAt || null,
    storedRedFlag: parcel.redFlag || null,
    freshCheck: {
      clean: freshCheck.clean,
      action: freshCheck.action,
      highestSeverity: freshCheck.highestSeverity,
      findings: freshCheck.findings,
      checkedAt: freshCheck.checkedAt,
    },
  });
});

// ─── POST /api/parcels/:id/unlock-fraud (LC/admin only) ──────────────────
router.post("/:id/unlock-fraud", authenticate, requireRole("lands_commission", "admin"), (req, res) => {
  seedIfEmpty();
  const parcel = store.parcels.get(String(req.params.id));
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  const note = String(req.body?.note || "").trim();
  parcel.fraudLocked = false;
  parcel.fraudUnlockedAt = new Date().toISOString();
  parcel.fraudUnlockedBy = req.user.id;
  parcel.fraudUnlockNote = note;
  if (parcel.redFlag?.code && parcel.redFlag.code !== "GLC_REJECTED") {
    parcel.redFlag = null;
    parcel.registryClearance = "pending";
  }

  audit(req, "fraud.unlocked", { parcelId: parcel.id, note, unlockedBy: req.user.id });

  const seller = store.users.get(parcel.sellerId);
  if (seller) {
    createNotification({
      userId: seller.id,
      type: "success",
      category: "fraud_alert",
      title: `Fraud hold released: "${parcel.title}"`,
      message: `Lands Commission has reviewed and cleared the fraud hold on your parcel. ${note ? `Note: ${note}` : ""}`,
      actionUrl: "/",
    });
  }

  res.json({ success: true, message: "Fraud lock removed. Parcel returned to review queue.", parcel: safeParcel(parcel, req.user) });
});

// ─── Lands Commission registry review gate (approve/reject a parcel submission)
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

    // ── IMMUTABILITY: block approval if already anchored ─────────────────
    if (isChainAnchored(parcel)) {
      return res.status(403).json({
        success: false,
        error: "PARCEL_IMMUTABLE",
        message: "Parcel is already anchored on-chain. Its data is immutable.",
        chainAnchor: parcel.chainAnchor || parcel.chainRegistry,
      });
    }

    // approve → make available
    parcel.registryClearance = "clear";
    parcel.status = "available";
    parcel.approvedAt = new Date().toISOString();
    parcel.approvedBy = req.user.id;
    audit(req, "parcel.registry.approved", { parcelId: parcel.id, note });

    // ── BLOCKCHAIN ANCHOR: register on Polygon Amoy ───────────────────────
    // Once this succeeds the parcel data is IMMUTABLE on-chain.
    const seller = store.users.get(parcel.sellerId) || null;
    const ownerAddr = seller?.walletAddress || seller?.evmAddress || seller?.walletAddr || null;

    let chainResult;
    try {
      chainResult = await anchorParcelOnChain({ parcel, ownerWalletAddress: ownerAddr });
      parcel.chainAnchor = {
        txHash: chainResult?.txHash || null,
        contentHash: chainResult?.contentHash || parcel.contentHash,
        metadataHashBytes32: chainResult?.metadataHashBytes32 || null,
        anchoredAt: chainResult?.anchoredAt || new Date().toISOString(),
        skipped: Boolean(chainResult?.skipped),
        skipReason: chainResult?.reason || null,
        network: process.env.CHAIN_NETWORK_NAME || "polygon-amoy",
      };
      // Once anchored: freeze content hash so no re-submission is possible
      if (!chainResult?.skipped) {
        parcel.immutable = true;
      }
      audit(req, "chain.parcel.anchored", {
        parcelId: parcel.id,
        txHash: parcel.chainAnchor.txHash,
        contentHash: parcel.chainAnchor.contentHash,
        skipped: parcel.chainAnchor.skipped,
      });
    } catch (e) {
      parcel.chainAnchor = {
        txHash: null,
        contentHash: parcel.contentHash || null,
        skipped: true,
        skipReason: "error",
        error: String(e?.message || e),
        anchoredAt: new Date().toISOString(),
      };
      audit(req, "chain.parcel.anchor_failed", { parcelId: parcel.id, error: parcel.chainAnchor.error });
    }

    // Notify seller of approval + chain status
    if (seller) {
      createNotification({
        userId: seller.id,
        type: "success",
        category: "parcel_review",
        title: `✅ Parcel approved: "${parcel.title}"`,
        message: parcel.chainAnchor?.txHash
          ? `Your parcel has been approved by Lands Commission and anchored on the blockchain (tx: ${parcel.chainAnchor.txHash}). It is now visible to buyers. Data is immutable.`
          : `Your parcel has been approved by Lands Commission and is now visible to buyers. Blockchain anchoring is pending chain configuration.`,
        actionUrl: "/",
      });
    }

    return res.json({
      success: true,
      message: "Parcel approved. Now visible to buyers.",
      immutable: Boolean(parcel.immutable),
      chainAnchor: parcel.chainAnchor,
      parcel: safeParcel(parcel, req.user),
    });
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

// ─── PATCH /:id — General parcel edit (BLOCKED for chain-anchored parcels) ─
router.patch("/:id", authenticate, requireRole("seller", "lands_commission", "admin"), (req, res) => {
  seedIfEmpty();
  const parcel = store.parcels.get(String(req.params.id));
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  // IMMUTABILITY GUARD — on-chain parcels cannot be modified
  if (isChainAnchored(parcel)) {
    return res.status(403).json({
      success: false,
      error: "PARCEL_IMMUTABLE",
      message:
        "This parcel is anchored on the blockchain. Its data is tamper-proof and cannot be modified. " +
        `Immutable fields: ${IMMUTABLE_FIELDS.join(", ")}.`,
      chainAnchor: parcel.chainAnchor || parcel.chainRegistry || null,
      immutableFields: IMMUTABLE_FIELDS,
    });
  }

  // Only seller (owner) or LC/admin can edit a pending parcel
  if (req.user.role === "seller" && parcel.sellerId !== req.user.id) {
    return res.status(403).json({ error: "You do not own this parcel." });
  }

  // Prevent edits to submitted-but-approved parcels by seller
  if (req.user.role === "seller" && parcel.status !== "pending_glc_review") {
    return res.status(403).json({ error: "You can only edit parcels that are pending review." });
  }

  // Apply only allowed (non-immutable) fields from body
  const allowed = ["images", "notes", "contactInfo"];
  for (const field of allowed) {
    if (req.body[field] !== undefined) parcel[field] = req.body[field];
  }

  audit(req, "parcel.updated", { parcelId: parcel.id, fields: allowed.filter((f) => req.body[f] !== undefined) });
  res.json({ success: true, parcel: safeParcel(parcel, req.user) });
});

// ─── GET /api/parcels/:id/chain-status ───────────────────────────────────
// Returns the blockchain anchor status for a parcel
router.get("/:id/chain-status", (req, res) => {
  seedIfEmpty();
  const parcel = store.parcels.get(String(req.params.id));
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });
  res.json({
    parcelId: parcel.id,
    immutable: Boolean(parcel.immutable),
    chainAnchored: isChainAnchored(parcel),
    chainAnchor: parcel.chainAnchor || parcel.chainRegistry || null,
    contentHash: parcel.contentHash || null,
    status: parcel.status,
  });
});

export default router;

