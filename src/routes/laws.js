import express from "express";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store } from "../store.js";
import { audit } from "../services/audit.js";

const router = express.Router();

function lawId() {
  return `law_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function nowIso() {
  return new Date().toISOString();
}

const ALLOWED_STATUS = new Set(["draft", "active"]);
const ALLOWED_CATEGORY = new Set(["registration", "transfer", "dispute", "environmental", "general"]);

/** Public read — same catalogue for all roles (prototype). */
router.get("/", (_req, res) => {
  seedIfEmpty();
  const sorted = [...store.laws].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json({ laws: sorted });
});

router.post("/", authenticate, requireRole("admin"), (req, res) => {
  seedIfEmpty();
  const { code, title, summary, body, category, effectiveFrom, status } = req.body || {};
  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }
  const cat = typeof category === "string" && ALLOWED_CATEGORY.has(category) ? category : "general";
  const st = typeof status === "string" && ALLOWED_STATUS.has(status) ? status : "draft";
  const law = {
    id: lawId(),
    code: typeof code === "string" && code.trim() ? code.trim() : `POL-${Date.now()}`,
    title: title.trim(),
    summary: typeof summary === "string" ? summary.trim() : "",
    body: typeof body === "string" ? body.trim() : "",
    category: cat,
    effectiveFrom: typeof effectiveFrom === "string" ? effectiveFrom : "",
    status: st,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.laws.push(law);
  audit(req, "law.create", { lawId: law.id, code: law.code });
  res.status(201).json({ law });
});

router.patch("/:id", authenticate, requireRole("admin"), (req, res) => {
  seedIfEmpty();
  const idx = store.laws.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Law not found" });
  const prev = store.laws[idx];
  const { code, title, summary, body, category, effectiveFrom, status } = req.body || {};
  const next = { ...prev, updatedAt: nowIso() };
  if (typeof code === "string") next.code = code.trim();
  if (typeof title === "string") next.title = title.trim();
  if (typeof summary === "string") next.summary = summary.trim();
  if (typeof body === "string") next.body = body.trim();
  if (typeof effectiveFrom === "string") next.effectiveFrom = effectiveFrom;
  if (typeof category === "string" && ALLOWED_CATEGORY.has(category)) next.category = category;
  if (typeof status === "string" && ALLOWED_STATUS.has(status)) next.status = status;
  store.laws[idx] = next;
  audit(req, "law.update", { lawId: next.id, code: next.code });
  res.json({ law: next });
});

router.delete("/:id", authenticate, requireRole("admin"), (req, res) => {
  seedIfEmpty();
  const idx = store.laws.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Law not found" });
  const [removed] = store.laws.splice(idx, 1);
  audit(req, "law.delete", { lawId: removed.id, code: removed.code });
  res.json({ ok: true });
});

export default router;
