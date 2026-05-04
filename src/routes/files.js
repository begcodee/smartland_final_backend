import express from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { seedIfEmpty, store } from "../store.js";
import { audit } from "../services/audit.js";
import { parseDataUrl, sha256Hex, writeEncryptedFile, readDecryptedFile } from "../services/fileVault.js";

const router = express.Router();
const TTL_SECONDS = Number(process.env.FILE_TOKEN_TTL_SECONDS || 180);

function nowIso() {
  return new Date().toISOString();
}

function canAccessFile(user, fileMeta) {
  if (!user || !fileMeta) return false;
  if (fileMeta.ownerUserId === user.id) return true;

  const role = user.role;
  if (fileMeta.scope === "nia_identity") return role === "nia";
  if (fileMeta.scope === "glc_registry") return role === "admin" || role === "lands_commission";
  if (fileMeta.scope === "parcel_docs") {
    if (role === "admin" || role === "lands_commission") return true;
    if (fileMeta.parcelId) {
      const p = store.parcels.get(fileMeta.parcelId);
      if (p && p.sellerId === user.id) return true;
    }
    return false;
  }
  return false;
}

router.post("/upload", authenticate, (req, res) => {
  seedIfEmpty();
  const parsed = z
    .object({
      dataUrl: z.string().min(1),
      filename: z.string().optional(),
      scope: z.enum(["nia_identity", "parcel_docs", "glc_registry"]),
      parcelId: z.string().optional(),
    })
    .safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ message: "Invalid payload" });
  const { dataUrl, filename, scope, parcelId } = parsed.data;

  const blob = parseDataUrl(dataUrl);
  if (!blob) return res.status(400).json({ message: "Invalid dataUrl" });

  const fileId = `file_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const digest = sha256Hex(blob.bytes);
  writeEncryptedFile(fileId, blob.bytes);

  const meta = {
    id: fileId,
    ownerUserId: req.user.id,
    scope,
    parcelId: parcelId || null,
    filename: filename || "upload",
    mimeType: blob.mime,
    bytesSize: blob.bytes.length,
    sha256: digest,
    createdAt: nowIso(),
  };
  store.files.set(fileId, meta);

  audit(req, "file.uploaded", { fileId, scope, bytes: blob.bytes.length });
  res.json({ success: true, file: meta });
});

router.post("/:fileId/token", authenticate, (req, res) => {
  seedIfEmpty();
  const meta = store.files.get(String(req.params.fileId));
  if (!meta) return res.status(404).json({ message: "File not found" });
  if (!canAccessFile(req.user, meta)) return res.status(403).json({ message: "Forbidden" });

  const token = `ftok_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  store.fileTokens.set(token, { fileId: meta.id, userId: req.user.id, expMs: Date.now() + TTL_SECONDS * 1000 });
  audit(req, "file.token_issued", { fileId: meta.id, ttlSeconds: TTL_SECONDS });
  res.json({ success: true, token, expiresInSeconds: TTL_SECONDS });
});

router.get("/download/:token", authenticate, (req, res) => {
  seedIfEmpty();
  const tok = store.fileTokens.get(String(req.params.token));
  if (!tok) return res.status(404).json({ message: "Invalid token" });
  if (tok.userId !== req.user.id) return res.status(403).json({ message: "Forbidden" });
  if (Date.now() > tok.expMs) {
    store.fileTokens.delete(String(req.params.token));
    return res.status(410).json({ message: "Token expired" });
  }

  const meta = store.files.get(tok.fileId);
  if (!meta) return res.status(404).json({ message: "File not found" });
  if (!canAccessFile(req.user, meta)) return res.status(403).json({ message: "Forbidden" });

  const bytes = readDecryptedFile(meta.id);
  if (!bytes) return res.status(404).json({ message: "File missing" });

  store.fileTokens.delete(String(req.params.token)); // one-time token

  audit(req, "file.downloaded", { fileId: meta.id, scope: meta.scope });

  res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${String(meta.filename || "file").replace(/"/g, "")}"`);
  res.send(bytes);
});

export default router;

