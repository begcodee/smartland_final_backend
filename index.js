import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { connectPostgres, closePool, getPool } from "./src/config/db.js";
import { seedIfEmpty, store } from "./src/store.js";
import {
  ensureSmartlandSchema,
  loadStoreFromPostgres,
  flushStoreToPostgres,
  startFlushScheduler,
} from "./src/db/relationalStore.js";

import authRoutes from "./src/routes/auth.js";
import parcelRoutes from "./src/routes/parcels.js";
import paymentRoutes from "./src/routes/payments.js";
import conversationRoutes from "./src/routes/conversations.js";
import niaRoutes from "./src/routes/nia.js";
import niaEmployeeRoutes from "./src/routes/niaEmployees.js";
import verifyRoutes from "./src/routes/verify.js";
import userRoutes from "./src/routes/usersCompat.js";
import notificationRoutes from "./src/routes/notifications.js";
import ratingRoutes from "./src/routes/ratings.js";
import transferRoutes from "./src/routes/transfers.js";
import lawRoutes from "./src/routes/laws.js";
import arbitrationRoutes from "./src/routes/arbitration.js";

async function bootstrap() {
  const pool = await connectPostgres();
  if (pool) {
    try {
      await ensureSmartlandSchema(pool);
    } catch (e) {
      console.error("[db] ensureSmartlandSchema failed:", e.message);
    }
    try {
      await loadStoreFromPostgres(pool, store);
      console.log("[db] Loaded application state from PostgreSQL (sl_* tables).");
    } catch (e) {
      console.warn("[db] loadStoreFromPostgres failed — starting empty:", e.message);
    }
  }

  seedIfEmpty();

  if (pool) {
    try {
      await flushStoreToPostgres(pool, store);
    } catch (e) {
      console.warn("[db] initial flush failed:", e.message);
    }
    const intervalMs = Number(process.env.DB_SNAPSHOT_INTERVAL_MS || 8000);
    startFlushScheduler(pool, store, intervalMs);
    console.log(`[db] Relational flush every ${intervalMs}ms + on shutdown.`);

    const shutdown = async () => {
      console.log("[db] Flushing relational state…");
      try {
        await flushStoreToPostgres(pool, store);
      } catch (e) {
        console.error("[db] shutdown flush:", e.message);
      }
      await closePool();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  const app = express();

  app.disable("x-powered-by");

  // Behind Render (and other reverse proxies), trust X-Forwarded-* so rate limiting and IPs are correct.
  if (process.env.RENDER || process.env.NODE_ENV === "production") {
    const hops = Number(process.env.TRUST_PROXY_HOPS || 1);
    app.set("trust proxy", Number.isFinite(hops) && hops >= 0 ? hops : 1);
  }

  app.use(
    helmet({
      crossOriginResourcePolicy: false,
    })
  );

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  app.use(limiter);

  const allowedOrigins = new Set(
    String(process.env.CORS_ORIGINS || process.env.FRONTEND_URL || "http://localhost:5173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  function isAllowedWebViewOrigin(origin) {
    try {
      const u = new URL(String(origin));
      if ((u.protocol === "capacitor:" || u.protocol === "ionic:") && u.hostname === "localhost") return true;
      return false;
    } catch {
      return false;
    }
  }

  function isAllowedDevTunnelOrigin(origin) {
    try {
      const u = new URL(String(origin));
      if (process.env.NODE_ENV === "production") return false;
      if (u.protocol === "https:" && u.hostname.endsWith(".trycloudflare.com")) return true;
      if (u.protocol === "https:" && u.hostname.endsWith(".ngrok-free.app")) return true;
      if (u.protocol === "https:" && u.hostname.endsWith(".loca.lt")) return true;
      return false;
    } catch {
      return false;
    }
  }

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (allowedOrigins.has(origin)) return cb(null, true);
        if (isAllowedWebViewOrigin(origin)) return cb(null, true);
        if (isAllowedDevTunnelOrigin(origin)) return cb(null, true);
        const o = String(origin);
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return cb(null, true);
        if (/^https?:\/\/\[::1\](:\d+)?$/i.test(o)) return cb(null, true);
        return cb(new Error("CORS blocked"), false);
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "50mb" }));

  app.use("/api/auth", authRoutes);
  app.use("/api/parcels", parcelRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/conversations", conversationRoutes);
  app.use("/api/nia", niaRoutes);
  app.use("/api/nia/employees", niaEmployeeRoutes);
  app.use("/api/verify", verifyRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/ratings", ratingRoutes);
  app.use("/api/transfers", transferRoutes);
  app.use("/api/laws", lawRoutes);
  app.use("/api/arbitration", arbitrationRoutes);

  app.get("/", (_req, res) => {
    res.send("SmartLand API running");
  });

  app.get("/health", async (_req, res) => {
    const p = getPool();
    let postgres = false;
    if (p) {
      try {
        await p.query("SELECT 1");
        postgres = true;
      } catch {
        postgres = false;
      }
    }
    res.json({
      ok: true,
      service: "smartland-backend",
      postgres,
      relationalPersistence: Boolean(p),
    });
  });

  const PORT = Number(process.env.PORT || 3001);
  const HOST = process.env.BIND_HOST || "0.0.0.0";
  app.listen(PORT, HOST, () => {
    console.log(`SmartLand API listening on http://${HOST}:${PORT} (use LAN IP from phone/emulator)`);
  });

  if (process.env.NODE_ENV !== "production") {
    setInterval(() => {}, 1 << 30);
  }
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
