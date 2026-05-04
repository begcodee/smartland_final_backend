import express from "express";
import { authenticate, requireRole, identityQueueRoles } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";
import { z } from "zod";
import { audit } from "../services/audit.js";
import { createNotification } from "./notifications.js";

const router = express.Router();

// Ghana Card/NIA responsibilities are enforced by Lands Commission in this deployment.
// NIA role is disabled for production workflow; LC/Admin are authoritative.
router.get("/users", authenticate, requireRole(...identityQueueRoles()), (_req, res) => {
  seedIfEmpty();
  const pending = Array.from(store.users.values())
    .filter((u) => u.role !== "admin" && u.role !== "lands_commission" && u.niaStatus === "pending")
    .map((u) => publicUser(u, _req.user));
  res.json({ success: true, users: pending });
});

router.post("/users/:id/decision", authenticate, requireRole(...identityQueueRoles()), (req, res) => {
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
  // Ghana Card verification is issued by Lands Commission in this deployment.
  if (decision === "rejected") target.verified = false;

  if (decision === "verified") {
    // Notify Lands Commission admins that this user is ready for document review.
    const admins = Array.from(store.users.values()).filter((u) => u.role === "lands_commission" || u.role === "admin");
    for (const a of admins) {
      createNotification({
        userId: a.id,
        type: "info",
        category: "verification",
        title: "Ghana Card verification completed",
        message: `${target.name} has been verified. Review documents and approve/reject.`,
        actionUrl: "/admin",
      });
    }
  }

  // Notify the applicant.
  createNotification({
    userId: target.id,
    type: decision === "verified" ? "success" : "error",
    category: "verification",
    title: decision === "verified" ? "Verification approved" : "Verification rejected",
    message:
      decision === "verified"
        ? "Your Ghana Card verification has been approved. Next: Lands Commission will review and approve your account."
        : "Your Ghana Card verification was rejected. Please resubmit with correct details.",
    actionUrl: decision === "verified" ? "/admin" : "/",
  });

  audit(req, "nia.user.decision", { targetUserId: target.id, decision });
  res.json({ success: true, user: publicUser(target, req.user) });
});

export default router;

