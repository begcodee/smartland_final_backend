import express from "express";
import { authenticate, requireRole } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";
import { z } from "zod";
import { audit } from "../services/audit.js";
import { createNotification } from "./notifications.js";
import { anchorSaleOnChain } from "../services/chainAnchor.js";
import { requiredApprovalsForTransfer } from "../services/multisigPolicy.js";
import { ethers } from "ethers";
import {
  executeTransferOnChain,
  signTransferApproval,
  buildTransferTypedData,
  getRegistryContract,
  parcelIdToBytes32,
  transferIdToBytes32,
  metadataToBytes32,
} from "../services/chainRegistry.js";

const router = express.Router();

function safeTransfer(t, viewerUserId) {
  const parcel = store.parcels.get(t.parcelId) || null;
  const seller = store.users.get(t.sellerId) || null;
  const buyer = store.users.get(t.buyerId) || null;

  const counterpartyId =
    String(viewerUserId) === String(t.sellerId) ? String(t.buyerId) : String(t.sellerId);

  const alreadyRated = store.ratings.some(
    (r) =>
      r.fromUserId === String(viewerUserId) &&
      r.toUserId === counterpartyId &&
      r.context?.type === "transfer" &&
      String(r.context?.transferId) === String(t.id)
  );

  return {
    id: t.id,
    parcelId: t.parcelId,
    paystackReference: t.paystackReference || null,
    status: t.status || "completed",
    createdAt: t.createdAt || null,
    sellerId: t.sellerId,
    buyerId: t.buyerId,
    parcel: parcel ? { id: parcel.id, title: parcel.title, location: parcel.location } : null,
    seller: seller ? publicUser(seller, { id: viewerUserId, role: store.users.get(String(viewerUserId))?.role || "public" }) : null,
    buyer: buyer ? publicUser(buyer, { id: viewerUserId, role: store.users.get(String(viewerUserId))?.role || "public" }) : null,
    rating: {
      counterpartyId,
      alreadyRated,
      canRate: !alreadyRated,
    },
  };
}

router.get("/", authenticate, (req, res) => {
  seedIfEmpty();
  const me = String(req.user.id);

  const transfers = Array.from(store.transfers.values())
    .filter((t) => String(t.sellerId) === me || String(t.buyerId) === me)
    .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1))
    .map((t) => safeTransfer(t, me));

  res.json({ success: true, transfers });
});

function ensureApprovals(transfer, parcel) {
  transfer.approvals = transfer.approvals || {};
  transfer.approvalPolicy = transfer.approvalPolicy || requiredApprovalsForTransfer(transfer, parcel);
  return transfer.approvalPolicy;
}

function approvalsSatisfied(transfer) {
  const pol = transfer.approvalPolicy || { roles: [], threshold: 1 };
  const approvals = transfer.approvals || {};
  const count = (pol.roles || []).filter((r) => approvals[r]?.status === "approved").length;
  return count >= Number(pol.threshold || 1);
}

async function finalizeIfReady({ req, transfer, parcel }) {
  if (!approvalsSatisfied(transfer)) return { finalized: false };

  // Finalize parcel state
  transfer.status = "completed";
  transfer.completedAt = new Date().toISOString();
  parcel.status = "sold";
  parcel.lockedUntil = null;
  parcel.transfers = (parcel.transfers || []).map((t) => (t.id === transfer.id ? transfer : t));

  // On-chain finalize (preferred): execute registry transfer with multisig signatures.
  // Fallback: anchor-only (v1) if registry env/signatures are missing.
  try {
    const storedApprovals = [];
    for (const [role, entry] of Object.entries(transfer.approvals || {})) {
      if (entry?.signature) storedApprovals.push({ role, signer: entry.signer, signature: entry.signature });
    }

    const buyer = store.users.get(transfer.buyerId) || null;
    const seller = store.users.get(transfer.sellerId) || null;

    const onchain = await executeTransferOnChain({
      transfer,
      parcel,
      approvals: storedApprovals,
      buyerAddress: buyer?.walletAddress || buyer?.evmAddress || null,
      sellerAddress: seller?.walletAddress || seller?.evmAddress || null,
    });

    if (!onchain.skipped) {
      transfer.chainTxHash = onchain.chainTxHash;
      transfer.chainNetwork = onchain.chainNetwork;
      transfer.chainTransferId = onchain.chainTransferId;
      transfer.chainParcelId = onchain.chainParcelId;
      transfer.chainNonce = onchain.chainNonce;
      transfer.chainMetadataHash = onchain.chainMetadataHash;
      transfer.chainSignatures = onchain.signatures;
      store.transfers.set(transfer.id, transfer);
      parcel.transfers = (parcel.transfers || []).map((t) => (t.id === transfer.id ? transfer : t));
    } else {
      const anchored = await anchorSaleOnChain({
        transfer,
        parcelId: parcel.id,
        paystackReference: transfer.paystackReference,
      });
      if (anchored && !anchored.skipped) {
        Object.assign(transfer, anchored);
        store.transfers.set(transfer.id, transfer);
        parcel.transfers = (parcel.transfers || []).map((t) => (t.id === transfer.id ? transfer : t));
      }
      transfer.chainMode = "anchor_only";
      transfer.chainSkipReason = onchain.reason || anchored?.reason || "unknown";
    }
  } catch (e) {
    transfer.chainAnchorError = String(e?.message || e);
  }

  const buyer = store.users.get(transfer.buyerId) || null;
  const seller = store.users.get(transfer.sellerId) || null;
  if (buyer) {
    createNotification({
      userId: buyer.id,
      type: "success",
      category: "transaction",
      title: "Transfer completed",
      message: `Your transfer for “${parcel.title}” is complete. Transfer ID: ${transfer.id}.`,
      actionUrl: "/buyer",
    });
  }
  if (seller) {
    createNotification({
      userId: seller.id,
      type: "success",
      category: "transaction",
      title: "Transfer completed",
      message: `The sale of “${parcel.title}” is complete. Transfer ID: ${transfer.id}.`,
      actionUrl: "/seller",
    });
  }
  audit(req, "transfer.completed", { transferId: transfer.id, parcelId: parcel.id });
  return { finalized: true };
}

// Approval by Lands Commission (part 1 of multisig threshold)
router.patch("/:id/approve", authenticate, requireRole("lands_commission", "admin"), async (req, res) => {
  seedIfEmpty();
  const transfer = store.transfers.get(String(req.params.id));
  if (!transfer) return res.status(404).json({ error: "Transfer not found" });
  if (transfer.status !== "pending_glc_approval") {
    return res.status(400).json({ error: "Transfer is not pending approval" });
  }

  const parsed = z
    .object({
      note: z.string().trim().max(2000).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const parcel = store.parcels.get(String(transfer.parcelId)) || null;
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  const pol = ensureApprovals(transfer, parcel);
  transfer.approvals["lands_commission"] = transfer.approvals["lands_commission"] || {};
  Object.assign(transfer.approvals["lands_commission"], {
    status: "approved",
    byUserId: req.user.id,
    at: new Date().toISOString(),
    note: parsed.data.note || "",
  });

  // Optional: produce an EIP-712 signature if an approver key is available (demo/dev).
  // In production, approvals should be signed client-side with hardware-backed keys and submitted to backend.
  try {
    const pk = process.env.CHAIN_APPROVER_PRIVATE_KEY_LC?.trim();
    if (pk) {
      const ctx = await getRegistryContract();
      if (ctx) {
        const network = await ctx.provider.getNetwork();
        const buyer = store.users.get(transfer.buyerId) || null;
        const seller = store.users.get(transfer.sellerId) || null;
        const typed = await buildTransferTypedData({
          chainId: Number(network.chainId),
          verifyingContract: await ctx.contract.getAddress(),
          transfer: {
            transferId: transferIdToBytes32(transfer.id),
            parcelId: parcelIdToBytes32(parcel.id),
            from: ethers.getAddress(String(seller?.walletAddress || seller?.evmAddress || ethers.ZeroAddress)),
            to: ethers.getAddress(String(buyer?.walletAddress || buyer?.evmAddress || ethers.ZeroAddress)),
            nonce: BigInt(await ctx.contract.parcelNonce(parcelIdToBytes32(parcel.id))),
            deadline: Math.floor(Date.now() / 1000) + 15 * 60,
            metadataHash: metadataToBytes32(JSON.stringify({ parcelId: parcel.id, transferId: transfer.id })),
          },
        });
        const sig = await signTransferApproval({ role: "lands_commission", privateKey: pk, typedData: typed });
        transfer.approvals["lands_commission"].signature = sig.signature;
        transfer.approvals["lands_commission"].signer = sig.signer;
      }
    }
  } catch {
    // ignore
  }
  transfer.status = approvalsSatisfied(transfer) ? "pending_finalization" : "pending_multisig_approval";

  createNotification({
    userId: transfer.buyerId,
    type: "info",
    category: "transaction",
    title: "Registry approval recorded",
    message: `Lands Commission approval recorded for transfer ${transfer.id}. Waiting for ${pol.threshold} approval(s) total.`,
    actionUrl: "/buyer",
  });

  audit(req, "transfer.approval.lands_commission", { transferId: transfer.id, parcelId: parcel.id, policy: pol });
  await finalizeIfReady({ req, transfer, parcel });
  res.json({ success: true, transfer: safeTransfer(transfer, req.user.id) });
});

// Neutral party approval (arbitrator) — part 2 of multisig threshold
router.patch("/:id/arbitrator-approve", authenticate, requireRole("arbitrator"), async (req, res) => {
  seedIfEmpty();
  const transfer = store.transfers.get(String(req.params.id));
  if (!transfer) return res.status(404).json({ error: "Transfer not found" });
  if (transfer.status !== "pending_glc_approval" && transfer.status !== "pending_multisig_approval" && transfer.status !== "pending_finalization") {
    return res.status(400).json({ error: "Transfer is not pending multisig approval" });
  }

  const parsed = z
    .object({ note: z.string().trim().max(2000).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const parcel = store.parcels.get(String(transfer.parcelId)) || null;
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  const pol = ensureApprovals(transfer, parcel);
  transfer.approvals["arbitrator"] = transfer.approvals["arbitrator"] || {};
  Object.assign(transfer.approvals["arbitrator"], {
    status: "approved",
    byUserId: req.user.id,
    at: new Date().toISOString(),
    note: parsed.data.note || "",
  });

  try {
    const pk = process.env.CHAIN_APPROVER_PRIVATE_KEY_ARBITRATOR?.trim();
    if (pk) {
      const ctx = await getRegistryContract();
      if (ctx) {
        const network = await ctx.provider.getNetwork();
        const buyer = store.users.get(transfer.buyerId) || null;
        const seller = store.users.get(transfer.sellerId) || null;
        const typed = await buildTransferTypedData({
          chainId: Number(network.chainId),
          verifyingContract: await ctx.contract.getAddress(),
          transfer: {
            transferId: transferIdToBytes32(transfer.id),
            parcelId: parcelIdToBytes32(parcel.id),
            from: ethers.getAddress(String(seller?.walletAddress || seller?.evmAddress || ethers.ZeroAddress)),
            to: ethers.getAddress(String(buyer?.walletAddress || buyer?.evmAddress || ethers.ZeroAddress)),
            nonce: BigInt(await ctx.contract.parcelNonce(parcelIdToBytes32(parcel.id))),
            deadline: Math.floor(Date.now() / 1000) + 15 * 60,
            metadataHash: metadataToBytes32(JSON.stringify({ parcelId: parcel.id, transferId: transfer.id })),
          },
        });
        const sig = await signTransferApproval({ role: "arbitrator", privateKey: pk, typedData: typed });
        transfer.approvals["arbitrator"].signature = sig.signature;
        transfer.approvals["arbitrator"].signer = sig.signer;
      }
    }
  } catch {
    // ignore
  }
  transfer.status = approvalsSatisfied(transfer) ? "pending_finalization" : "pending_multisig_approval";

  audit(req, "transfer.approval.arbitrator", { transferId: transfer.id, parcelId: parcel.id, policy: pol });
  await finalizeIfReady({ req, transfer, parcel });
  res.json({ success: true, transfer: safeTransfer(transfer, req.user.id) });
});

// Reject a transfer: keep parcel unsold + mark refund/dispute required
router.patch("/:id/reject", authenticate, requireRole("lands_commission", "admin", "arbitrator"), (req, res) => {
  seedIfEmpty();
  const transfer = store.transfers.get(String(req.params.id));
  if (!transfer) return res.status(404).json({ error: "Transfer not found" });

  const parsed = z
    .object({
      reason: z.string().trim().min(1).max(2000),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const parcel = store.parcels.get(String(transfer.parcelId)) || null;
  if (!parcel) return res.status(404).json({ error: "Parcel not found" });

  if (transfer.status === "completed") return res.status(400).json({ error: "Transfer already completed" });

  transfer.status = "rejected";
  transfer.rejectedBy = req.user.id;
  transfer.rejectedAt = new Date().toISOString();
  transfer.rejectionReason = parsed.data.reason;

  // Release parcel back to market unless it is already flagged/disputed.
  if (parcel.status === "pending_transfer_approval") {
    parcel.status = parcel.registryClearance === "flagged" ? "disputed" : "available";
    parcel.lockedUntil = null;
  }
  parcel.transfers = (parcel.transfers || []).map((t) => (t.id === transfer.id ? transfer : t));

  const buyer = store.users.get(transfer.buyerId) || null;
  const seller = store.users.get(transfer.sellerId) || null;
  if (buyer) {
    createNotification({
      userId: buyer.id,
      type: "error",
      category: "transaction",
      title: "Transfer rejected",
      message: `Your transfer for “${parcel.title}” was rejected. Reason: ${transfer.rejectionReason}. Funds require manual refund handling.`,
      actionUrl: "/buyer",
    });
  }
  if (seller) {
    createNotification({
      userId: seller.id,
      type: "error",
      category: "transaction",
      title: "Transfer rejected",
      message: `The transfer for “${parcel.title}” was rejected. Reason: ${transfer.rejectionReason}.`,
      actionUrl: "/seller",
    });
  }

  audit(req, "transfer.rejected", { transferId: transfer.id, parcelId: parcel.id, reason: transfer.rejectionReason });
  res.json({ success: true, transfer: safeTransfer(transfer, req.user.id) });
});

export default router;

