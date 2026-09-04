import type pg from "pg";
import { query } from "./pool.js";

export interface SessionUserRow {
  sessionId: string;
  userId: string;
  username: string;
  geminiKeyCiphertext: Buffer | null;
  geminiKeyIv: Buffer | null;
  geminiKeyTag: Buffer | null;
  geminiKeyHint: string | null;
  createdAt: Date;
}

export async function insertSession(
  client: pg.PoolClient,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await client.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, tokenHash, expiresAt],
  );
}

/**
 * Resolve a bearer token to its user in one query.
 *
 * The expiry check lives in SQL rather than in JavaScript so an expired session
 * simply does not come back -- there is no window where application code holds
 * a stale session and has to remember to reject it.
 */
export async function findValidSession(tokenHash: string): Promise<SessionUserRow | null> {
  const { rows } = await query<SessionUserRow>(
    `SELECT s.id      AS "sessionId",
            u.id      AS "userId",
            u.username,
            u.gemini_key_ciphertext AS "geminiKeyCiphertext",
            u.gemini_key_iv         AS "geminiKeyIv",
            u.gemini_key_tag        AS "geminiKeyTag",
            u.gemini_key_hint       AS "geminiKeyHint",
            u.created_at            AS "createdAt"
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
}

/** Used on password change: every other session is revoked, the current one kept. */
export async function deleteOtherSessionsForUser(userId: string, keepTokenHash: string): Promise<number> {
  const { rowCount } = await query(
    "DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2",
    [userId, keepTokenHash],
  );
  return rowCount ?? 0;
}

/** Swept alongside abandoned generations rather than on its own interval. */
export async function deleteExpiredSessions(): Promise<number> {
  const { rowCount } = await query("DELETE FROM sessions WHERE expires_at <= now()");
  return rowCount ?? 0;
}
