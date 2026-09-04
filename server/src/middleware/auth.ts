import type { Request, RequestHandler } from "express";
import { findValidSession } from "../db/sessions.js";
import { AppError } from "../lib/AppError.js";
import { hashSessionToken } from "../services/sessionToken.js";

const BEARER_PATTERN = /^Bearer (.+)$/;

export interface AuthUser {
  id: string;
  username: string;
  geminiKeyCiphertext: Buffer | null;
  geminiKeyIv: Buffer | null;
  geminiKeyTag: Buffer | null;
  geminiKeyHint: string | null;
  createdAt: Date;
}

/**
 * Session authentication, replacing the single shared secret.
 *
 * The token is hashed before lookup because sessions are stored as sha256 --
 * see services/sessionToken.ts. Expiry is enforced in the query, so an expired
 * session simply does not resolve.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const match = BEARER_PATTERN.exec(req.get("authorization") ?? "");
  if (!match?.[1]) {
    next(new AppError(401, "unauthorized", "Missing or malformed bearer token"));
    return;
  }

  const tokenHash = hashSessionToken(match[1]);
  findValidSession(tokenHash)
    .then((session) => {
      if (!session) {
        next(new AppError(401, "unauthorized", "Your session is no longer valid. Sign in again."));
        return;
      }
      req.user = {
        id: session.userId,
        username: session.username,
        geminiKeyCiphertext: session.geminiKeyCiphertext,
        geminiKeyIv: session.geminiKeyIv,
        geminiKeyTag: session.geminiKeyTag,
        geminiKeyHint: session.geminiKeyHint,
        createdAt: session.createdAt,
      };
      req.sessionTokenHash = tokenHash;
      next();
    })
    .catch(next);
};

/** Narrows req.user for handlers behind requireAuth, so `req.user!` never
 *  appears in a route. Throwing here would mean the middleware was skipped. */
export function requireUser(req: Request): AuthUser {
  if (!req.user) throw new AppError(401, "unauthorized", "Authentication required");
  return req.user;
}

export function requireSessionTokenHash(req: Request): string {
  if (!req.sessionTokenHash) throw new AppError(401, "unauthorized", "Authentication required");
  return req.sessionTokenHash;
}
