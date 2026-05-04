import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { seedIfEmpty, store, publicUser } from "../store.js";
import { signToken, authenticate } from "../auth.js";
import { persistStoreNow } from "../db/relationalStore.js";

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

router.post("/register", async (req, res) => {
  seedIfEmpty();

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }
  const { name, email, password, phoneNumber, organization, staffId, arbitratorRegNo } = parsed.data;
  const role = parsed.data.role === "admin" ? "lands_commission" : parsed.data.role;

  const normalizedEmail = email;
  const existing = Array.from(store.users.values()).find(
    (u) => u.email.toLowerCase() === normalizedEmail
  );
  if (existing) return res.status(409).json({ error: "Email already exists" });

  const passwordHash = await bcrypt.hash(String(password), 10);
  const id = `user_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const user = {
    id,
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
    // State-aware routing: user has not submitted Ghana Card yet.
    niaStatus: null,
    niaReferenceId: null,
    niaVerifiedAt: null,
    idVerification: null,
    // Community-driven scores start unscored (0) and grow via ratings after transactions.
    reputation: { score: 0, totalTransactions: 0, successfulTransactions: 0, disputesWon: 0, communityVotes: 0 },
    creditScore: { score: 0, rating: "Unscored", paymentHistory: 0, creditUtilization: 0, lengthOfHistory: 0, newCredit: 0, creditMix: 0 },
  };

  store.users.set(user.id, user);
  await persistStoreNow(store);

  const token = signToken(user);
  res.status(201).json({
    token,
    user: publicUser(user, { id: user.id, role: user.role }),
    message:
      "Account created. Verification takes 24–48 hours. You will receive an email/SMS update once complete.",
  });
});

router.post("/login", async (req, res) => {
  seedIfEmpty();

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;

  const normalizedEmail = email;
  const user = Array.from(store.users.values()).find(
    (u) => u.email.toLowerCase() === normalizedEmail
  );
  if (!user) {
    const prodLike =
      process.env.NODE_ENV === "production" || String(process.env.RENDER || "").toLowerCase() === "true";
    if (prodLike && store.users.size === 0) {
      return res.status(401).json({
        error: "Invalid credentials",
        message:
          "No accounts exist on this server yet. Register with POST /api/auth/register, or set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD on Render and redeploy once.",
      });
    }
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (!user.passwordHash) {
    return res.status(401).json({
      error: "Invalid credentials",
      message: "This account has no password hash (legacy row). Reset by re-registering or updating the user in the database.",
    });
  }

  const ok = await bcrypt.compare(String(password), user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  if (user.role === "nia") {
    return res.status(403).json({
      error:
        "The NIA role is not used. Log in with a Ghana Lands Commission (lands_commission) or admin account.",
    });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user, { id: user.id, role: user.role }) });
});

router.get("/me", authenticate, (req, res) => {
  res.json(req.user);
});

export default router;

