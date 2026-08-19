import { Router } from "express";
import { SelectGenerationSchema, UpdateFrameSchema, UuidParamSchema } from "@storyboards/shared";
import * as frames from "../services/frames.js";
import * as generation from "../services/generation.js";

export const framesRouter: Router = Router();

framesRouter.get("/frames/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.json(await frames.getFrame(id));
});

framesRouter.patch("/frames/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.json(await frames.updateFrame(id, UpdateFrameSchema.parse(req.body)));
});

// Returns 202 immediately; the model call runs in the background and the
// client polls GET /generations/:id.
framesRouter.post("/frames/:id/generate", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.status(202).json({ generationId: await generation.startGeneration(id) });
});

framesRouter.post("/frames/:id/select-generation", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  const { generationId } = SelectGenerationSchema.parse(req.body);
  await generation.selectGeneration(id, generationId);
  res.json(await frames.getFrame(id));
});

framesRouter.delete("/frames/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  await frames.deleteFrame(id);
  res.status(204).end();
});
