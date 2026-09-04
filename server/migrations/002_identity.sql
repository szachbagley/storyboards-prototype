-- Accounts, sessions and per-user data ownership. See identity-plan.md.
--
-- This migration is DESTRUCTIVE by design: the prototype's single-user data is
-- disposable test data (identity-plan.md 1.2), so user_id is NOT NULL from the
-- start rather than nullable-then-tightened. S3 objects for the deleted rows are
-- removed beforehand through the API, which already cleans storage on delete.

CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username              TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  -- Nullable: a user row exists before a key is validated, and a key can be
  -- cleared. Application code treats a missing key as "cannot generate".
  gemini_key_ciphertext BYTEA,
  gemini_key_iv         BYTEA,
  gemini_key_tag        BYTEA,
  -- Last 4 characters only, so Settings can show something recognisable
  -- without the key ever leaving the server.
  gemini_key_hint       TEXT,
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: "Zach" and "zach" must not be two accounts.
-- Login looks up by lower(username) so it uses this index.
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));

-- Opaque bearer tokens, stored as sha256 so a database dump yields no live
-- sessions. Revocable, unlike a JWT -- sign-out and password change both need
-- to invalidate immediately.
CREATE TABLE sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_token_hash_idx ON sessions (token_hash);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Must precede the ALTERs: adding a NOT NULL column to a table with rows fails
-- with "contains null values". Deleting through stories and concepts lets the
-- existing FK cascades clear frames, frame_concepts and generations.
DELETE FROM stories;
DELETE FROM concepts;

ALTER TABLE concepts ADD COLUMN user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE stories  ADD COLUMN user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE;

-- Composite, ordered to match the list endpoints' existing ORDER BY created_at
-- DESC, so adding WHERE user_id = $1 does not turn an index scan into a sort.
CREATE INDEX concepts_user_idx ON concepts (user_id, created_at DESC);
CREATE INDEX stories_user_idx  ON stories  (user_id, created_at DESC);
