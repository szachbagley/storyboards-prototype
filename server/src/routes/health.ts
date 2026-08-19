import { Router } from "express";
import { query } from "../db/pool.js";

export const healthRouter: Router = Router();

// Unauthenticated on purpose: this is the Railway healthcheck target.
healthRouter.get("/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, db: "up" });
  } catch (err) {
    console.error("[health] database check failed", err);
    res.status(503).json({ ok: false, db: "down" });
  }
});
