import express from "express";
import { authenticate } from "../auth.js";
import { seedIfEmpty, store, publicUser } from "../store.js";

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

export default router;

