import jwt from "jsonwebtoken";
import { seedIfEmpty, store, publicUser } from "./store.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
if (!process.env.JWT_SECRET) {
  console.warn("[auth] JWT_SECRET not set; using insecure dev default");
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

export function authenticate(req, res, next) {
  seedIfEmpty();

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = store.users.get(payload.sub);
    if (!user) return res.status(401).json({ error: "Invalid token user" });
    // Self view: keep full identity for accountability
    req.user = publicUser(user, { id: user.id, role: user.role });
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

