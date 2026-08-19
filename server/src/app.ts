import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { AppError } from "./lib/AppError.js";
import { createRequireAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { conceptsRouter } from "./routes/concepts.js";
import { framesRouter } from "./routes/frames.js";
import { generationsRouter } from "./routes/generations.js";
import { healthRouter } from "./routes/health.js";
import { storiesRouter } from "./routes/stories.js";

export function createApp(): express.Express {
  const app = express();

  // Permissive origin is safe here specifically because authentication is a
  // bearer token in a header rather than a cookie: a hostile origin cannot get
  // the browser to attach the secret on the user's behalf.
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(requestLogger);

  // Mounted before auth so the healthcheck needs no credentials.
  app.use("/api", healthRouter);

  app.use("/api", createRequireAuth(env.APP_SECRET));

  app.use("/api", conceptsRouter);
  app.use("/api", storiesRouter);
  app.use("/api", framesRouter);
  app.use("/api", generationsRouter);

  app.use((req, _res, next) => {
    next(new AppError(404, "not_found", `No route for ${req.method} ${req.path}`));
  });

  app.use(errorHandler);

  return app;
}
