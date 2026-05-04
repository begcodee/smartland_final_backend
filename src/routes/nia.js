import express from "express";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";
import { z } from "zod";
import { audit } from "../services/audit.js";
import { createNotification } from "./notifications.js";
import { upsertUserToDb } from "../db/relationalStore.js";

const router = express.Router();

/**
 * Verification requirements by role (Lands Commission policy):
 *   buyer / investor  → Ghana Card only
 *   seller / owner    → Ghana Card + land documents
 *   arbitrator        → Ghana Card only
 *   admin / LC        → pre-verified (not in this queue)
 */
function verificationRequirementsForRole(role) {
  const base = { ghanaCard: true };
  return role === "seller" ? { ...base, landDocuments: true } : base;
}

function buildVerificationStatus(user) {
  const req = verificationRequirementsForRole(user.role);
  const iv = user.idVerification || {};
  const ghanaCardSubmitted = Boolean(iv.ghanaCard?.cardNumber || iv.cardNumber);
  const landDocsSubmitted = Boolean(
    iv.landDocuments?.length ||
    iv.landCertificate ||
    iv.indenture ||
    iv.surveyPlan ||
    iv.sitePlan
  );
  return {
    requires: req,
    ghanaCardSubmitted,
    landDocumentsSubmitted: req.landDocuments ? landDocsSubmitted : null,
    readyForDecision:
      ghanaCardSubmitted && (!req.landDocuments || landDocsSubmitted),
  };
}

// Ghana Lands Commission identity verification queue
// Mounted at both /api/nia/users and /api/lands-commission/users (same handler).
router.get("/users", authenticate, requireRole("lands_commission", "admin"), (_req, res) => {
  seedIfEmpty();
  const queue = Array.from(store.users.values())
    .filter((u) => {
      if (u.role === "admin" || u.role === "lands_commission") return false;
      if (u.niaStatus === "pending") return true;
      if ((u.niaStatus === null || u.niaStatus === undefined) && u.idVerification) return true;
      return false;
    })
    .map((u) => ({
      ...publicUser(u, _req.user),
      verificationStatus: buildVerificationStatus(u),
    }));
  res.json({ success: true, users: queue });
});

router.post("/users/:id/decision", authenticate, requireRole("lands_commission", "admin"), (req, res) => {
  seedIfEmpty();
  const target = store.users.get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });

  const parsed = z
    .object({
      decision: z.enum(["verified", "rejected"]).optional(),
      action: z.enum(["verify", "reject"]).optional(),
      rejectionReason: z.string().max(500).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const decision =
    parsed.data.decision ??
    (parsed.data.action === "verify"
      ? "verified"
      : parsed.data.action === "reject"
        ? "rejected"
        : null);
  if (!decision) return res.status(400).json({ error: "action or decision is required" });

  // Role-based requirement check: sellers must have submitted land documents too
  const vs = buildVerificationStatus(target);
  if (decision === "verified" && !vs.readyForDecision) {
    const missing = [];
    if (!vs.ghanaCardSubmitted) missing.push("Ghana Card");
    if (target.role === "seller" && !vs.landDocumentsSubmitted) missing.push("Land Documents");
    return res.status(400).json({
      error: "Cannot verify — required documents not submitted by applicant",
      missing,
      verificationStatus: vs,
      hint: `${target.role === "seller" ? "Sellers" : "This user"} must submit: ${Object.keys(vs.requires).join(", ")}`,
    });
  }

  target.niaStatus = decision;
  target.lcVerificationId = `LC_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  target.niaReferenceId = target.lcVerificationId; // backward compat alias
  target.niaVerifiedAt = new Date().toISOString();
  target.lcVerifiedAt = target.niaVerifiedAt;
  target.niaDecidedBy = req.user.id;
  if (decision === "rejected") {
    target.verified = false;
    target.lcRejectionReason = parsed.data.rejectionReason || "Ghana Card or documents rejected by Lands Commission";
  }

  const roleLabel = target.role === "seller" ? "seller / landowner" : target.role;

  if (decision === "verified") {
    const admins = Array.from(store.users.values()).filter(
      (u) => u.role === "lands_commission" || u.role === "admin"
    );
    for (const a of admins) {
      createNotification({
        userId: a.id,
        type: "info",
        category: "verification",
        title: `Ghana Card verified — ready for account approval (${roleLabel})`,
        message: `${target.name} (${target.email}, ${roleLabel}) passed Ghana Card verification. ` +
          `${target.role === "seller" ? "Land documents also submitted. " : ""}` +
          `Approve their account via PATCH /api/users/${target.id}/verify.`,
        actionUrl: "/admin",
      });
    }
  }

  const docNote = target.role === "seller"
    ? " Your Ghana Card and land documents have been reviewed."
    : " Your Ghana Card has been reviewed.";

  createNotification({
    userId: target.id,
    type: decision === "verified" ? "success" : "error",
    category: "verification",
    title: decision === "verified"
      ? "Ghana Lands Commission — identity verification passed"
      : "Ghana Lands Commission — identity verification rejected",
    message: decision === "verified"
      ? `Your identity verification has been approved by the Ghana Lands Commission.${docNote} Your account is now awaiting final approval.`
      : `Your identity verification was rejected by the Ghana Lands Commission. Reason: ${target.lcRejectionReason}. Please resubmit.`,
    actionUrl: "/",
  });

  audit(req, "lc.identity.verification_decision", {
    targetUserId: target.id,
    role: target.role,
    decision,
    requirementsChecked: vs.requires,
  });

  // Persist immediately — critical state change must survive server restarts
  upsertUserToDb(target).catch((e) =>
    console.error("[lc-verify] DB persist failed for user", target.id, e.message)
  );

  res.json({
    success: true,
    decision,
    verificationStatus: buildVerificationStatus(target),
    user: publicUser(target, req.user),
  });
});

export default router;

