import express from "express";
import { authenticate } from "../auth.js";
import { seedIfEmpty, store } from "../store.js";
import { sendEmail } from "../services/email.js";

const router = express.Router();

function id(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function ensure() {
  if (!store.notifications) store.notifications = [];
}

router.get("/", authenticate, (req, res) => {
  seedIfEmpty();
  ensure();
  const mine = store.notifications
    .filter((n) => n.userId === req.user.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ success: true, notifications: mine });
});

router.patch("/:id/read", authenticate, (req, res) => {
  seedIfEmpty();
  ensure();
  const n = store.notifications.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!n) return res.status(404).json({ success: false, message: "Notification not found" });
  n.read = true;
  res.json({ success: true });
});

export function createNotification({ userId, type, title, message, category, actionUrl }) {
  seedIfEmpty();
  ensure();
  const user = store.users.get(userId) || null;
  const n = {
    id: id("notif"),
    userId,
    type,
    title,
    message,
    category,
    actionUrl,
    read: false,
    createdAt: new Date().toISOString(),
    email: {
      to: user?.email || null,
      status: "pending",
      lastError: null,
      sentAt: null,
    },
  };
  store.notifications.push(n);

  // Fire-and-forget email (logs when SMTP/env disabled).
  sendEmail({
    to: user?.email || "",
    subject: `SmartLand: ${String(title || "Notification")}`,
    text: `${String(message || "")}\n\nOpen: ${actionUrl || "/"}`,
    category,
  }).then((result) => {
    n.email.status = result.ok ? (result.skipped ? "skipped" : "sent") : "failed";
    n.email.lastError = result.ok ? null : result.error || result.reason || "unknown";
    n.email.sentAt = result.ok && !result.skipped ? new Date().toISOString() : null;
  });

  return n;
}

export default router;

