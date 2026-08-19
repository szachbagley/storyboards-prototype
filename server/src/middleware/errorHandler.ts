import type { ErrorRequestHandler } from "express";
import type { ApiErrorBody } from "@storyboards/shared";
import { ZodError } from "zod";
import { AppError } from "../lib/AppError.js";

/**
 * Terminal error handler. Every non-2xx response body in the API has the
 * ApiErrorBody shape, so the client never has to guess at an error's structure.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    res.status(err.status).json(body);
    return;
  }

  // body-parser failures happen before any route runs, so without this branch a
  // malformed JSON body on any endpoint reaches the catch-all below and returns
  // 500 for what is plainly a client error. body-parser tags them with `type`.
  if (typeof err === "object" && err !== null && "type" in err) {
    const { type } = err as { type?: unknown };
    if (type === "entity.parse.failed") {
      const body: ApiErrorBody = {
        error: { code: "invalid_input", message: "Request body is not valid JSON" },
      };
      res.status(400).json(body);
      return;
    }
    if (type === "entity.too.large") {
      const body: ApiErrorBody = {
        error: { code: "payload_too_large", message: "Request body is too large" },
      };
      res.status(413).json(body);
      return;
    }
  }

  if (err instanceof ZodError) {
    const body: ApiErrorBody = {
      error: {
        code: "invalid_input",
        message: "Request validation failed",
        details: err.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
    res.status(400).json(body);
    return;
  }

  // Unexpected. Log the real error server-side and tell the client nothing
  // about it -- raw upstream messages and stack traces are not for the client.
  console.error("[error] unhandled", err);
  const body: ApiErrorBody = {
    error: { code: "internal_error", message: "Something went wrong" },
  };
  res.status(500).json(body);
};
