import express from "express";
import {
  getLands,
  getLandsByUser,
  createLand,
  transferLandOwnership,
} from "../controllers/landsController.js";

const router = express.Router();

// GET all lands
router.get("/", getLands);

// GET lands by user
router.get("/user/:userId", getLandsByUser);

// POST create land
router.post("/", createLand);

// POST transfer land ownership
router.post("/:id/transfer", transferLandOwnership);

export default router;
