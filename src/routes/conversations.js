import express from "express";
import { authenticate } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";
import { z } from "zod";
import crypto from "crypto";
import { createNotification } from "./notifications.js";

const router = express.Router();

function id(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

router.get("/", authenticate, (_req, res) => {
  seedIfEmpty();
  const me = _req.user.id;
  const viewer = _req.user;
  const convos = Array.from(store.conversations.values())
    .filter((c) => c.buyerId === me || c.sellerId === me)
    .map((c) => ({
      ...c,
      buyer: publicUser(store.users.get(c.buyerId), viewer),
      seller: publicUser(store.users.get(c.sellerId), viewer),
      parcel: store.parcels.get(c.parcelId) || null,
      lastMessageAt:
        (store.messages.get(c.id) || []).at(-1)?.createdAt || c.createdAt,
    }))
    .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));

  res.json({ success: true, conversations: convos });
});

router.post("/start", authenticate, (req, res) => {
  seedIfEmpty();
  const viewer = req.user;
  const parsed = z
    .object({ parcelId: z.string().min(1).optional(), landParcelId: z.string().min(1).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
  const parcelId = parsed.data.parcelId ?? parsed.data.landParcelId;
  if (!parcelId) return res.status(400).json({ error: "landParcelId is required" });

  const parcel = store.parcels.get(parcelId);
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  // Global rule: no new chat threads on disputed/flagged/pending parcels.
  const blocked =
    parcel.status === "disputed" ||
    parcel.status === "pending" ||
    parcel.status === "locked_for_transaction" ||
    parcel.registryClearance === "flagged";
  if (blocked) {
    return res.status(409).json({
      success: false,
      error: "Parcel is not available for chat at this time.",
      parcelStatus: parcel.status,
      registryClearance: parcel.registryClearance,
    });
  }

  const buyerId = req.user.id;
  const sellerId = parcel.sellerId;

  let convo = Array.from(store.conversations.values()).find(
    (c) => c.parcelId === parcelId && c.buyerId === buyerId && c.sellerId === sellerId
  );

  if (!convo) {
    convo = {
      id: id("convo"),
      parcelId,
      buyerId,
      sellerId,
      createdAt: new Date().toISOString(),
    };
    store.conversations.set(convo.id, convo);
    store.messages.set(convo.id, []);
  }

  res.json({
    success: true,
    conversation: {
      id: convo.id,
      landParcel: { id: parcel.id, title: parcel.title },
      buyer: publicUser(store.users.get(convo.buyerId), viewer),
      seller: publicUser(store.users.get(convo.sellerId), viewer),
    },
  });
});

router.get("/:id", authenticate, (req, res) => {
  seedIfEmpty();
  const viewer = req.user;
  const convo = store.conversations.get(req.params.id);
  if (!convo) return res.status(404).json({ error: "Conversation not found" });
  if (convo.buyerId !== req.user.id && convo.sellerId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const parcel = store.parcels.get(convo.parcelId) || null;
  res.json({
    success: true,
    conversation: {
      id: convo.id,
      landParcel: parcel ? { id: parcel.id, title: parcel.title } : undefined,
      buyer: publicUser(store.users.get(convo.buyerId), viewer),
      seller: publicUser(store.users.get(convo.sellerId), viewer),
    },
  });
});

router.get("/:id/messages", authenticate, (req, res) => {
  seedIfEmpty();
  const viewer = req.user;
  const convo = store.conversations.get(req.params.id);
  if (!convo) return res.status(404).json({ error: "Conversation not found" });
  if (convo.buyerId !== req.user.id && convo.sellerId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const msgs = store.messages.get(convo.id) || [];
  res.json({
    success: true,
    messages: msgs.map((m) => ({
      id: m.id,
      body: m.text,
      createdAt: m.createdAt,
      senderId: m.senderId,
      sender: publicUser(store.users.get(m.senderId), viewer),
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
    })),
  });
});

router.post("/:id/messages", authenticate, (req, res) => {
  seedIfEmpty();
  const convo = store.conversations.get(req.params.id);
  if (!convo) return res.status(404).json({ error: "Conversation not found" });
  if (convo.buyerId !== req.user.id && convo.sellerId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Prevent sending messages for parcels that are pending/disputed/flagged.
  const parcel = store.parcels.get(convo.parcelId);
  if (parcel) {
    const blocked =
      parcel.status === "disputed" ||
      parcel.status === "pending" ||
      parcel.status === "locked_for_transaction" ||
      parcel.registryClearance === "flagged";
    if (blocked) {
      return res.status(409).json({
        success: false,
        error: "Messaging is paused for this parcel while it is under review/settlement.",
        parcelStatus: parcel.status,
        registryClearance: parcel.registryClearance,
      });
    }
  }

  const parsed = z
    .object({
      text: z.string().trim().min(1).max(2000).optional(),
      body: z.string().trim().min(1).max(2000).optional(),
      attachments: z
        .array(
          z.object({
            kind: z.enum(["image", "document", "audio"]),
            name: z.string().trim().min(1).max(200),
            mimeType: z.string().trim().min(1).max(120),
            // audio can be larger; still guard in demo to prevent abuse
            dataUrl: z.string().trim().min(1).max(8_000_000),
            transcript: z.string().trim().max(10_000).optional(),
          })
        )
        .max(5)
        .optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });
  const text = parsed.data.text ?? parsed.data.body;
  const attachments = parsed.data.attachments || [];
  if (!text && attachments.length === 0) return res.status(400).json({ error: "body is required" });

  // Verified-only lock for audio messages (legal-grade voice notes)
  const actor = store.users.get(req.user.id);
  const actorVerified = Boolean(actor?.verified) && actor?.niaStatus === "verified";
  const hasAudio = attachments.some((a) => a?.kind === "audio");
  if (hasAudio && !actorVerified) {
    return res.status(403).json({
      success: false,
      error: "Voice notes are available only after Lands Commission identity and account verification is complete.",
    });
  }

  // Anti-impersonation: block duplicate image re-uploads via chat attachments.
  if (!store.imageHashes) store.imageHashes = new Map();
  const imgAtt = attachments.filter((a) => a?.kind === "image");
  const dupes = [];
  for (const a of imgAtt) {
    const material = String(a?.dataUrl || "").trim();
    if (!material) continue;
    const h = crypto.createHash("sha256").update(material).digest("hex");
    const existing = store.imageHashes.get(h);
    if (existing) {
      dupes.push({ hash: h, existing });
    } else {
      store.imageHashes.set(h, {
        userId: req.user.id,
        parcelId: convo.parcelId,
        context: "chat_attachment",
        createdAt: new Date().toISOString(),
      });
    }
  }
  if (dupes.length) {
    // Alert Lands Commission/admins (and arbitrators) and block message.
    for (const u of Array.from(store.users.values())) {
      if (u.role !== "admin" && u.role !== "lands_commission" && u.role !== "arbitrator") continue;
      createNotification({
        userId: u.id,
        type: "red_flag",
        category: "security",
        title: "Security alert: duplicate image in chat",
        message: `A chat attachment image matches an existing fingerprint. User: ${req.user.email || req.user.id}. Parcel: ${convo.parcelId}.`,
        actionUrl: u.role === "arbitrator" ? "/arbitrator" : "/admin",
      });
    }
    return res.status(409).json({
      success: false,
      error: "Duplicate image detected. Upload blocked and reported to Lands Commission.",
    });
  }

  // Secure audio audit: hash + transcript integrity + red-flag keyword watchdog.
  const redFlagTerms = [
    "outside momo",
    "skip verification",
    "direct payment",
    "cash deal",
    "avoid lands commission",
    "no paperwork",
    "pay me direct",
  ];

  for (const a of attachments) {
    if (a?.kind !== "audio") continue;
    const material = String(a?.dataUrl || "").trim();
    if (!material) continue;
    const auditHash = crypto.createHash("sha256").update(material).digest("hex");
    a.auditHash = auditHash;
    a.transcriptImmutable = true;
    a.transcriptGeneratedAt = a.transcript ? new Date().toISOString() : null;

    const tx = String(a.transcript || "").toLowerCase();
    const hits = redFlagTerms.filter((t) => tx.includes(t));
    if (hits.length) {
      a.keywordFlags = hits;
      for (const u of Array.from(store.users.values())) {
        if (u.role !== "arbitrator") continue;
        createNotification({
          userId: u.id,
          type: "red_flag",
          category: "arbitration",
          title: "Keyword watchdog: suspicious audio transcript",
          message: `Parcel ${convo.parcelId} audio transcript matched terms: ${hits.join(", ")}.`,
          actionUrl: "/arbitrator",
        });
      }
    }
  }

  const msg = {
    id: id("msg"),
    conversationId: convo.id,
    senderId: req.user.id,
    text: text || "",
    createdAt: new Date().toISOString(),
    attachments,
  };

  const arr = store.messages.get(convo.id) || [];
  arr.push(msg);
  store.messages.set(convo.id, arr);

  // Real-time push to both parties
  try {
    store.realtime?.sendToUser?.(convo.buyerId, { type: "message", conversationId: convo.id, message: msg });
    store.realtime?.sendToUser?.(convo.sellerId, { type: "message", conversationId: convo.id, message: msg });
  } catch {
    // ignore
  }

  res.status(201).json({ success: true, message: msg });
});

export default router;

