import express from "express";
import { createUser, getUsers } from "../controllers/userControllers.js";

const router = express.Router();

// GET all users
router.get("/", getUsers);

// POST create user
router.post("/", createUser);

export default router;