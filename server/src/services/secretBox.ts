import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../lib/AppError.js";

// AES-256-GCM for the user's Gemini API key at rest. GCM rather than CBC so a
// tampered ciphertext fails the auth tag and throws, instead of decrypting to
// plausible garbage that would then be sent to Google as a key.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

// Decoded once at module load. env.ts has already validated that it decodes to
// exactly 32 bytes, so this cannot be the wrong size here.
const MASTER_KEY = Buffer.from(env.ENCRYPTION_KEY, "base64");

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** A fresh IV per encryption: reusing one under the same key would leak
 *  equality between two users who supplied the same API key. */
export function encryptSecret(plain: string): SealedSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, MASTER_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptSecret({ ciphertext, iv, tag }: SealedSecret): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, MASTER_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    // Almost always means ENCRYPTION_KEY changed. That is an operator problem,
    // not something the user can fix, so it is a 500 rather than a 4xx.
    console.error("[secretBox] decryption failed -- has ENCRYPTION_KEY changed?", err);
    throw new AppError(500, "decryption_failed", "Stored credentials could not be read.");
  }
}

/** Last 4 characters, for showing the user which key is stored without
 *  returning any of it that would be useful to an attacker. */
export function keyHint(plain: string): string {
  return plain.slice(-4);
}
