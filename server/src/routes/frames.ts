import { Router } from "express";
import { CreateFrameSchema, DeleteFrameQuerySchema, GenerateFrameSchema, SelectGenerationSchema, UpdateFrameSchema, UuidParamSchema } from "@storyboards/shared";
import { requireUser } from "../middleware/auth.js";
import * as frames from "../services/frames.js";
import * as generation from "../services/generation.js";

export function createFramesRouter(continuityEnabled: boolean): Router {
  const framesRouter = Router();

  framesRouter.post("/stories/:id/frames", async (req, res) => {
    const { id } = UuidParamSchema.parse(req.params);
    const body = CreateFrameSchema.parse(req.body);
    res.status(201).json(await frames.createFrame(id, requireUser(req).id, body, continuityEnabled));
  });

  framesRouter.get("/frames/:id", async (req, res) => {
    const { id } = UuidParamSchema.parse(req.params);
    res.json(await frames.getFrame(id, requireUser(req).id, continuityEnabled));
  });

  framesRouter.patch("/frames/:id", async (req, res) => {
    const { id } = UuidParamSchema.parse(req.params);
    res.json(await frames.updateFrame(id, requireUser(req).id, UpdateFrameSchema.parse(req.body), continuityEnabled));
  });

  framesRouter.get("/frames/:id/generation-requests/:requestId", async (req, res) => {
    const { id } = UuidParamSchema.parse(req.params);
    const { id: requestId } = UuidParamSchema.parse({ id: req.params.requestId });
    res.json({ generationId: await generation.lookupRequest(id, requestId, requireUser(req).id) });
  });

  // Returns 202 immediately; the model call runs in the background and the
  // client polls GET /generations/:id. The whole user is passed, not just the id,
  // because the generation is billed to their own Gemini key.
  framesRouter.post("/frames/:id/generate", async (req, res) => {
    const { id } = UuidParamSchema.parse(req.params);
    const body = GenerateFrameSchema.parse(req.body === undefined ? {} : req.body);
    res.status(202).json({ generationId: await generation.startGeneration(id, requireUser(req), body, continuityEnabled) });
  });

  framesRouter.post("/frames/:id/select-generation", async (req, res) => {
    const { id } = UuidParamSchema.parse(req.params);
    const { generationId } = SelectGenerationSchema.parse(req.body);
    const userId = requireUser(req).id;
    await generation.selectGeneration(id, generationId, userId);
    res.json(await frames.getFrame(id, userId, continuityEnabled));
  });

  framesRouter.delete("/frames/:id", async (req, res) => {
    const { id } = UuidParamSchema.parse(req.params);
    await frames.deleteFrame(id, requireUser(req).id, DeleteFrameQuerySchema.parse(req.query));
    res.status(204).end();
  });
  return framesRouter;
}
