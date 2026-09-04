import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// scrypt rather than bcrypt or argon2: both of those are native modules that
// must compile on Railway's builder, while scrypt is built into Node.
//
// 128 * N * r = 16 MB, comfortably under Node's 32 MB default maxmem, so no
// maxmem override is needed and the call cannot fail on that guard. Measured at
// roughly 24 ms per derivation -- slow enough to matter against offline
// cracking, invisible inside a login request.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Stored as scrypt$N$r$p$salt$hash -- self-describing, so parameters can be
 *  raised later without a flag day: verification reads them back out. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plain, salt, KEY_LENGTH, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored value: a corrupt row
 * must not turn the login endpoint into a 500, which would also distinguish it
 * from an ordinary wrong password.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(plain, salt, expected.length, { N: n, r, p });
    // Equal length by construction, so timingSafeEqual cannot throw here.
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
