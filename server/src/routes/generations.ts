import { Router } from "express";
import { UuidParamSchema } from "@storyboards/shared";
import * as generation from "../services/generation.js";

export const generationsRouter: Router = Router();

// Poll target. The client polls this every POLL_INTERVAL_MS while a generation
// is pending; the Gemini call itself is never proxied to the browser.
generationsRouter.get("/generations/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.json(await generation.getGeneration(id));
});
