import express from "express";

const router = express.Router();

// GET all users
router.get("/", (req, res) => {
  res.json({ message: "Get all users" });
});

// GET user by ID
router.get("/:id", (req, res) => {
  res.json({ message: `Get user ${req.params.id}` });
});

// POST create user
router.post("/", (req, res) => {
  res.json({ message: "Create user", data: req.body });
});

// PUT update user
router.put("/:id", (req, res) => {
  res.json({ message: `Update user ${req.params.id}`, data: req.body });
});

// DELETE user
router.delete("/:id", (req, res) => {
  res.json({ message: `Delete user ${req.params.id}` });
});

export default router;
