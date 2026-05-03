import express from "express";
import { authenticate } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";
import { z } from "zod";
import { audit } from "../services/audit.js";

const router = express.Router();

function id(prefix = "rating") {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function computeReceivedRatingsSummary(userId) {
  const received = store.ratings.filter((r) => r.toUserId === userId);
  const count = received.length;
  const avgStars = count ? received.reduce((s, r) => s + r.stars, 0) / count : 0;
  return {
    count,
    avgStars,
    score100: count ? Math.round((avgStars / 5) * 100) : 0,
  };
}

function ratingLabelFromScore100(score100, count) {
  if (!count) return "Unscored";
  if (score100 >= 90) return "Excellent";
  if (score100 >= 75) return "Good";
  if (score100 >= 60) return "Fair";
  return "Poor";
}

function applyAggregatesToUser(userId) {
  const u = store.users.get(userId);
  if (!u) return null;

  const summary = computeReceivedRatingsSummary(userId);
  u.reputation = u.reputation || { score: 0, totalTransactions: 0, successfulTransactions: 0, disputesWon: 0, communityVotes: 0 };
  u.reputation.score = summary.score100;
  u.reputation.communityVotes = summary.count;

  u.creditScore = u.creditScore || { score: 0, rating: "Unscored", paymentHistory: 0, creditUtilization: 0, lengthOfHistory: 0, newCredit: 0, creditMix: 0 };
  u.creditScore.score = summary.score100;
  u.creditScore.rating = ratingLabelFromScore100(summary.score100, summary.count);

  return summary;
}

function isRaterAllowedForTransfer({ fromUserId, toUserId, transferId }) {
  const t = store.transfers.get(String(transferId));
  if (!t) return { ok: false, reason: "Transfer not found" };
  const isParticipant = t.buyerId === fromUserId || t.sellerId === fromUserId;
  if (!isParticipant) return { ok: false, reason: "You are not part of this transaction" };

  const expectedCounterparty =
    t.buyerId === fromUserId ? t.sellerId : t.buyerId;
  if (String(toUserId) !== String(expectedCounterparty)) {
    return { ok: false, reason: "Rating target must be your counterparty for this transaction" };
  }

  return { ok: true, transfer: t };
}

router.get("/users/:id/summary", authenticate, (req, res) => {
  seedIfEmpty();
  const userId = String(req.params.id);
  const u = store.users.get(userId);
  if (!u) return res.status(404).json({ error: "User not found" });
  const summary = computeReceivedRatingsSummary(userId);
  res.json({ success: true, user: publicUser(u, req.user), summary });
});

router.get("/users/:id", authenticate, (req, res) => {
  seedIfEmpty();
  const userId = String(req.params.id);
  const u = store.users.get(userId);
  if (!u) return res.status(404).json({ error: "User not found" });
  const received = store.ratings
    .filter((r) => r.toUserId === userId)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ success: true, user: publicUser(u, req.user), ratings: received });
});

router.post("/", authenticate, (req, res) => {
  seedIfEmpty();
  const parsed = z
    .object({
      toUserId: z.string().min(1),
      stars: z.number().int().min(1).max(5),
      context: z
        .object({
          type: z.enum(["transfer"]),
          transferId: z.string().min(1),
        })
        .strict(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const fromUserId = String(req.user.id);
  const { toUserId, stars, context } = parsed.data;
  if (fromUserId === String(toUserId)) return res.status(400).json({ error: "You cannot rate yourself" });

  const allowed = isRaterAllowedForTransfer({ fromUserId, toUserId, transferId: context.transferId });
  if (!allowed.ok) return res.status(403).json({ error: allowed.reason });

  // Prevent duplicate rating from the same user for the same transfer + target
  const dup = store.ratings.find(
    (r) =>
      r.fromUserId === fromUserId &&
      r.toUserId === String(toUserId) &&
      r.context?.type === "transfer" &&
      String(r.context?.transferId) === String(context.transferId)
  );
  if (dup) return res.status(409).json({ error: "You already rated this transaction" });

  const rating = {
    id: id(),
    fromUserId,
    toUserId: String(toUserId),
    stars,
    context: { type: "transfer", transferId: String(context.transferId) },
    createdAt: new Date().toISOString(),
  };
  store.ratings.push(rating);

  const summary = applyAggregatesToUser(String(toUserId));

  audit(req, "rating.created", {
    fromUserId,
    toUserId: String(toUserId),
    stars,
    context,
    summary,
  });

  res.status(201).json({ success: true, rating, summary });
});

export default router;

