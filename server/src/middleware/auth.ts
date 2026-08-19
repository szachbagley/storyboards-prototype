import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { AppError } from "../lib/AppError.js";

const BEARER_PATTERN = /^Bearer (.+)$/;

/**
 * Single shared secret authentication (TECH_SPEC.md section 10).
 *
 * Takes the expected secret as an argument rather than reading the environment
 * directly, so this module stays free of side effects and is testable without
 * a configured environment.
 */
export function createRequireAuth(secret: string): RequestHandler {
  const expectedDigest = createHash("sha256").update(secret).digest();

  return function requireAuth(req, _res, next) {
    const match = BEARER_PATTERN.exec(req.get("authorization") ?? "");
    if (!match?.[1]) {
      throw new AppError(401, "unauthorized", "Missing or malformed bearer token");
    }

    // Compare fixed-width digests rather than the raw secrets. timingSafeEqual
    // throws on a length mismatch, and guarding that with a length check would
    // itself leak the length of the secret through timing.
    const providedDigest = createHash("sha256").update(match[1]).digest();
    if (!timingSafeEqual(providedDigest, expectedDigest)) {
      throw new AppError(401, "unauthorized", "Invalid credentials");
    }

    next();
  };
}
