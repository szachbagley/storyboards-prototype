import { Router } from "express";
import { LoginSchema, RegisterSchema, UpdateMeSchema } from "@storyboards/shared";
import { requireAuth, requireSessionTokenHash, requireUser } from "../middleware/auth.js";
import * as auth from "../services/auth.js";

/** Register and login are public; everything else needs a session. */
export const authRouter: Router = Router();

authRouter.post("/auth/register", async (req, res) => {
  res.status(201).json(await auth.register(RegisterSchema.parse(req.body)));
});

authRouter.post("/auth/login", async (req, res) => {
  res.json(await auth.login(LoginSchema.parse(req.body)));
});

authRouter.post("/auth/logout", requireAuth, async (req, res) => {
  await auth.logout(requireSessionTokenHash(req));
  res.status(204).end();
});

authRouter.get("/auth/me", requireAuth, (req, res) => {
  // toUserDto is the only shape ever returned: no key material, no password
  // hash, no lockout state.
  res.json(auth.toUserDto(requireUser(req)));
});

authRouter.patch("/auth/me", requireAuth, async (req, res) => {
  const updated = await auth.updateMe(
    requireUser(req),
    requireSessionTokenHash(req),
    UpdateMeSchema.parse(req.body),
  );
  res.json(updated);
});
