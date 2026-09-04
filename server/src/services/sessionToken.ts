import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, base64url-encoded (43 characters). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Sessions are stored as sha256(token), never the token itself, so a database
 * dump yields no live sessions -- the same reasoning as password hashing,
 * applied to a bearer credential.
 *
 * A plain hash is correct here where a KDF would be wrong: the input is 32 bytes
 * of full entropy, so there is nothing to brute force and nothing to slow down.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
