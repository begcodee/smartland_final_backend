import express from "express";
import {
  getLands,
  getLandsByUser,
  createLand,
  transferLandOwnership,
  registerLandOnChain,
  transferLandOnChain,
} from "../controllers/landsController.js";

const router = express.Router();

// GET all lands
router.get("/", getLands);

// GET lands by user
router.get("/user/:userId", getLandsByUser);

// POST create land
router.post("/", createLand);

// Blockchain (static paths must be registered before "/:id/transfer")
router.post("/register", registerLandOnChain);
router.post("/transfer", transferLandOnChain);

// POST transfer land ownership (DB)
router.post("/:id/transfer", transferLandOwnership);

export default router;
