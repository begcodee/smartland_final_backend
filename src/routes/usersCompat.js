import express from "express";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";
import { persistStoreNow, upsertUserToDb } from "../db/relationalStore.js";
import { z } from "zod";
import { computeRiskScore } from "../services/risk.js";
import { audit } from "../services/audit.js";
import { createNotification } from "./notifications.js";
import { getSmartlandProtocols } from "../services/sellerProtocolGate.js";

const router = express.Router();

function estimateDataUrlBytes(dataUrl) {
  const s = String(dataUrl || "");
  const comma = s.indexOf(",");
  if (comma === -1) return null;
  const b64 = s.slice(comma + 1).trim();
  if (!b64) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

router.get("/", authenticate, requireRole("lands_commission", "admin"), (_req, res) => {
  seedIfEmpty();
  res.json({ success: true, users: Array.from(store.users.values()).map((u) => publicUser(u, _req.user)) });
});

router.get("/pending", authenticate, requireRole("lands_commission", "admin"), (_req, res) => {
  seedIfEmpty();
  const pending = Array.from(store.users.values())
    // Accounts awaiting LC full account approval:
    // - Ghana Card prescreen must be verified (niaStatus === "verified")
    // - Account not yet approved (verified !== true)
    // - Any role except LC/admin staff themselves
    .filter((u) =>
      u.role !== "admin" &&
      u.role !== "lands_commission" &&
      !u.verified &&
      u.niaStatus === "verified"
    )
    .map((u) => publicUser(u, _req.user));
  res.json({ success: true, users: pending });
});

// Update my profile / save verification payload
router.patch("/me", authenticate, async (req, res) => {
  seedIfEmpty();
  const me = store.users.get(req.user.id);
  if (!me) return res.status(404).json({ error: "User not found" });

  const parsed = z
    .object({
      idVerification: z.unknown().optional(),
      email: z.string().trim().toLowerCase().email().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  // Allow user to change email (demo-friendly; used for notifications).
  if (parsed.data.email && parsed.data.email !== String(me.email || "").toLowerCase()) {
    const next = parsed.data.email;
    const dup = Array.from(store.users.values()).find(
      (u) => u.id !== me.id && String(u.email || "").toLowerCase() === next
    );
    if (dup) return res.status(409).json({ error: "Email already exists" });
    const prev = me.email;
    me.email = next;
    audit(req, "user.email.updated", { previous: prev, next });
  }

  if (parsed.data.idVerification !== undefined) {
    // Database-guard behavior (prototype): prevent duplicate submissions by the same user
    // once they have already submitted and are pending/verified.
    if (me.idVerification && (me.niaStatus === "pending" || me.niaStatus === "verified")) {
      return res.status(409).json({
        error: "Verification already submitted",
        niaStatus: me.niaStatus,
      });
    }

    // Uniqueness guard (prototype version of a DB unique constraint):
    // deny saving if this Ghana Card PIN is already linked to another user.
    try {
      const incoming = parsed.data.idVerification;
      const gh = incoming?.ghanaCard?.cardNumber || incoming?.cardNumber;
      if (gh) {
        const normalized = String(gh).trim().toUpperCase();
        const dup = Array.from(store.users.values()).find(
          (u) =>
            u.id !== me.id &&
            String(u.idVerification?.ghanaCard?.cardNumber || u.idVerification?.cardNumber || "")
              .trim()
              .toUpperCase() === normalized
        );
        if (dup) {
          return res.status(409).json({
            error: "Ghana Card PIN already exists",
            code: "UNIQUE_GHANA_CARD_PIN",
          });
        }
      }
    } catch {
      // ignore parsing issues; normal save validation handles other cases
    }

    me.idVerification = parsed.data.idVerification;
    // Don't regress identity prescreen status after it has been verified.
    if (me.niaStatus !== "verified") me.niaStatus = "pending";

    // Document-size mismatch flagging (declared size vs actual dataUrl size)
    try {
      const docs = me.idVerification?.landDocuments;
      if (Array.isArray(docs) && docs.length) {
        const flags = [];
        for (const d of docs) {
          const declared = Number(d?.size);
          const actual = estimateDataUrlBytes(d?.scannedImage);
          if (!Number.isFinite(declared) || declared <= 0 || actual === null) continue;
          const diff = Math.abs(actual - declared);
          const tol = Math.max(1024, declared * 0.1); // 10% or 1KB
          if (diff > tol) {
            flags.push({
              name: d?.name || d?.type || "document",
              declaredBytes: declared,
              actualBytes: actual,
            });
          }
        }
        me.documentSizeFlags = flags;
        if (flags.length) me.idVerificationRiskFlag = me.idVerificationRiskFlag || "document_size_mismatch";
      }
    } catch {
      // ignore
    }

    // Prototype keeps duplicate PIN as a hard error above.

    // Compute risk score snapshot (demo “KYC pipeline”)
    const userInput = {
      fullName: me.idVerification?.ghanaCard?.fullName || me.idVerification?.fullName,
      dob: me.idVerification?.dob,
      ghanaCardNumber: me.idVerification?.ghanaCard?.cardNumber || me.idVerification?.cardNumber,
    };
    const idwise = me.idVerification?.idwise || {};
    const risk = computeRiskScore({
      user: userInput,
      idwise,
      failedAttempts: me.failedVerificationAttempts || 0,
    });
    me.riskScore = risk.score;
    me.riskReasons = risk.reasons;
    me.submissionAllowed = risk.allow && me.idVerificationRiskFlag !== "ghana_card_duplicate";

    audit(req, "user.id_verification.saved", {
      niaStatus: me.niaStatus,
      riskScore: me.riskScore,
      submissionAllowed: me.submissionAllowed,
      flag: me.idVerificationRiskFlag || null,
      documentSizeFlags: me.documentSizeFlags || [],
    });

    const sp = getSmartlandProtocols(me);
    const pb = sp?.protocolB;
    if (pb && pb.skipped !== true && pb.passed === false && !me.biometricArbitratorNotified) {
      me.biometricArbitratorNotified = true;
      for (const u of Array.from(store.users.values())) {
        if (u.role !== "arbitrator") continue;
        createNotification({
          userId: u.id,
          type: "red_flag",
          category: "arbitration",
          title: "Identity theft review — biometric mismatch",
          message: `${me.name} (${me.email}) failed Protocol B (similarity ${pb.similarity ?? "?"} < threshold ${pb.threshold ?? "?"}).`,
          actionUrl: "/arbitrator",
        });
      }
      audit(req, "protocol.b.arbitrator_escalation", { userId: me.id, similarity: pb.similarity });
    }
  }

  // Persist this user immediately — niaStatus, idVerification, riskScore must survive restarts
  await upsertUserToDb(me).catch((e) =>
    console.error("[usersCompat] DB persist failed (PATCH /me):", e.message)
  );
  res.json({ success: true, user: publicUser(me, req.user) });
});

// Lands Commission admin approval (blocked until Ghana Card prescreen is verified)
router.patch("/:id/verify", authenticate, requireRole("lands_commission", "admin"), async (req, res) => {
  seedIfEmpty();
  const target = store.users.get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });

  const parsed = z
    .object({
      action: z.enum(["approve", "reject"]).optional(),
      rejectionReason: z.string().max(500).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const action = parsed.data.action || "approve";

  if (target.niaStatus !== "verified") {
    audit(req, "lands.verify_user.blocked", { targetUserId: target.id, niaStatus: target.niaStatus });
    return res.status(400).json({
      error: "User cannot be approved until Lands Commission Ghana Card prescreening is successful",
      niaStatus: target.niaStatus,
    });
  }

  if (action === "reject") {
    target.verified = false;
    target.verifiedAt = null;
    target.verifiedBy = null;
    target.rejectionReason = parsed.data.rejectionReason || "Rejected by Lands Commission";
    target.rejectedAt = new Date().toISOString();
    target.rejectedBy = req.user.id;
    createNotification({
      userId: target.id,
      type: "error",
      category: "verification",
      title: "Account verification rejected",
      message: `Your account verification was rejected by the Lands Commission. Reason: ${target.rejectionReason}`,
      actionUrl: "/",
    });
    audit(req, "lands.verify_user.rejected", { targetUserId: target.id, reason: target.rejectionReason });
    // Persist immediately — this is a critical state change
    await upsertUserToDb(target).catch((e) =>
      console.error("[verify] DB persist failed (reject):", e.message)
    );
    return res.json({ success: true, user: publicUser(target, req.user) });
  }

  // approve
  target.verified = true;
  target.verifiedAt = new Date().toISOString();
  target.verifiedBy = req.user.id;
  target.submissionAllowed = true; // ensure seller can submit parcels once verified
  createNotification({
    userId: target.id,
    type: "success",
    category: "verification",
    title: "Account approved by Lands Commission ✅",
    message:
      "Your account has been verified and approved by the Ghana Lands Commission. You now have full access to SmartLand features.",
    actionUrl:
      target.role === "seller"
        ? "/seller"
        : target.role === "buyer"
          ? "/buyer"
          : target.role === "arbitrator"
            ? "/arbitrator"
            : "/",
  });
  audit(req, "lands.verify_user.approved", { targetUserId: target.id });
  // Persist immediately — this is a critical state change
  await upsertUserToDb(target).catch((e) =>
    console.error("[verify] DB persist failed (approve):", e.message)
  );
  res.json({ success: true, user: publicUser(target, req.user) });
});

export default router;

