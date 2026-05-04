import crypto from "crypto";
import fs from "fs";
import path from "path";

function getUploadsRoot() {
  const root = process.env.UPLOADS_DIR
    ? path.resolve(String(process.env.UPLOADS_DIR))
    : path.resolve(process.cwd(), "..", "uploads");
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    // ignore
  }
  return root;
}

export function getMasterKeyOrThrow() {
  const b64 = String(process.env.FILE_MASTER_KEY_B64 || "").trim();
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error("FILE_MASTER_KEY_B64 must be set to a 32-byte base64 key (AES-256-GCM).");
  }
  return buf;
}

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function parseDataUrl(dataUrl) {
  const raw = String(dataUrl || "");
  const m = raw.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return null;
  const mime = m[1];
  const b64 = m[2];
  try {
    const bytes = Buffer.from(b64, "base64");
    return { mime, bytes };
  } catch {
    return null;
  }
}

export function encryptBytes(plaintext) {
  const key = getMasterKeyOrThrow();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext };
}

export function decryptBytes({ iv, tag, ciphertext }) {
  const key = getMasterKeyOrThrow();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function writeEncryptedFile(fileId, bytes) {
  const uploadsRoot = getUploadsRoot();
  const enc = encryptBytes(bytes);
  const p = path.join(uploadsRoot, `${fileId}.bin`);
  const payload = Buffer.concat([Buffer.from("SLF1"), enc.iv, enc.tag, enc.ciphertext]);
  fs.writeFileSync(p, payload);
  return p;
}

export function readDecryptedFile(fileId) {
  const uploadsRoot = getUploadsRoot();
  const p = path.join(uploadsRoot, `${fileId}.bin`);
  if (!fs.existsSync(p)) return null;
  const blob = fs.readFileSync(p);
  if (blob.slice(0, 4).toString("utf8") !== "SLF1") throw new Error("Bad file format");
  const iv = blob.slice(4, 16);
  const tag = blob.slice(16, 32);
  const ciphertext = blob.slice(32);
  return decryptBytes({ iv, tag, ciphertext });
}

