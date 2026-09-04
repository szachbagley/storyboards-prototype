import { Router } from "express";
import { CreateFrameSchema, CreateStorySchema, UpdateStorySchema, UuidParamSchema } from "@storyboards/shared";
import { requireUser } from "../middleware/auth.js";
import * as frames from "../services/frames.js";
import * as stories from "../services/stories.js";

export const storiesRouter: Router = Router();

storiesRouter.get("/stories", async (req, res) => {
  res.json(await stories.listStories(requireUser(req).id));
});

storiesRouter.post("/stories", async (req, res) => {
  res.status(201).json(await stories.createStory(requireUser(req).id, CreateStorySchema.parse(req.body)));
});

storiesRouter.get("/stories/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.json(await stories.getStory(id, requireUser(req).id));
});

storiesRouter.patch("/stories/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  const { title } = UpdateStorySchema.parse(req.body);
  res.json(await stories.updateStory(id, requireUser(req).id, title));
});

storiesRouter.delete("/stories/:id", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  await stories.deleteStory(id, requireUser(req).id);
  res.status(204).end();
});

storiesRouter.get("/stories/:id/frames", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.json(await frames.listStoryFrames(id, requireUser(req).id));
});

storiesRouter.post("/stories/:id/frames", async (req, res) => {
  const { id } = UuidParamSchema.parse(req.params);
  res.status(201).json(await frames.createFrame(id, requireUser(req).id, CreateFrameSchema.parse(req.body)));
});
