import express from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";
import { audit } from "../services/audit.js";
import { createNotification } from "./notifications.js";

const router = express.Router();

function disputeStatusLabel(status) {
  const allowed = new Set(["filed", "pending", "under_review", "community_voting", "resolved"]);
  return allowed.has(status) ? status : "filed";
}

function getDisputeMap() {
  if (!store.disputes) store.disputes = new Map();
  return store.disputes;
}

function toClientDispute(dispute, viewer) {
  const plaintiff = store.users.get(String(dispute.plaintiffUserId)) || null;
  const defendant = store.users.get(String(dispute.defendantUserId)) || null;
  const arbitrator = dispute.arbitratorId ? store.users.get(String(dispute.arbitratorId)) || null : null;
  return {
    id: dispute.id,
    landParcelId: dispute.landParcelId,
    plaintiff: plaintiff ? publicUser(plaintiff, viewer) : null,
    defendant: defendant ? publicUser(defendant, viewer) : null,
    description: dispute.description || "",
    evidence: Array.isArray(dispute.evidence) ? dispute.evidence : [],
    status: disputeStatusLabel(dispute.status),
    filedDate: dispute.filedDate || new Date().toISOString(),
    resolution: dispute.resolution || null,
    supportVotes: Number(dispute.votes?.support || 0),
    againstVotes: Number(dispute.votes?.against || 0),
    abstainVotes: Number(dispute.votes?.abstain || 0),
    arbitrator: arbitrator ? publicUser(arbitrator, viewer) : null,
  };
}

router.get("/", authenticate, (req, res) => {
  seedIfEmpty();
  const disputes = Array.from(getDisputeMap().values()).map((d) => toClientDispute(d, req.user));
  disputes.sort((a, b) => String(b.filedDate).localeCompare(String(a.filedDate)));
  res.json({ success: true, disputes });
});

router.post("/", authenticate, (req, res) => {
  seedIfEmpty();
  const parsed = z
    .object({
      landParcelId: z.string().trim().min(1),
      defendantUserId: z.string().trim().min(1),
      description: z.string().trim().min(3).max(4000),
      evidence: z.array(z.string().trim().min(1)).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const parcel = store.parcels.get(parsed.data.landParcelId);
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  const defendant = store.users.get(parsed.data.defendantUserId);
  if (!defendant) return res.status(404).json({ error: "Defendant user not found" });
  if (String(defendant.id) === String(req.user.id)) {
    return res.status(400).json({ error: "Defendant must be a different user" });
  }

  const id = `disp_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const dispute = {
    id,
    landParcelId: parsed.data.landParcelId,
    plaintiffUserId: req.user.id,
    defendantUserId: parsed.data.defendantUserId,
    description: parsed.data.description,
    evidence: (parsed.data.evidence || []).map((name) => ({ fileName: name })),
    status: "filed",
    filedDate: new Date().toISOString(),
    resolution: null,
    votes: { support: 0, against: 0, abstain: 0 },
    votedBy: {},
    arbitratorId: null,
  };

  getDisputeMap().set(dispute.id, dispute);
  parcel.status = "disputed";
  if (parcel.registryClearance !== "flagged") parcel.registryClearance = "flagged";
  if (!parcel.redFlag) {
    parcel.redFlag = {
      code: "DISPUTE_FILED",
      message: "A dispute has been filed for this parcel.",
      raisedAt: new Date().toISOString(),
      raisedBy: req.user.id,
    };
  }

  const parcelTitle = String(parcel.title || dispute.landParcelId);
  createNotification({
    userId: defendant.id,
    type: "warning",
    category: "dispute",
    title: "New dispute filed",
    message: `A dispute was filed against you for parcel “${parcelTitle}”.`,
    actionUrl: "/buyer",
  });

  audit(req, "dispute.created", { disputeId: dispute.id, parcelId: dispute.landParcelId });
  res.status(201).json({ success: true, dispute: toClientDispute(dispute, req.user) });
});

router.post("/:id/vote", authenticate, (req, res) => {
  seedIfEmpty();
  const parsed = z.object({ vote: z.enum(["support", "against", "abstain"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const dispute = getDisputeMap().get(String(req.params.id));
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });
  if (dispute.status === "resolved") return res.status(400).json({ error: "Dispute already resolved" });

  dispute.votedBy = dispute.votedBy || {};
  const previousVote = dispute.votedBy[req.user.id];
  if (previousVote === parsed.data.vote) {
    return res.json({ success: true, dispute: toClientDispute(dispute, req.user) });
  }

  if (previousVote && dispute.votes?.[previousVote] > 0) dispute.votes[previousVote] -= 1;
  dispute.votes = dispute.votes || { support: 0, against: 0, abstain: 0 };
  dispute.votes[parsed.data.vote] += 1;
  dispute.votedBy[req.user.id] = parsed.data.vote;
  if (dispute.status === "filed" || dispute.status === "pending") dispute.status = "community_voting";

  audit(req, "dispute.voted", { disputeId: dispute.id, vote: parsed.data.vote });
  res.json({ success: true, dispute: toClientDispute(dispute, req.user) });
});

router.patch("/:id/status", authenticate, requireRole("admin", "lands_commission", "arbitrator"), (req, res) => {
  seedIfEmpty();
  const parsed = z.object({ status: z.enum(["pending", "under_review", "community_voting", "resolved"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const dispute = getDisputeMap().get(String(req.params.id));
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });

  dispute.status = parsed.data.status;
  if (req.user.role === "arbitrator") dispute.arbitratorId = req.user.id;
  if (parsed.data.status === "resolved" && !dispute.resolution) dispute.resolution = "Resolved by reviewer";

  if (parsed.data.status === "resolved") {
    const parcel = store.parcels.get(String(dispute.landParcelId));
    if (parcel && parcel.status === "disputed") {
      parcel.status = "available";
      if (parcel.redFlag?.code === "DISPUTE_FILED") {
        parcel.redFlag = null;
        parcel.registryClearance = "clear";
      }
    }
  }

  audit(req, "dispute.status_updated", { disputeId: dispute.id, status: dispute.status });
  res.json({ success: true, dispute: toClientDispute(dispute, req.user) });
});

router.post("/:id/resolve", authenticate, requireRole("admin", "lands_commission", "arbitrator"), (req, res) => {
  seedIfEmpty();
  const parsed = z.object({ resolution: z.string().trim().min(3).max(4000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const dispute = getDisputeMap().get(String(req.params.id));
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });

  dispute.status = "resolved";
  dispute.resolution = parsed.data.resolution;
  if (req.user.role === "arbitrator") dispute.arbitratorId = req.user.id;

  const parcel = store.parcels.get(String(dispute.landParcelId));
  if (parcel && parcel.status === "disputed") {
    parcel.status = "available";
    if (parcel.redFlag?.code === "DISPUTE_FILED") {
      parcel.redFlag = null;
      parcel.registryClearance = "clear";
    }
  }

  const plaintiff = store.users.get(String(dispute.plaintiffUserId));
  const defendant = store.users.get(String(dispute.defendantUserId));
  for (const u of [plaintiff, defendant]) {
    if (!u) continue;
    createNotification({
      userId: u.id,
      type: "info",
      category: "dispute",
      title: "Dispute resolved",
      message: `Dispute ${dispute.id} has been resolved.`,
      actionUrl: "/",
    });
  }

  audit(req, "dispute.resolved", { disputeId: dispute.id });
  res.json({ success: true, dispute: toClientDispute(dispute, req.user) });
});

export default router;
