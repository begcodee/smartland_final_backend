import crypto from "crypto";
import {
  isValidGhanaCardFormat,
  normalizeGhanaCardNumber,
  isObviouslyFakeGhanaCard,
  validateFullNameOnCard,
  nameSimilarity,
} from "../utils/ghanaCard.js";
import { MOCK_NIA_LEDGER } from "../data/mockNiaLedger.js";
import {
  AUTHORIZED_SURVEYOR_LICENSES,
  authorizedSurveyorPattern,
} from "../data/authorizedSurveyors.js";

export const BIOMETRIC_THRESHOLD = Number(process.env.BIOMETRIC_MATCH_THRESHOLD || 0.95);

export const THESIS = {
  protocolA:
    "Protocol A validates Ghana Card PIN format and basic plausibility checks (simulation).",
  protocolB:
    "Facial dimensions are compared using a 1:1 biometric matching algorithm (simulated) to ensure biometric binding between the holder and the Ghana Card image.",
  protocolC:
    "Land instruments are checked via simulated OCR rules for Lands Commission stamping and authorized surveyor licence numbers (GELIS stand-in).",
};

export function lookupMockNiaLedger(pin, fullName) {
  const n = normalizeGhanaCardNumber(pin);
  const row = MOCK_NIA_LEDGER.find((r) => normalizeGhanaCardNumber(r.pin) === n);
  if (!row) return { hit: false, row: null };
  const sim = nameSimilarity(row.fullName, fullName);
  const nameOk = sim >= 0.45;
  return { hit: true, row, nameSimilarity: sim, nameOk };
}

/**
 * Protocol B — simulated 1:1 match (live selfie vs card portrait image).
 * - `MOCK_BIOMETRIC_MODE=strict`: identical URLs → pass; otherwise similarity stays below threshold (lab scenario).
 * - default `demo`: two plausible image data URLs → 0.972 (passes 95% gate) so prototypes work without real CV models.
 */
export function mockBiometricSimilarity(selfieDataUrl, cardPortraitDataUrl) {
  const a = String(selfieDataUrl || "");
  const b = String(cardPortraitDataUrl || "");
  if (!a || !b) return 0;
  if (a === b) return 0.99;

  const mode = String(process.env.MOCK_BIOMETRIC_MODE || "demo").toLowerCase();

  if (mode === "strict") {
    const ha = crypto.createHash("sha256").update(a).digest("hex");
    const hb = crypto.createHash("sha256").update(b).digest("hex");
    let bitMatches = 0;
    for (let i = 0; i < ha.length; i++) if (ha[i] === hb[i]) bitMatches++;
    const hashSim = bitMatches / ha.length;
    let prefix = 0;
    const maxP = Math.min(400, a.length, b.length);
    for (let i = 0; i < maxP; i++) if (a[i] === b[i]) prefix++;
    const prefixSim = maxP ? prefix / maxP : 0;
    const combined = 0.35 * hashSim + 0.65 * prefixSim;
    return Math.round(Math.min(0.995, Math.max(0.65, 0.65 + combined * 0.34)) * 10000) / 10000;
  }

  const ok =
    a.startsWith("data:image/") &&
    b.startsWith("data:image/") &&
    a.length > 500 &&
    b.length > 500;
  return ok ? 0.972 : 0.71;
}

/** Protocol A — format + basic plausibility (no mock-ledger gating) */
export function runProtocolA(cardNumber, fullName) {
  const normalized = normalizeGhanaCardNumber(cardNumber);
  const flags = [];
  if (!isValidGhanaCardFormat(normalized)) flags.push("INVALID_ID_FORMAT");
  if (isObviouslyFakeGhanaCard(normalized)) flags.push("OBVIOUSLY_FAKE_PIN_PATTERN");
  if (!validateFullNameOnCard(fullName)) flags.push("INVALID_CARD_NAME");

  const passed = flags.length === 0;
  return {
    protocol: "A",
    name: "Ghana Card format (basic checks)",
    passed,
    pinNormalized: normalized,
    flags,
    thesisNote: THESIS.protocolA,
  };
}

/** Protocol B — liveness / binding (skipped when selfie is upload-only manual path) */
export function runProtocolB(faceImage, frontCardImage, { selfieSource }) {
  if (selfieSource === "upload") {
    return {
      protocol: "B",
      name: "Biometric binding (1:1 simulated)",
      passed: null,
      skipped: true,
      similarity: null,
      threshold: BIOMETRIC_THRESHOLD,
      reason: "SELFIE_UPLOAD_REQUIRES_MANUAL_NIA_REVIEW",
      thesisNote: THESIS.protocolB,
    };
  }
  const similarity = mockBiometricSimilarity(faceImage, frontCardImage);
  const passed = similarity >= BIOMETRIC_THRESHOLD;
  const flags = [];
  if (!passed) flags.push("BIOMETRIC_MISMATCH");
  return {
    protocol: "B",
    name: "Biometric binding (1:1 simulated)",
    passed,
    skipped: false,
    similarity,
    threshold: BIOMETRIC_THRESHOLD,
    flags,
    thesisNote: THESIS.protocolB,
  };
}

/** Protocol C — OCR text rules for indenture / site plan */
export function runProtocolC(documentText) {
  const raw = String(documentText || "").trim();
  const flags = [];
  if (!raw) {
    return {
      protocol: "C",
      name: "Land document OCR & digital stamp (simulated)",
      passed: null,
      skipped: true,
      flags: [],
      thesisNote: THESIS.protocolC,
    };
  }
  const upper = raw.toUpperCase();
  if (!upper.includes("LANDS COMMISSION")) flags.push("DOCUMENT_NOT_STAMPED_LC");
  if (!upper.includes("STAMPED")) flags.push("DOCUMENT_MISSING_STAMP_KEYWORD");
  const licPattern = authorizedSurveyorPattern();
  if (!licPattern.test(raw)) flags.push("SURVEYOR_LICENSE_MISSING_OR_UNAUTHORIZED");

  const matchedLicense = AUTHORIZED_SURVEYOR_LICENSES.find((lic) =>
    raw.toUpperCase().includes(lic.toUpperCase())
  );

  const passed = flags.length === 0;
  return {
    protocol: "C",
    name: "Land document OCR & digital stamp (simulated)",
    passed,
    skipped: false,
    matchedLicense: matchedLicense || null,
    flags,
    thesisNote: THESIS.protocolC,
  };
}

export function buildSecurityReport(protocolResults) {
  const lines = [];
  for (const p of protocolResults) {
    if (!p || p.skipped) continue;
    if (p.passed) lines.push(`${p.protocol}: PASSED — ${p.name}`);
    else lines.push(`${p.protocol}: FAILED — ${p.name} — ${(p.flags || []).join(", ")}`);
  }
  return lines;
}

/** Aggregate seller-oriented flag status (Python-style helper) */
export function verifySellerCriteriaGhanaCardBiometricDoc(cardNumber, faceMatchScore, documentText, opts = {}) {
  const flags = [];
  const pa = runProtocolA(cardNumber, opts.fullName || "");
  if (!pa.passed) flags.push(...pa.flags.map((f) => `A:${f}`));

  if (typeof faceMatchScore === "number" && faceMatchScore < BIOMETRIC_THRESHOLD) {
    flags.push("BIOMETRIC_MISMATCH");
  }

  const pc = runProtocolC(documentText || "");
  if (pc.passed === false) flags.push(...pc.flags.map((f) => `C:${f}`));

  if (flags.length) {
    return {
      status: "FLAGGED",
      reasons: flags,
      action: "Sent to Arbitrator for Manual Review",
      protocols: { A: pa, C: pc },
    };
  }
  return { status: "CLEARED", action: "Proceed to Transaction", protocols: { A: pa, C: pc } };
}
