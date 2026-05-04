import { WebSocketServer } from "ws";
import { authenticate } from "../auth.js";
import { seedIfEmpty, store } from "../store.js";

/**
 * Minimal WebSocket hub for real-time messaging + notifications.
 *
 * - Auth: Bearer token via querystring `?token=...` (or `Authorization` header when supported by client)
 * - Access control: user only receives events for conversations they are a party to + their own notifications.
 * - Persistence: messages/notifications already persist in `store` (+ optional Postgres snapshots).
 */

function parseUrl(req) {
  try {
    const host = req.headers.host || "localhost";
    return new URL(req.url, `http://${host}`);
  } catch {
    return null;
  }
}

function makeFakeRes(ws) {
  return {
    status(code) {
      ws.close(4400 + Number(code || 0));
      return this;
    },
    json(obj) {
      try {
        ws.send(JSON.stringify({ type: "error", ...obj }));
      } catch {
        // ignore
      }
      return this;
    },
  };
}

function runAuth(req, ws) {
  const u = parseUrl(req);
  const token = u?.searchParams?.get("token") || null;
  if (token) req.headers.authorization = `Bearer ${token}`;
  return new Promise((resolve) => {
    authenticate(
      req,
      makeFakeRes(ws),
      () => resolve({ ok: true, user: req.user })
    );
    // authenticate will close on failure via fakeRes; resolve only on success
  });
}

export function attachRealtimeHub(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const socketsByUserId = new Map(); // userId -> Set<ws>

  function addSocket(userId, ws) {
    const key = String(userId);
    if (!socketsByUserId.has(key)) socketsByUserId.set(key, new Set());
    socketsByUserId.get(key).add(ws);
  }

  function removeSocket(userId, ws) {
    const key = String(userId);
    const set = socketsByUserId.get(key);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) socketsByUserId.delete(key);
  }

  function sendToUser(userId, payload) {
    const key = String(userId);
    const set = socketsByUserId.get(key);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const ws of Array.from(set)) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  // Expose hooks for HTTP routes to push events
  store.realtime = store.realtime || {};
  store.realtime.sendToUser = sendToUser;

  wss.on("connection", async (ws, req) => {
    seedIfEmpty();
    try {
      const auth = await runAuth(req, ws);
      if (!auth?.ok) return;
      const user = auth.user;
      addSocket(user.id, ws);

      ws.send(JSON.stringify({ type: "hello", userId: user.id, at: new Date().toISOString() }));

      ws.on("close", () => removeSocket(user.id, ws));
      ws.on("error", () => removeSocket(user.id, ws));

      // Client → server messages (optional for future); currently ignore to keep auditability in HTTP routes.
      ws.on("message", () => {});
    } catch {
      try {
        ws.close(1011);
      } catch {
        // ignore
      }
    }
  });

  return { wss, sendToUser };
}

