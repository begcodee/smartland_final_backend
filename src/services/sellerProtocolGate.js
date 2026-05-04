import { runProtocolC } from "./smartlandVerificationProtocols.js";

/**
 * Rule-based gate: seller must satisfy SmartLand verification protocols before automated settlement.
 * Lands Commission Ghana Card prescreen alone does not clear a failed biometric binding (Protocol B).
 */

export function getSmartlandProtocols(user) {
  const iv = user?.idVerification;
  return iv?.smartlandProtocols || iv?.smartland_protocols || null;
}

export function sellerProtocolsAllowTransaction(user) {
  const reasons = [];
  const strict = process.env.STRICT_SELLER_PROTOCOLS === "true";

  if (!user) return { ok: false, reasons: ["USER_NOT_FOUND"] };

  const sp = getSmartlandProtocols(user);

  if (user.niaStatus !== "verified") reasons.push("LC_IDENTITY_NOT_VERIFIED");

  if (strict && !sp) reasons.push("PROTOCOL_SNAPSHOT_REQUIRED");

  if (sp?.protocolA?.passed === false) reasons.push("PROTOCOL_A_FAILED");

  const pb = sp?.protocolB;
  if (pb && pb.skipped === true) {
    /* Manual LC review path — still requires identity prescreen (niaStatus) verified */
    if (user.niaStatus !== "verified") reasons.push("PROTOCOL_B_PENDING_LC_REVIEW");
  } else if (pb && pb.passed === false) {
    reasons.push("PROTOCOL_B_BIOMETRIC_FAILED");
  }

  return { ok: reasons.length === 0, reasons, protocols: sp };
}

export function parcelDocumentProtocolOk(parcel) {
  if (!parcel?.protocolC) return true;
  if (parcel.protocolC.skipped) return true;
  return parcel.protocolC.passed !== false;
}

/** Run Protocol C on parcel when OCR text supplied at registration */
export function attachProtocolCToParcel(parcel, ocrText) {
  const pc = runProtocolC(ocrText);
  parcel.protocolC = {
    passed: pc.passed,
    skipped: pc.skipped,
    flags: pc.flags || [],
    matchedLicense: pc.matchedLicense,
    checkedAt: new Date().toISOString(),
  };
  if (pc.passed === false) {
    parcel.registryClearance = "flagged";
    parcel.redFlag = {
      code: "UNVERIFIED_DOCUMENT",
      message:
        "Site plan / indenture failed simulated OCR stamp or authorized surveyor licence checks.",
      raisedAt: new Date().toISOString(),
    };
    parcel.status = "disputed";
  }
}
