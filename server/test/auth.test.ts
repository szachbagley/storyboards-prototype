import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createRequireAuth } from "../src/middleware/auth.js";
import { AppError } from "../src/lib/AppError.js";

const SECRET = "correct-horse-battery-staple";

function callWith(authorization: string | undefined) {
  const requireAuth = createRequireAuth(SECRET);
  const req = { get: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined) };
  const next = vi.fn();
  requireAuth(req as unknown as Request, {} as Response, next as unknown as NextFunction);
  return next;
}

function expectRejected(authorization: string | undefined): AppError {
  try {
    callWith(authorization);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected the middleware to reject, but it called next()");
}

describe("createRequireAuth", () => {
  it("accepts the correct secret", () => {
    const next = callWith(`Bearer ${SECRET}`);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a wrong secret of the same length", () => {
    const sameLength = `${SECRET.slice(0, -1)}X`;
    expect(sameLength).toHaveLength(SECRET.length);
    expect(expectRejected(`Bearer ${sameLength}`).status).toBe(401);
  });

  it("rejects a wrong secret of a different length without throwing RangeError", () => {
    // The reason both sides are hashed to a fixed 32 bytes before comparison:
    // timingSafeEqual throws a RangeError on a length mismatch, and guarding
    // that with a length check would leak the secret's length through timing.
    const err = expectRejected("Bearer x");
    expect(err).toBeInstanceOf(AppError);
    expect(err).not.toBeInstanceOf(RangeError);
    expect(err.status).toBe(401);
  });

  it("rejects a missing or malformed Authorization header", () => {
    expect(expectRejected(undefined).status).toBe(401);
    expect(expectRejected("").status).toBe(401);
    expect(expectRejected(SECRET).status).toBe(401);
    expect(expectRejected("Basic dXNlcjpwYXNz").status).toBe(401);
    expect(expectRejected("Bearer ").status).toBe(401);
  });

  it("does not disclose whether the secret or the header was at fault", () => {
    // Both paths return the same status and code; only the message differs, and
    // neither message echoes any part of the supplied credential.
    const wrongSecret = expectRejected(`Bearer ${SECRET}-nope`);
    const noHeader = expectRejected(undefined);
    expect(wrongSecret.code).toBe("unauthorized");
    expect(noHeader.code).toBe("unauthorized");
    expect(wrongSecret.message).not.toContain(SECRET);
  });
});
