import type { RequestHandler } from "express";

export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = performance.now();
  res.on("finish", () => {
    const ms = Math.round(performance.now() - startedAt);
    console.log(`[http] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
};
