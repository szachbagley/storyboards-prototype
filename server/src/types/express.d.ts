import type { AuthUser } from "../middleware/auth.js";

// Lets handlers read req.user under strict mode without casts.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionTokenHash?: string;
    }
  }
}

export {};
