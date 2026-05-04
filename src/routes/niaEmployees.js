import express from "express";
import { z } from "zod";
import { authenticate, requireRole, identityQueueRoles } from "../auth.js";
import { seedIfEmpty, store } from "../store.js";
import { isValidGhanaCardFormat, normalizeGhanaCardNumber } from "../utils/ghanaCard.js";

const router = express.Router();

function id(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

// Demo-only staff list + attempt log (in-memory)
function ensureStaffSeeded() {
  if (store.niaEmployees && store.niaEmployees.size > 0) return;
  store.niaEmployees = new Map();
  store.employeeAttempts = [];

  const staff = [
    { staffId: "NIA-001", fullName: "Ama Mensah", ghanaCardNumber: "GHA-482951734-1", active: true },
    { staffId: "NIA-002", fullName: "Kwame Boateng", ghanaCardNumber: "GHA-739105284-2", active: true },
    { staffId: "NIA-003", fullName: "Esi Owusu", ghanaCardNumber: "GHA-615204987-3", active: false },
  ];
  for (const s of staff) store.niaEmployees.set(s.staffId, s);
}

// Ghana Card / identity verification responsibilities are enforced by Lands Commission on backend.
router.get("/staff", authenticate, requireRole(...identityQueueRoles()), (_req, res) => {
  seedIfEmpty();
  ensureStaffSeeded();
  res.json({ success: true, staff: Array.from(store.niaEmployees.values()) });
});

router.get("/attempts", authenticate, requireRole(...identityQueueRoles()), (_req, res) => {
  seedIfEmpty();
  ensureStaffSeeded();
  res.json({ success: true, attempts: store.employeeAttempts || [] });
});

router.post("/verify-employee", authenticate, requireRole(...identityQueueRoles()), (req, res) => {
  seedIfEmpty();
  ensureStaffSeeded();

  const parsed = z
    .object({
      staffId: z.string().min(1),
      ghanaCardNumber: z.string().min(1),
      fullNameOnCard: z.string().optional(),
      biometricSample: z.string().optional(),
    })
    .safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ success: false, message: "Invalid payload" });

  const staff = store.niaEmployees.get(parsed.data.staffId);
  const gh = normalizeGhanaCardNumber(parsed.data.ghanaCardNumber);

  // Step 1: Employee identification
  if (!staff) {
    const attempt = { id: id("attempt"), staffId: parsed.data.staffId, decision: "rejected", flaggedReason: "Unknown staffId", createdAt: new Date().toISOString() };
    store.employeeAttempts.push(attempt);
    return res.status(200).json({ success: true, decision: "rejected", attempt });
  }

  // Step 2: Card authentication
  if (!isValidGhanaCardFormat(gh) || normalizeGhanaCardNumber(staff.ghanaCardNumber) !== gh) {
    const attempt = { id: id("attempt"), staffId: staff.staffId, decision: "rejected", flaggedReason: "Card authentication failed", createdAt: new Date().toISOString() };
    store.employeeAttempts.push(attempt);
    return res.status(200).json({ success: true, decision: "rejected", attempt });
  }

  // Step 3: Biometric match (demo rule: must provide any biometricSample string)
  if (!parsed.data.biometricSample || String(parsed.data.biometricSample).trim().length < 6) {
    const attempt = { id: id("attempt"), staffId: staff.staffId, decision: "rejected", flaggedReason: "Biometric match failed", createdAt: new Date().toISOString() };
    store.employeeAttempts.push(attempt);
    return res.status(200).json({ success: true, decision: "rejected", attempt });
  }

  // Step 4: Internal staff validation
  if (!staff.active) {
    const attempt = { id: id("attempt"), staffId: staff.staffId, decision: "rejected", flaggedReason: "Staff is inactive", createdAt: new Date().toISOString() };
    store.employeeAttempts.push(attempt);
    return res.status(200).json({ success: true, decision: "rejected", attempt });
  }

  // Step 5: Access decision
  const attempt = { id: id("attempt"), staffId: staff.staffId, decision: "verified", createdAt: new Date().toISOString() };
  store.employeeAttempts.push(attempt);
  return res.status(200).json({ success: true, decision: "verified", attempt });
});

export default router;

