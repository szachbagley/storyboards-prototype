import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/AppError.js";
import { hashPassword, verifyPassword } from "../src/services/password.js";
import { encryptSecret, decryptSecret, keyHint } from "../src/services/secretBox.js";
import { generateSessionToken, hashSessionToken } from "../src/services/sessionToken.js";

/**
 * Credential handling: the fifth sanctioned test area (identity-plan.md 6.1).
 *
 * These are pure functions with no I/O, and they fail SILENTLY and
 * catastrophically when wrong -- a verify that returns true unconditionally, or
 * an encrypt that round-trips the wrong value, produces no error anywhere. That
 * is the same standard the existing sanctioned areas were chosen by.
 */

const PASSWORD = "correct horse battery staple";

describe("password hashing", () => {
  it("round-trips a correct password", async () => {
    const stored = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword(PASSWORD);
    await expect(verifyPassword("wrong horse battery staple", stored)).resolves.toBe(false);
  });

  it("rejects a password that is a prefix of the real one", async () => {
    const stored = await hashPassword(PASSWORD);
    await expect(verifyPassword("correct horse", stored)).resolves.toBe(false);
  });

  it("produces a different hash each time for the same password", async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    // A shared hash would mean a missing or constant salt, which makes the
    // whole table crackable at once.
    expect(a).not.toBe(b);
    await expect(verifyPassword(PASSWORD, a)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, b)).resolves.toBe(true);
  });

  it("stores parameters in a self-describing format", async () => {
    const stored = await hashPassword(PASSWORD);
    const parts = stored.split("$");
    expect(parts[0]).toBe("scrypt");
    expect(parts).toHaveLength(6);
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16384);
  });

  it("never stores the plaintext", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain("correct");
  });

  it.each([
    ["empty", ""],
    ["not scrypt", "bcrypt$1$2$3$4$5"],
    ["too few fields", "scrypt$16384$8$1$onlysalt"],
    ["non-numeric params", "scrypt$abc$8$1$c2FsdA==$aGFzaA=="],
    ["empty salt and hash", "scrypt$16384$8$1$$"],
  ])("returns false rather than throwing for a malformed stored hash (%s)", async (_label, stored) => {
    // A corrupt row must not turn login into a 500, which would also make it
    // distinguishable from an ordinary wrong password.
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false);
  });
});

describe("session tokens", () => {
  it("is 43 base64url characters from 32 random bytes", () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(tokens.size).toBe(200);
  });

  it("hashes deterministically", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("stores something that is not the token", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    // The point of hashing: a database dump must not yield usable tokens.
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives different hashes for different tokens", () => {
    expect(hashSessionToken(generateSessionToken())).not.toBe(hashSessionToken(generateSessionToken()));
  });
});

describe("Gemini key encryption", () => {
  // A synthetic value shaped like a Gemini key. Never use a real credential as
  // a test fixture: it would be committed, and secret scanners are right to
  // block it.
  const KEY = "AQ.NotARealKeyOnlyForTestsAAAAAAAAAAAAAAAAAAAAAAAAbcd";

  it("round-trips exactly", () => {
    expect(decryptSecret(encryptSecret(KEY))).toBe(KEY);
  });

  it("produces different ciphertext each time for the same key", () => {
    const a = encryptSecret(KEY);
    const b = encryptSecret(KEY);
    // A reused IV would leak that two users supplied the same API key.
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(decryptSecret(a)).toBe(KEY);
    expect(decryptSecret(b)).toBe(KEY);
  });

  it("never stores the plaintext in the ciphertext", () => {
    const sealed = encryptSecret(KEY);
    expect(sealed.ciphertext.toString("utf8")).not.toContain("AQ.");
    expect(sealed.ciphertext.toString("latin1")).not.toContain(KEY);
  });

  it("throws on tampered ciphertext rather than returning plaintext", () => {
    const sealed = encryptSecret(KEY);
    sealed.ciphertext[0] ^= 1;
    expect(() => decryptSecret(sealed)).toThrow(AppError);
  });

  it("throws on a tampered auth tag", () => {
    const sealed = encryptSecret(KEY);
    sealed.tag[0] ^= 1;
    expect(() => decryptSecret(sealed)).toThrow(AppError);
  });

  it("handles a key containing base64url punctuation", () => {
    const awkward = "AQ.a-b_c=d+e/f";
    expect(decryptSecret(encryptSecret(awkward))).toBe(awkward);
  });
});

describe("keyHint", () => {
  it("returns only the last four characters", () => {
    expect(keyHint("AQ.NotARealKeyOnlyForTestsAAAAAAAAAAAAAAAAAAAAAAAAbcd")).toBe("Abcd");
  });

  it("cannot be used to reconstruct the key", () => {
    const key = "AQ.SuperSecretGeminiKeyValue1234";
    const hint = keyHint(key);
    expect(hint).toHaveLength(4);
    expect(key.startsWith(hint)).toBe(false);
    expect(hint).not.toContain("Secret");
  });
});
