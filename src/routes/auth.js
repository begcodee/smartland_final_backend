import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { seedIfEmpty, store, publicUser } from "../store.js";
import { signToken, authenticate } from "../auth.js";
import {
  upsertUserToDb,
  findUserByEmailInDb,
  findUserByIdInDb,
} from "../db/relationalStore.js";

const router = express.Router();

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  role: z.enum(["buyer", "seller", "lands_commission", "admin", "arbitrator"]),
  phoneNumber: z.string().trim().min(7).max(40).optional().nullable(),
  organization: z.string().trim().min(2).max(200).optional().nullable(),
  staffId: z.string().trim().min(2).max(50).optional().nullable(),
  arbitratorRegNo: z.string().trim().min(2).max(50).optional().nullable(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

/** Normalize common frontend field aliases → { email, password }. */
function normalizeLoginBody(body) {
  if (!body || typeof body !== "object") return body;
  const b = { ...body };
  const emailish =
    b.email ??
    b.userEmail ??
    b.user_email ??
    (typeof b.username === "string" && String(b.username).includes("@") ? b.username : undefined);
  if (emailish != null && b.email == null) b.email = emailish;
  const pass = b.password ?? b.pass ?? b.pwd ?? b.userPassword ?? b.user_password;
  if (pass != null && b.password == null) b.password = pass;
  return b;
}

/** ──────────────────────── REGISTER ──────────────────────── */
router.post("/register", async (req, res) => {
  seedIfEmpty();

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }
  const { name, email, password, phoneNumber, organization, staffId, arbitratorRegNo } = parsed.data;
  const role = parsed.data.role === "admin" ? "lands_commission" : parsed.data.role;
  const normalizedEmail = String(email).trim().toLowerCase();

  // Duplicate check: memory store first, then DB (handles cold-start gaps)
  const inMemory = Array.from(store.users.values()).find(
    (u) => String(u.email || "").toLowerCase() === normalizedEmail
  );
  if (inMemory) return res.status(409).json({ error: "Email already exists" });

  const inDb = await findUserByEmailInDb(normalizedEmail);
  if (inDb) {
    // Sync the DB row back into the memory store so subsequent operations see it
    store.users.set(inDb.id, inDb);
    return res.status(409).json({ error: "Email already exists" });
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  const uid = `user_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const user = {
    id: uid,
    name: String(name).trim(),
    email: normalizedEmail,
    phoneNumber: phoneNumber ? String(phoneNumber) : null,
    role,
    organization: organization ? String(organization) : null,
    staffId: staffId ? String(staffId) : null,
    arbitratorRegNo: arbitratorRegNo ? String(arbitratorRegNo) : null,
    passwordHash,
    createdAt: new Date().toISOString(),
    verified: false,
    niaStatus: null,
    niaReferenceId: null,
    niaVerifiedAt: null,
    idVerification: null,
    reputation: { score: 0, totalTransactions: 0, successfulTransactions: 0, disputesWon: 0, communityVotes: 0 },
    creditScore: { score: 0, rating: "Unscored", paymentHistory: 0, creditUtilization: 0, lengthOfHistory: 0, newCredit: 0, creditMix: 0 },
  };

  // 1. Add to in-memory store immediately (user can login right away)
  store.users.set(user.id, user);

  // 2. Persist to DB — if it fails we log and retry via the periodic scheduler
  upsertUserToDb(user).catch((e) =>
    console.error("[register] DB write failed (will retry on next flush):", e.message)
  );

  const token = signToken(user);
  res.status(201).json({
    token,
    user: publicUser(user, { id: user.id, role: user.role }),
    message: "Account created successfully.",
  });
});

/** ──────────────────────── LOGIN ──────────────────────── */
router.post("/login", async (req, res) => {
  seedIfEmpty();

  const parsed = loginSchema.safeParse(normalizeLoginBody(req.body));
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid payload",
      hint: "Send JSON with 'email' and 'password'.",
      details: parsed.error.flatten(),
    });
  }
  const { email, password } = parsed.data;
  const normalizedEmail = String(email).trim().toLowerCase();

  // Primary: memory store (fast path — populated at startup from DB)
  let user = Array.from(store.users.values()).find(
    (u) => String(u.email || "").toLowerCase() === normalizedEmail
  );

  // Fallback: direct DB lookup — handles Render cold-starts, store-reload gaps,
  // or a user who registered on a different instance
  if (!user) {
    user = await findUserByEmailInDb(normalizedEmail);
    if (user) {
      // Sync back into memory so subsequent requests are fast
      store.users.set(user.id, user);
    }
  }

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (!user.passwordHash) {
    return res.status(401).json({
      error: "Invalid credentials",
      hint: "This account has no password. Run npm run db:ensure-admin or re-register.",
    });
  }

  const ok = await bcrypt.compare(String(password), user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (user.role === "nia") {
    return res.status(403).json({
      error: "The NIA role is no longer used. Log in with a Lands Commission or admin account.",
    });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user, { id: user.id, role: user.role }) });
});

/** ──────────────────────── GET /me ──────────────────────── */
router.get("/me", authenticate, async (req, res) => {
  // Always return the freshest profile: check memory first, re-sync from DB if stale
  let user = store.users.get(req.user.id);
  if (!user) {
    user = await findUserByIdInDb(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    store.users.set(user.id, user);
  }
  res.json(publicUser(user, { id: user.id, role: user.role }));
});

export default router;

