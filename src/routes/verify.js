import express from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";
import {
  runProtocolA,
  runProtocolB,
  buildSecurityReport,
  THESIS,
} from "../services/smartlandVerificationProtocols.js";
import { audit } from "../services/audit.js";
import { DASHBOARD_RULES } from "../services/dashboardRules.js";
import { createNotification } from "./notifications.js";

const router = express.Router();

function demoForceIdentityVerified(req, res) {
  seedIfEmpty();
  const target = store.users.get(String(req.params.id));
  if (!target) return res.status(404).json({ error: "User not found" });

  target.niaStatus = "verified";
  target.niaReferenceId = `NIA_DEMO_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  target.niaVerifiedAt = new Date().toISOString();

  createNotification({
    userId: target.id,
    type: "info",
    category: "verification",
    title: "Identity verification updated (demo)",
    message: "Your identity prescreen was set to VERIFIED for demo testing. Lands Commission can now approve your account.",
    actionUrl: "/admin",
  });

  audit(req, "demo.force_identity_verified", { targetUserId: target.id });
  res.json({ success: true, user: publicUser(target, req.user) });
}

/**
 * Ghana Card IVS simulation — Protocol A (format + mock ledger) + Protocol B (biometric binding).
 * Thesis framing returned in payload for documentation / UI.
 */
router.post("/ghana-card", authenticate, requireRole("buyer", "seller", "lands_commission", "admin"), (req, res) => {
  const parsed = z
    .object({
      cardNumber: z.string().min(1),
      fullName: z.string().min(1),
      frontCardImage: z.string().min(1),
      backCardImage: z.string().min(1),
      faceImage: z.string().min(1),
      selfieSource: z.enum(["live_camera", "upload"]).optional(),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }

  const selfieSource = parsed.data.selfieSource || "upload";

  const protocolA = runProtocolA(parsed.data.cardNumber, parsed.data.fullName);
  const protocolB = runProtocolB(parsed.data.faceImage, parsed.data.frontCardImage, { selfieSource });

  const protocolResults = [protocolA, protocolB];
  const securityReport = buildSecurityReport(protocolResults);

  const biometricMismatch = protocolB.skipped !== true && protocolB.passed === false;
  const flaggedForArbitrator = biometricMismatch;

  const preScreeningPassed =
    protocolA.passed && (protocolB.passed !== false || protocolB.skipped === true);

  const smartlandProtocols = {
    checkedAt: new Date().toISOString(),
    thesisNotes: THESIS,
    protocolA,
    protocolB,
    securityReport,
    overallPrescreenPassed: preScreeningPassed,
    flaggedForArbitrator,
  };

  audit(req, "verify.smartland_protocols", {
    protocolA: protocolA.passed,
    protocolBPassed: protocolB.passed,
    protocolBSkipped: protocolB.skipped,
    biometricMismatch,
    flaggedForArbitrator,
  });

  const referenceId = `IVS_SIM_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;

  return res.status(200).json({
    success: true,
    verified: false,
    preScreeningPassed,
    pendingManualReview: selfieSource === "upload" || protocolB.skipped === true,
    flaggedForArbitrator,
    biometricMismatch,
    referenceId,
    message: "Submission received. You will be notified of your verification status within 24–48 hours.",
    smartlandProtocols,
  });
});

router.get("/dashboard-rules", (_req, res) => {
  res.json({
    success: true,
    thesis:
      "SmartLand exposes a rule matrix per dashboard persona; enforcement is in routes + conflict engine.",
    rules: DASHBOARD_RULES,
  });
});

/**
 * Demo helper: simulate identity-queue verification for a user (niaStatus fields). DEV-only.
 */
router.post("/demo/force-identity-verified/:id", authenticate, requireRole("admin"), (req, res) => {
  const devOnly = process.env.NODE_ENV !== "production";
  if (!devOnly) return res.status(403).json({ error: "Not available in production" });
  return demoForceIdentityVerified(req, res);
});

/** @deprecated Use POST /demo/force-identity-verified/:id */
router.post("/demo/force-nia/:id", authenticate, requireRole("admin"), (req, res) => {
  const devOnly = process.env.NODE_ENV !== "production";
  if (!devOnly) {
    return res.status(410).json({
      error: "Deprecated",
      use: "POST /api/verify/demo/force-identity-verified/:id",
    });
  }
  return demoForceIdentityVerified(req, res);
});

export default router;
