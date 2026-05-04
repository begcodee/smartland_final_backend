import express from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store } from "../store.js";
import { issueRegistryVcJwt, verifyRegistryVcJwt } from "../services/ssi.js";
import { audit } from "../services/audit.js";

const router = express.Router();

// Issue a VC for a verified user (Lands Commission authoritative)
router.post("/vc/issue", authenticate, requireRole("lands_commission", "admin"), async (req, res) => {
  seedIfEmpty();
  const parsed = z
    .object({
      userId: z.string().min(1),
      subjectDid: z.string().min(8),
      claims: z.record(z.any()).optional(),
      ttlSeconds: z.number().positive().max(60 * 60 * 24 * 365).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const u = store.users.get(String(parsed.data.userId));
  if (!u) return res.status(404).json({ error: "User not found" });
  if (!(u.verified && u.niaStatus === "verified")) {
    return res.status(409).json({ error: "User must be NIA-verified and Lands-verified before VC issuance" });
  }

  const jwt = await issueRegistryVcJwt({
    subjectDid: parsed.data.subjectDid,
    subjectUserId: u.id,
    subjectEmail: u.email || null,
    claims: {
      ghanaCardVerified: true,
      landsCommissionVerified: true,
      role: u.role,
      ...(parsed.data.claims || {}),
    },
    ttlSeconds: parsed.data.ttlSeconds,
  });

  audit(req, "ssi.vc.issued", { userId: u.id, subjectDid: parsed.data.subjectDid });
  res.json({ success: true, jwt });
});

router.post("/vc/verify", authenticate, async (req, res) => {
  seedIfEmpty();
  const parsed = z.object({ jwt: z.string().min(10) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
  try {
    const out = await verifyRegistryVcJwt(parsed.data.jwt);
    audit(req, "ssi.vc.verified", { sub: out.payload.sub, iss: out.payload.iss });
    res.json({ success: true, payload: out.payload });
  } catch (e) {
    audit(req, "ssi.vc.verify_failed", { error: String(e?.message || e) });
    res.status(400).json({ success: false, error: "VC verification failed" });
  }
});

export default router;

