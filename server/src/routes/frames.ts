import { Router } from "express";
import { SelectGenerationSchema, UpdateFrameSchema, UuidParamSchema } from "@storyboards/shared";
import { requireUser } from "../middleware/auth.js";
import * as frames from "../services/frames.js";
import * as generation from "../services/generation.js";

export const framesRouter: Router = Router();

framesRouter.get("/frames/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.json(await frames.getFrame(id, requireUser(req).id));
});

framesRouter.patch("/frames/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.json(await frames.updateFrame(id, requireUser(req).id, UpdateFrameSchema.parse(req.body)));
});

// Returns 202 immediately; the model call runs in the background and the
// client polls GET /generations/:id. The whole user is passed, not just the id,
// because the generation is billed to their own Gemini key.
framesRouter.post("/frames/:id/generate", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.status(202).json({ generationId: await generation.startGeneration(id, requireUser(req)) });
});

framesRouter.post("/frames/:id/select-generation", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  const { generationId } = SelectGenerationSchema.parse(req.body);
  const userId = requireUser(req).id;
  await generation.selectGeneration(id, generationId, userId);
  res.json(await frames.getFrame(id, userId));
});

framesRouter.delete("/frames/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  await frames.deleteFrame(id, requireUser(req).id);
  res.status(204).end();
});
