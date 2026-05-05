import express from "express";
import { authenticate } from "../auth.js";
import { seedIfEmpty, store } from "../store.js";

const router = express.Router();

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

router.get("/", authenticate, (_req, res) => {
  seedIfEmpty();

  const parcels = Array.from(store.parcels.values());
  const users = Array.from(store.users.values());
  const transfers = Array.from(store.transfers.values());
  const disputes = Array.from((store.disputes || new Map()).values());

  const totalProperties = parcels.length;
  const totalValue = parcels.reduce((sum, p) => sum + toNumber(p.priceGhs ?? p.price), 0);
  const activeDisputes = disputes.filter((d) => d.status !== "resolved").length;
  const pendingTransfers = transfers.filter((t) =>
    String(t.status || "")
      .toLowerCase()
      .startsWith("pending")
  ).length;
  const verifiedUsers = users.filter((u) => u.verified === true || u.niaStatus === "verified").length;

  const roleDistribution = {
    sellers: users.filter((u) => u.role === "seller").length,
    buyers: users.filter((u) => u.role === "buyer").length,
    admins: users.filter((u) => u.role === "admin" || u.role === "lands_commission").length,
    arbitrators: users.filter((u) => u.role === "arbitrator").length,
  };

  const statusDistribution = {
    active: parcels.filter((p) => p.status === "available").length,
    disputed: parcels.filter((p) => p.status === "disputed").length,
    transferPending: parcels.filter((p) =>
      ["locked_for_transaction", "pending_transfer_approval", "pending_glc_approval", "pending_multisig_approval", "pending_finalization"].includes(
        String(p.status)
      )
    ).length,
  };

  res.json({
    success: true,
    analytics: {
      totalProperties,
      totalValue,
      activeDisputes,
      pendingTransfers,
      verifiedUsers,
      roleDistribution,
      statusDistribution,
    },
  });
});

export default router;
