import { randomBytes } from "node:crypto";
import {
  LOGIN_LOCKOUT_MINUTES,
  MAX_LOGIN_ATTEMPTS,
  SESSION_TTL_DAYS,
  type AuthResponse,
  type LoginBody,
  type RegisterBody,
  type UpdateMeBody,
  type UserDto,
} from "@storyboards/shared";
import * as sessionsDb from "../db/sessions.js";
import * as usersDb from "../db/users.js";
import type { UserRow } from "../db/users.js";
import { withTransaction } from "../db/pool.js";
import { env } from "../config/env.js";
import { AppError } from "../lib/AppError.js";
import type { AuthUser } from "../middleware/auth.js";
import { validateApiKey } from "./gemini.js";
import { hashPassword, verifyPassword } from "./password.js";
import { encryptSecret, keyHint } from "./secretBox.js";
import { generateSessionToken, hashSessionToken } from "./sessionToken.js";

export function toUserDto(user: UserRow | AuthUser): UserDto {
  return {
    id: user.id,
    username: user.username,
    hasGeminiKey: user.geminiKeyCiphertext !== null,
    geminiKeyHint: user.geminiKeyHint,
    createdAt: user.createdAt.toISOString(),
  };
}

function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Same message for an unknown username, a wrong password and a locked account:
 *  distinguishing them tells an attacker which usernames exist. */
function invalidCredentials(): AppError {
  return new AppError(401, "invalid_credentials", "Invalid username or password");
}

export async function register(body: RegisterBody): Promise<AuthResponse> {
  // Optional gate. Unset means open registration, which is the default.
  if (env.SIGNUP_CODE && body.signupCode !== env.SIGNUP_CODE) {
    throw new AppError(403, "signup_code_required", "A valid invite code is required to register.");
  }

  if (await usersDb.findUserByUsername(body.username)) {
    throw new AppError(409, "username_taken", "That username is already taken.");
  }

  // Validate the key BEFORE creating anything, so a typo is caught in the
  // registration form rather than on the user's first generation.
  if (!(await validateApiKey(body.geminiApiKey))) {
    throw new AppError(
      422,
      "invalid_api_key",
      "That Gemini API key was rejected. Check it and try again.",
    );
  }

  const passwordHash = await hashPassword(body.password);
  const sealed = encryptSecret(body.geminiApiKey);
  const token = generateSessionToken();

  // One transaction: a failure anywhere leaves no half-made account.
  const user = await withTransaction(async (client) => {
    const created = await usersDb.insertUser(client, {
      username: body.username,
      passwordHash,
      geminiKeyCiphertext: sealed.ciphertext,
      geminiKeyIv: sealed.iv,
      geminiKeyTag: sealed.tag,
      geminiKeyHint: keyHint(body.geminiApiKey),
    });
    await sessionsDb.insertSession(client, created.id, hashSessionToken(token), sessionExpiry());
    return created;
  });

  return { token, user: toUserDto(user) };
}

/**
 * A throwaway hash, derived once at startup, used to keep the timing of a
 * failed login roughly constant.
 *
 * Without it an unknown username returns immediately while a known one costs a
 * scrypt derivation (~24ms). The generic error message hides *which* check
 * failed, but the timing difference would still leak which usernames exist.
 */
const DUMMY_HASH = hashPassword(randomBytes(32).toString("hex"));

export async function login(body: LoginBody): Promise<AuthResponse> {
  const user = await usersDb.findUserByUsername(body.username);
  if (!user) {
    // Burn a comparable amount of time before failing, so an unknown username
    // is not distinguishable from a wrong password by how fast it returns.
    await verifyPassword(body.password, await DUMMY_HASH);
    throw invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw invalidCredentials();
  }

  if (!(await verifyPassword(body.password, user.passwordHash))) {
    await usersDb.recordFailedAttempt(user.id, MAX_LOGIN_ATTEMPTS, LOGIN_LOCKOUT_MINUTES);
    throw invalidCredentials();
  }

  const token = generateSessionToken();
  await usersDb.resetFailedAttempts(user.id);
  await sessionsDb.deleteExpiredSessions();
  await withTransaction((client) =>
    sessionsDb.insertSession(client, user.id, hashSessionToken(token), sessionExpiry()),
  );

  return { token, user: toUserDto(user) };
}

export async function logout(tokenHash: string): Promise<void> {
  await sessionsDb.deleteSession(tokenHash);
}

export async function updateMe(
  user: AuthUser,
  currentTokenHash: string,
  body: UpdateMeBody,
): Promise<UserDto> {
  if (body.geminiApiKey !== undefined) {
    if (!(await validateApiKey(body.geminiApiKey))) {
      throw new AppError(
        422,
        "invalid_api_key",
        "That Gemini API key was rejected. Check it and try again.",
      );
    }
    const sealed = encryptSecret(body.geminiApiKey);
    await usersDb.updateGeminiKey(user.id, {
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      tag: sealed.tag,
      hint: keyHint(body.geminiApiKey),
    });
  }

  if (body.password !== undefined) {
    await usersDb.updatePassword(user.id, await hashPassword(body.password));
    // Changing a password must invalidate sessions elsewhere, or the change
    // does not actually lock anyone out. The current session survives so the
    // user is not signed out of the tab they just used.
    const revoked = await sessionsDb.deleteOtherSessionsForUser(user.id, currentTokenHash);
    if (revoked > 0) console.log(`[auth] revoked ${revoked} other session(s) after password change`);
  }

  const refreshed = await usersDb.findUserById(user.id);
  if (!refreshed) throw new AppError(404, "not_found", "Account no longer exists");
  return toUserDto(refreshed);
}
