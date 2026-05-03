import { seedIfEmpty, store } from "../store.js";
import crypto from "crypto";

function id(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function pickIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  return req.ip;
}

export function audit(req, event, details = {}) {
  seedIfEmpty();
  if (!store.auditLogs) store.auditLogs = [];
  const prev = store.auditLogs.length ? store.auditLogs[store.auditLogs.length - 1] : null;
  const prevHash = prev?.hash || null;
  const payload = JSON.stringify({
    prevHash,
    at: new Date().toISOString(),
    event,
    actorUserId: req.user?.id ?? null,
    ip: pickIp(req),
    userAgent: String(req.headers["user-agent"] || ""),
    details,
  });
  const hash = crypto.createHash("sha256").update(payload).digest("hex");

  const entry = {
    id: id("audit"),
    at: JSON.parse(payload).at,
    event,
    actorUserId: req.user?.id ?? null,
    ip: pickIp(req),
    userAgent: String(req.headers["user-agent"] || ""),
    details,
    prevHash,
    hash,
  };
  store.auditLogs.push(entry);
  return entry;
}

