import express from "express";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";
import { z } from "zod";
import { audit } from "../services/audit.js";
import { createNotification } from "./notifications.js";
import { upsertUserToDb } from "../db/relationalStore.js";

const router = express.Router();

// Ghana Lands Commission verifies Ghana Card prescreening (niaStatus) for buyers and sellers.
// Routes stay under /api/nia for compatibility; mirror: /api/lands-commission (see index.js).
router.get("/users", authenticate, requireRole("lands_commission", "admin"), (_req, res) => {
  seedIfEmpty();
  const queue = Array.from(store.users.values())
    .filter((u) => {
      if (u.role === "admin" || u.role === "lands_commission") return false;
      // Show users who are pending Ghana Card verification (niaStatus=pending)
      // OR who have submitted idVerification but niaStatus is still null (just registered + submitted)
      if (u.niaStatus === "pending") return true;
      if (u.niaStatus === null && u.idVerification) return true;
      return false;
    })
    .map((u) => publicUser(u, _req.user));
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
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }
  const decision =
    parsed.data.decision ??
    (parsed.data.action === "verify"
      ? "verified"
      : parsed.data.action === "reject"
        ? "rejected"
        : null);
  if (!decision) return res.status(400).json({ error: "action/decision is required" });

  target.niaStatus = decision;
  target.niaReferenceId = `NIA_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  target.niaVerifiedAt = new Date().toISOString();
  target.niaDecidedBy = req.user.id;
  // Ghana Card verification is issued by Lands Commission in this deployment.
  if (decision === "rejected") target.verified = false;

  if (decision === "verified") {
    // Notify Lands Commission admins that this user is ready for account document review.
    const admins = Array.from(store.users.values()).filter((u) => u.role === "lands_commission" || u.role === "admin");
    for (const a of admins) {
      createNotification({
        userId: a.id,
        type: "info",
        category: "verification",
        title: "Ghana Card prescreening passed — ready for account approval",
        message: `${target.name} (${target.email}) passed Ghana Card verification. Review their account documents and approve/reject via PATCH /api/users/${target.id}/verify.`,
        actionUrl: "/admin",
      });
    }
  }

  // Notify the applicant.
  createNotification({
    userId: target.id,
    type: decision === "verified" ? "success" : "error",
    category: "verification",
    title: decision === "verified" ? "Ghana Card prescreening approved" : "Ghana Card prescreening rejected",
    message:
      decision === "verified"
        ? "Your Ghana Card prescreening has been approved by Lands Commission. Lands Commission will now review and approve your account."
        : "Your Ghana Card prescreening was rejected. Please resubmit with correct details.",
    actionUrl: decision === "verified" ? "/" : "/",
  });

  audit(req, "lands.identity.queue_decision", { targetUserId: target.id, decision });

  // ── CRITICAL: Persist immediately to database ──────────────────────────
  // Without this, the niaStatus change is lost on server restart (Render cold start).
  upsertUserToDb(target).catch((e) =>
    console.error("[nia] Failed to persist decision to DB for user", target.id, e.message)
  );

  res.json({ success: true, user: publicUser(target, req.user) });
});

export default router;

