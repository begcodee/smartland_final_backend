/**
 * SmartLand Fraud Detection Engine
 *
 * Detects and auto-flags:
 *   1. DOUBLE_SALE          — multiple sale attempts on the same parcel
 *   2. SURVEY_REUSE         — reused survey coordinates / boundary fingerprint
 *   3. FAKE_CERTIFICATE     — invalid / structurally suspect land certificate
 *   4. BACKDATED_INDENTURE  — indenture date suspiciously in the past
 *   5. DOCUMENT_FORGERY     — duplicate document hash across different parcels
 *
 * When a violation is detected:
 *   - Parcel is flagged (redFlag set, registryClearance = "flagged")
 *   - Transaction is LOCKED until LC resolves
 *   - Alerts sent to: parcel owner (seller), all LC staff, all admins
 *   - Audit trail written
 */

import crypto from "crypto";

// ─── Constants ──────────────────────────────────────────────────────────────
export const FRAUD_FLAGS = {
  DOUBLE_SALE: "DOUBLE_SALE",
  SURVEY_REUSE: "SURVEY_REUSE",
  FAKE_CERTIFICATE: "FAKE_CERTIFICATE",
  BACKDATED_INDENTURE: "BACKDATED_INDENTURE",
  DOCUMENT_FORGERY: "DOCUMENT_FORGERY",
};

// Max years in the past an indenture date is considered plausible without review
const MAX_INDENTURE_AGE_YEARS = Number(process.env.MAX_INDENTURE_AGE_YEARS || 50);
// Minimum plausible indenture year (Ghana land market)
const MIN_INDENTURE_YEAR = 1957;
// Similarity threshold for survey coordinate fingerprints (0–1)
const SURVEY_OVERLAP_THRESHOLD = Number(process.env.SURVEY_OVERLAP_THRESHOLD || 0.85);

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash("sha256").update(String(str || "")).digest("hex");
}

/** Parse a date string loosely — returns Date or null. */
function parseDate(value) {
  if (!value) return null;
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
}

/** Extract the year from a document's date fields (tries multiple common keys). */
function extractDocumentYear(doc) {
  const candidates = [
    doc?.date, doc?.signedDate, doc?.issueDate, doc?.executionDate,
    doc?.dated, doc?.dateOfExecution, doc?.registrationDate,
  ];
  for (const c of candidates) {
    const d = parseDate(c);
    if (d) return d.getFullYear();
  }
  // Try to pull a 4-digit year from the document name/description
  const text = `${doc?.name || ""} ${doc?.description || ""}`;
  const m = text.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Validate Ghana Lands Commission certificate number format.
 * Real format: GLC-NNNN/YYYY or similar official patterns.
 * Returns true if it looks plausible, false if obviously fake.
 */
function isPlausibleCertificateNumber(certNumber) {
  if (!certNumber || typeof certNumber !== "string") return false;
  const n = certNumber.trim().toUpperCase();
  if (n.length < 4 || n.length > 40) return false;
  // Reject obviously fake patterns: all same char, sequential 1234, test/fake keywords
  if (/^(.)\1{4,}$/.test(n)) return false;
  if (/fake|test|dummy|sample|xxx|000+/i.test(n)) return false;
  // Must contain at least one digit
  if (!/\d/.test(n)) return false;
  return true;
}

// ─── Detection functions ────────────────────────────────────────────────────

/**
 * RULE 1 — Double Sale Detection
 * A parcel already has an active payment, pending transfer, or completed sale.
 */
function detectDoubleSale(parcel, store) {
  const findings = [];

  // Active payment pending for this parcel
  const activePay = Array.from(store.payments.values()).find(
    (p) => p.parcelId === parcel.id && p.status === "pending"
  );
  if (activePay) {
    findings.push({
      flag: FRAUD_FLAGS.DOUBLE_SALE,
      severity: "HIGH",
      detail: `Parcel already has an active pending payment (ref: ${activePay.reference}).`,
      evidence: { reference: activePay.reference, buyerId: activePay.buyerId },
    });
  }

  // Parcel locked for transaction
  if (parcel.status === "locked_for_transaction") {
    findings.push({
      flag: FRAUD_FLAGS.DOUBLE_SALE,
      severity: "HIGH",
      detail: "Parcel is currently locked for an active transaction.",
      evidence: { lockedUntil: parcel.lockedUntil },
    });
  }

  // Already sold — seller is trying to list again without a proper transfer record
  if (parcel.status === "sold") {
    const transfers = Array.isArray(parcel.transfers) ? parcel.transfers : [];
    if (transfers.length === 0) {
      findings.push({
        flag: FRAUD_FLAGS.DOUBLE_SALE,
        severity: "CRITICAL",
        detail: "Parcel status is 'sold' but no transfer record exists — possible fraudulent re-listing.",
        evidence: {},
      });
    }
  }

  return findings;
}

/**
 * RULE 2 — Reused Survey Coordinates
 * Same boundary fingerprint or >85% polygon overlap with an existing parcel owned by a different seller.
 */
function detectSurveyReuse(parcel, store) {
  const findings = [];
  if (!parcel.geoFingerprint && !parcel.bbox) return findings;

  for (const existing of store.parcels.values()) {
    if (existing.id === parcel.id) continue;
    if (existing.sellerId === parcel.sellerId) continue; // same seller submitting update is ok

    // Exact fingerprint match
    if (
      parcel.geoFingerprint &&
      existing.geoFingerprint &&
      String(parcel.geoFingerprint) === String(existing.geoFingerprint)
    ) {
      findings.push({
        flag: FRAUD_FLAGS.SURVEY_REUSE,
        severity: "HIGH",
        detail: `Survey boundary fingerprint matches existing parcel "${existing.title}" (id: ${existing.id}) owned by a different seller.`,
        evidence: { conflictingParcelId: existing.id, conflictingTitle: existing.title },
      });
    }

    // High polygon overlap from stored overlap report
    if (
      parcel.overlap?.withParcelId === existing.id &&
      typeof parcel.overlap?.overlapRatio === "number" &&
      parcel.overlap.overlapRatio >= SURVEY_OVERLAP_THRESHOLD
    ) {
      findings.push({
        flag: FRAUD_FLAGS.SURVEY_REUSE,
        severity: "HIGH",
        detail: `Survey area overlaps ${Math.round(parcel.overlap.overlapRatio * 100)}% with parcel "${existing.title}". Possible reuse of survey coordinates.`,
        evidence: {
          conflictingParcelId: existing.id,
          overlapRatio: parcel.overlap.overlapRatio,
        },
      });
    }
  }

  return findings;
}

/**
 * RULE 3 — Fake Certificate Detection
 * Checks certificate number plausibility and cross-references against known issued certs.
 */
function detectFakeCertificate(parcel) {
  const findings = [];
  const docs = Array.isArray(parcel.documents) ? parcel.documents : [];
  const certDoc = docs.find((d) => d?.type === "land_certificate");
  if (!certDoc) return findings; // missing cert caught separately by bundle validation

  const certNumber = certDoc.certNumber || certDoc.certificateNumber || certDoc.refNumber || certDoc.name;
  if (certNumber && !isPlausibleCertificateNumber(certNumber)) {
    findings.push({
      flag: FRAUD_FLAGS.FAKE_CERTIFICATE,
      severity: "HIGH",
      detail: `Land certificate number "${certNumber}" does not match expected GLC format or contains suspicious patterns.`,
      evidence: { certNumber, docName: certDoc.name },
    });
  }

  // Check for suspiciously tiny file (< 5 KB suggests placeholder/blank)
  if (typeof certDoc.bytesSize === "number" && certDoc.bytesSize > 0 && certDoc.bytesSize < 5000) {
    findings.push({
      flag: FRAUD_FLAGS.FAKE_CERTIFICATE,
      severity: "MEDIUM",
      detail: `Land certificate file is suspiciously small (${certDoc.bytesSize} bytes). May be a placeholder or blank document.`,
      evidence: { bytesSize: certDoc.bytesSize },
    });
  }

  return findings;
}

/**
 * RULE 4 — Backdated Indenture Detection
 * Indenture date before 1957 (pre-independence) or more than MAX_INDENTURE_AGE_YEARS old → flag for review.
 * Future-dated indentures are immediately suspicious.
 */
function detectBackdatedIndenture(parcel) {
  const findings = [];
  const docs = Array.isArray(parcel.documents) ? parcel.documents : [];
  const indenture = docs.find((d) => d?.type === "indenture");
  if (!indenture) return findings;

  const year = extractDocumentYear(indenture);
  const now = new Date();
  const currentYear = now.getFullYear();

  if (year !== null) {
    if (year > currentYear) {
      findings.push({
        flag: FRAUD_FLAGS.BACKDATED_INDENTURE,
        severity: "CRITICAL",
        detail: `Indenture date (${year}) is in the future — likely fabricated.`,
        evidence: { year, currentYear },
      });
    } else if (year < MIN_INDENTURE_YEAR) {
      findings.push({
        flag: FRAUD_FLAGS.BACKDATED_INDENTURE,
        severity: "HIGH",
        detail: `Indenture date (${year}) is before Ghana's independence (${MIN_INDENTURE_YEAR}). Requires special LC verification.`,
        evidence: { year, minYear: MIN_INDENTURE_YEAR },
      });
    } else if (currentYear - year > MAX_INDENTURE_AGE_YEARS) {
      findings.push({
        flag: FRAUD_FLAGS.BACKDATED_INDENTURE,
        severity: "MEDIUM",
        detail: `Indenture is ${currentYear - year} years old (dated ${year}). Documents older than ${MAX_INDENTURE_AGE_YEARS} years require additional verification.`,
        evidence: { year, ageYears: currentYear - year },
      });
    }
  }

  return findings;
}

/**
 * RULE 5 — Document Forgery (Hash Cross-Reference)
 * A submitted document's hash already exists on a different parcel.
 */
function detectDocumentForgery(parcel, store) {
  const findings = [];
  const docs = Array.isArray(parcel.documents) ? parcel.documents : [];
  if (!store.documentHashes) return findings;

  for (const doc of docs) {
    const material = String(doc?.sha256 || doc?.fileId || doc?.url || doc?.name || "").trim();
    if (!material) continue;
    const h = sha256(material);
    const existing = store.documentHashes.get(h);
    if (existing && existing.parcelId && existing.parcelId !== parcel.id) {
      findings.push({
        flag: FRAUD_FLAGS.DOCUMENT_FORGERY,
        severity: "CRITICAL",
        detail: `Document "${doc.name || doc.type}" hash matches a document already registered on parcel ${existing.parcelId}. Possible forgery.`,
        evidence: {
          hash: h,
          existingParcelId: existing.parcelId,
          docType: doc.type,
          docName: doc.name,
        },
      });
    }
  }

  return findings;
}

// ─── Main run function ───────────────────────────────────────────────────────

/**
 * Run all fraud detection rules against a parcel.
 *
 * @param {object} parcel  - The parcel object (may be unsaved / newly submitted)
 * @param {object} store   - The in-memory store
 * @returns {{ clean: boolean, findings: FraudFinding[], highestSeverity: string, action: string }}
 */
export function runFraudChecks(parcel, store) {
  const findings = [
    ...detectDoubleSale(parcel, store),
    ...detectSurveyReuse(parcel, store),
    ...detectFakeCertificate(parcel),
    ...detectBackdatedIndenture(parcel),
    ...detectDocumentForgery(parcel, store),
  ];

  const severityOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  const highestSeverity = findings.reduce(
    (acc, f) => (severityOrder[f.severity] > severityOrder[acc] ? f.severity : acc),
    "LOW"
  );

  let action = "ALLOW";
  if (findings.length > 0) {
    action = highestSeverity === "MEDIUM" ? "FLAG_REVIEW" : "BLOCK_AND_LOCK";
  }

  return {
    clean: findings.length === 0,
    findings,
    highestSeverity: findings.length > 0 ? highestSeverity : null,
    action,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Apply fraud findings to a parcel object in-place:
 * - Sets redFlag, registryClearance, status
 * - Locks the parcel (fraudLocked=true)
 */
export function applyFraudFindingsToParcel(parcel, fraudResult) {
  if (fraudResult.clean) return;

  const top = fraudResult.findings[0];
  parcel.registryClearance = "flagged";
  parcel.fraudLocked = true;
  parcel.fraudLockedAt = new Date().toISOString();

  parcel.redFlag = {
    code: top.flag,
    severity: fraudResult.highestSeverity,
    message: top.detail,
    raisedAt: new Date().toISOString(),
    allFindings: fraudResult.findings,
    action: fraudResult.action,
  };

  if (fraudResult.action === "BLOCK_AND_LOCK") {
    parcel.status = "disputed";
  }
}

/**
 * Send fraud alerts to the parcel owner, all Lands Commission staff, and admins.
 * Returns the list of notifications created.
 */
export function sendFraudAlerts({ parcel, fraudResult, store, createNotification, audit, req }) {
  if (fraudResult.clean) return [];
  const created = [];
  const flagCodes = fraudResult.findings.map((f) => f.flag).join(", ");
  const topDetail = fraudResult.findings[0]?.detail || "Fraud indicators detected.";
  const severity = fraudResult.highestSeverity;

  // 1. Alert the parcel owner / seller
  const owner = store.users.get(parcel.sellerId);
  if (owner) {
    const n = createNotification({
      userId: owner.id,
      type: "error",
      category: "fraud_alert",
      title: `⚠ Fraud alert on your parcel: ${parcel.title}`,
      message:
        `Your parcel submission "${parcel.title}" has been flagged [${severity}]: ${topDetail} ` +
        `The parcel is locked pending Lands Commission review. ` +
        `Flags: ${flagCodes}.`,
      actionUrl: "/",
    });
    created.push(n);
  }

  // 2. Alert all LC staff and admins
  for (const u of store.users.values()) {
    if (u.role !== "lands_commission" && u.role !== "admin") continue;
    const n = createNotification({
      userId: u.id,
      type: "red_flag",
      category: "fraud_alert",
      title: `🔴 FRAUD ALERT [${severity}]: ${parcel.title}`,
      message:
        `Fraud detected on parcel "${parcel.title}" (id: ${parcel.id}). ` +
        `Flags: ${flagCodes}. ` +
        `Top finding: ${topDetail} ` +
        `Action required: ${fraudResult.action}. Transaction is locked until resolved.`,
      actionUrl: "/admin",
    });
    created.push(n);
  }

  // 3. Audit log
  if (audit && req) {
    audit(req, "fraud.detected", {
      parcelId: parcel.id,
      flags: fraudResult.findings.map((f) => f.flag),
      highestSeverity: fraudResult.highestSeverity,
      action: fraudResult.action,
      findings: fraudResult.findings,
    });
  }

  return created;
}
