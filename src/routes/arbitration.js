import express from "express";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, publicUser, safeParcel } from "../store.js";
import { audit } from "../services/audit.js";
import { createNotification } from "./notifications.js";
import { getSmartlandProtocols } from "../services/sellerProtocolGate.js";
import { z } from "zod";

const router = express.Router();

function notifyNodes({ title, message, actionUrl = "/admin" }) {
  for (const u of Array.from(store.users.values())) {
    if (u.role !== "nia" && u.role !== "lands_commission" && u.role !== "admin") continue;
    createNotification({
      userId: u.id,
      type: "red_flag",
      category: "security",
      title,
      message,
      actionUrl: u.role === "nia" ? "/nia" : actionUrl,
    });
  }
}

router.get("/cases", authenticate, requireRole("arbitrator"), (req, res) => {
  seedIfEmpty();
  const cases = Array.from(store.parcels.values())
    .filter((p) => p.status === "disputed" || p.registryClearance === "flagged")
    .map((p) => ({
      parcelId: p.id,
      title: p.title,
      status: p.status,
      registryClearance: p.registryClearance,
      redFlag: p.redFlag ? { code: p.redFlag.code, message: p.redFlag.message, raisedAt: p.redFlag.raisedAt } : null,
      createdAt: p.createdAt || null,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  res.json({ success: true, cases });
});

router.post("/cases/:parcelId/start-review", authenticate, requireRole("arbitrator"), (req, res) => {
  seedIfEmpty();
  const parcel = store.parcels.get(String(req.params.parcelId));
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  parcel.arbitration = parcel.arbitration || {};
  parcel.arbitration.startedAt = new Date().toISOString();
  parcel.arbitration.startedBy = req.user.id;

  audit(req, "arbitration.start_review", { parcelId: parcel.id });
  res.json({ success: true, startedAt: parcel.arbitration.startedAt });
});

router.get("/cases/:parcelId/evidence", authenticate, requireRole("arbitrator"), (req, res) => {
  seedIfEmpty();
  const parcel = store.parcels.get(String(req.params.parcelId));
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  const seller = store.users.get(parcel.sellerId) || null;
  const sellerProtocols = seller ? getSmartlandProtocols(seller) : null;

  const convos = Array.from(store.conversations.values()).filter((c) => c.parcelId === parcel.id);
  const convoBundles = convos.map((c) => ({
    id: c.id,
    buyerId: c.buyerId,
    sellerId: c.sellerId,
    buyer: publicUser(store.users.get(c.buyerId), req.user),
    seller: publicUser(store.users.get(c.sellerId), req.user),
    createdAt: c.createdAt,
    messages: (store.messages.get(c.id) || []).map((m) => ({
      id: m.id,
      senderId: m.senderId,
      sender: publicUser(store.users.get(m.senderId), req.user),
      text: m.text,
      createdAt: m.createdAt,
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
    })),
  }));

  res.json({
    success: true,
    parcel: safeParcel(parcel, req.user),
    seller: seller ? publicUser(seller, req.user) : null,
    sellerProtocols,
    conversations: convoBundles,
    imageHashFindings: parcel.redFlag?.code === "IMAGE_DUPLICATE" ? parcel.redFlag?.duplicates || [] : [],
    documentHashFindings: parcel.redFlag?.code === "DOCUMENT_DUPLICATE" ? parcel.redFlag?.duplicates || [] : [],
  });
});

router.post("/cases/:parcelId/action", authenticate, requireRole("arbitrator"), (req, res) => {
  seedIfEmpty();
  const parcel = store.parcels.get(String(req.params.parcelId));
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  const parsed = z
    .object({
      action: z.enum(["dismiss", "permanent_lock", "corrective_transfer", "fraud_alert_blacklist"]),
      note: z.string().trim().max(2000).optional(),
      toUserId: z.string().min(1).optional(),
      ghanaCardPin: z.string().min(1).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const note = parsed.data.note || "";
  const action = parsed.data.action;

  parcel.arbitration = parcel.arbitration || {};
  parcel.arbitration.lastActionAt = new Date().toISOString();
  parcel.arbitration.lastAction = action;
  parcel.arbitration.note = note;

  if (action === "dismiss") {
    parcel.registryClearance = "clear";
    parcel.redFlag = null;
    if (parcel.status === "disputed") parcel.status = "available";
    audit(req, "arbitration.dismiss", { parcelId: parcel.id, note });
    return res.json({ success: true, parcel: safeParcel(parcel, req.user) });
  }

  if (action === "permanent_lock") {
    parcel.status = "locked_for_transaction";
    parcel.registryClearance = "flagged";
    audit(req, "arbitration.permanent_lock", { parcelId: parcel.id, note });
    return res.json({ success: true, parcel: safeParcel(parcel, req.user) });
  }

  if (action === "corrective_transfer") {
    const toUserId = String(parsed.data.toUserId || "").trim();
    if (!toUserId) return res.status(400).json({ error: "toUserId is required" });
    if (!store.users.get(toUserId)) return res.status(404).json({ error: "Target user not found" });

    const prevSellerId = parcel.sellerId;
    parcel.sellerId = toUserId;
    parcel.status = "available";
    parcel.registryClearance = "clear";
    parcel.redFlag = null;
    parcel.transfers = Array.isArray(parcel.transfers) ? parcel.transfers : [];
    parcel.transfers.push({
      id: `transfer_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
      parcelId: parcel.id,
      sellerId: prevSellerId,
      buyerId: toUserId,
      paystackReference: "ARBITRATOR_CORRECTIVE_TRANSFER",
      createdAt: new Date().toISOString(),
      status: "completed",
      chainTxHash: null,
      chainNetwork: null,
      chainSaleId: null,
      chainAnchoredAt: null,
      note,
    });

    audit(req, "arbitration.corrective_transfer", { parcelId: parcel.id, toUserId, note });
    return res.json({ success: true, parcel: safeParcel(parcel, req.user) });
  }

  if (action === "fraud_alert_blacklist") {
    const pin = String(parsed.data.ghanaCardPin || "").trim().toUpperCase();
    if (!pin) return res.status(400).json({ error: "ghanaCardPin is required" });
    const offender = Array.from(store.users.values()).find(
      (u) => String(u.idVerification?.ghanaCard?.cardNumber || u.idVerification?.cardNumber || "").trim().toUpperCase() === pin
    );
    if (offender) {
      offender.blacklisted = true;
      offender.blacklistedAt = new Date().toISOString();
      offender.blacklistReason = note || "Fraud confirmed by arbitrator";
      offender.submissionAllowed = false;
      offender.verified = false;
    }

    notifyNodes({
      title: "Automatic Fraud Alert",
      message: `Arbitrator issued a fraud alert and blacklist for Ghana Card PIN ${pin}. ${note ? `Note: ${note}` : ""}`.trim(),
    });

    audit(req, "arbitration.fraud_alert_blacklist", { parcelId: parcel.id, pin, offenderUserId: offender?.id || null, note });
    return res.json({ success: true, ok: true, offender: offender ? publicUser(offender, req.user) : null });
  }

  return res.status(400).json({ error: "Unknown action" });
});

export default router;

