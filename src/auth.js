import jwt from "jsonwebtoken";
import { seedIfEmpty, store, publicUser } from "./store.js";

const IS_PROD = process.env.NODE_ENV === "production" || String(process.env.RENDER || "") === "true";

const JWT_SECRET = process.env.JWT_SECRET?.trim() || null;
if (!JWT_SECRET) {
  if (IS_PROD) {
    throw new Error("[auth] JWT_SECRET is required in production");
  }
  console.warn("[auth] JWT_SECRET not set; using insecure dev default");
}

const JWT_ISSUER = (process.env.JWT_ISSUER || "smartland-backend").trim();
const JWT_AUDIENCE = (process.env.JWT_AUDIENCE || "smartland").trim();
const DEV_FALLBACK_SECRET = "dev-secret-change-me";

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    JWT_SECRET || DEV_FALLBACK_SECRET,
    {
      expiresIn: "7d",
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: "HS256",
    }
  );
}

export function authenticate(req, res, next) {
  seedIfEmpty();

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET || DEV_FALLBACK_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
    });
    const user = store.users.get(payload.sub);
    if (!user) return res.status(401).json({ error: "Invalid token user" });
    if (user.role === "nia") {
      return res.status(403).json({
        error:
          "The NIA role has been retired. Ghana Card and land document verification is handled exclusively by the Ghana Lands Commission. Sign in with a lands_commission or admin account.",
      });
    }
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
      return res.status(403).json({
        error: "Forbidden",
        message: `This action requires one of: ${roles.join(", ")}. Your role: ${req.user.role}.`,
        requiredRoles: roles,
        role: req.user.role,
      });
    }
    next();
  };
}

