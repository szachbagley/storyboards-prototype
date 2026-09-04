import type pg from "pg";
import { query } from "./pool.js";

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  geminiKeyCiphertext: Buffer | null;
  geminiKeyIv: Buffer | null;
  geminiKeyTag: Buffer | null;
  geminiKeyHint: string | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `
  id,
  username,
  password_hash         AS "passwordHash",
  gemini_key_ciphertext AS "geminiKeyCiphertext",
  gemini_key_iv         AS "geminiKeyIv",
  gemini_key_tag        AS "geminiKeyTag",
  gemini_key_hint       AS "geminiKeyHint",
  failed_attempts       AS "failedAttempts",
  locked_until          AS "lockedUntil",
  created_at            AS "createdAt",
  updated_at            AS "updatedAt"
`;

/** Case-insensitive lookup, matching the users_username_lower_idx index. */
export async function findUserByUsername(username: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(
    `SELECT ${COLUMNS} FROM users WHERE lower(username) = lower($1)`,
    [username],
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertUser(
  client: pg.PoolClient,
  input: {
    username: string;
    passwordHash: string;
    geminiKeyCiphertext: Buffer;
    geminiKeyIv: Buffer;
    geminiKeyTag: Buffer;
    geminiKeyHint: string;
  },
): Promise<UserRow> {
  const { rows } = await client.query<UserRow>(
    `INSERT INTO users (username, password_hash, gemini_key_ciphertext, gemini_key_iv, gemini_key_tag, gemini_key_hint)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [
      input.username,
      input.passwordHash,
      input.geminiKeyCiphertext,
      input.geminiKeyIv,
      input.geminiKeyTag,
      input.geminiKeyHint,
    ],
  );
  return rows[0]!;
}

export async function updatePassword(id: string, passwordHash: string): Promise<void> {
  await query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [id, passwordHash]);
}

export async function updateGeminiKey(
  id: string,
  input: { ciphertext: Buffer; iv: Buffer; tag: Buffer; hint: string },
): Promise<void> {
  await query(
    `UPDATE users
        SET gemini_key_ciphertext = $2, gemini_key_iv = $3, gemini_key_tag = $4,
            gemini_key_hint = $5, updated_at = now()
      WHERE id = $1`,
    [id, input.ciphertext, input.iv, input.tag, input.hint],
  );
}

/**
 * Increment the failure counter and lock the account once it crosses the
 * threshold. Done in one statement so concurrent attempts cannot interleave a
 * read and a write and lose a count.
 */
export async function recordFailedAttempt(id: string, maxAttempts: number, lockMinutes: number): Promise<void> {
  await query(
    `UPDATE users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2
                                THEN now() + ($3 * interval '1 minute')
                                ELSE locked_until END,
            updated_at = now()
      WHERE id = $1`,
    [id, maxAttempts, lockMinutes],
  );
}

export async function resetFailedAttempts(id: string): Promise<void> {
  await query(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1",
    [id],
  );
}
