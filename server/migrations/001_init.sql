-- Initial schema. Mirrors TECH_SPEC.md section 5 exactly.
-- Applied inside a transaction by the runner, so no BEGIN/COMMIT here.

CREATE TYPE concept_type AS ENUM ('character', 'setting', 'prop');
CREATE TYPE generation_status AS ENUM ('pending', 'succeeded', 'failed');

-- Concepts are global to the user, not scoped to a story, so the same
-- character can appear across multiple stories.
CREATE TABLE concepts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  type         concept_type NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  image_key    TEXT,                      -- S3 object key; NULL until uploaded
  image_mime   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- position is DOUBLE PRECISION rather than a sequence integer: appending uses
-- max(position) + 1000 and inserting between two frames uses their midpoint,
-- so a reorder never rewrites every downstream row.
CREATE TABLE frames (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id               UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  position               DOUBLE PRECISION NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  selected_generation_id UUID,            -- FK added below, after generations exists
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX frames_story_position_idx ON frames (story_id, position);

-- ord drives the reference-image enumeration order in the compiled prompt. The
-- unique index means a wholesale replacement of a frame's attachments must
-- DELETE then INSERT within one transaction, or reused ord values collide.
CREATE TABLE frame_concepts (
  frame_id     UUID NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  concept_id   UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  PRIMARY KEY (frame_id, concept_id)
);
CREATE UNIQUE INDEX frame_concepts_ord_idx ON frame_concepts (frame_id, ord);

-- Generations append, never overwrite. compiled_prompt and input_snapshot are
-- written before the API call: concepts are mutable, so without the snapshot
-- editing one destroys the provenance of every frame generated from it.
CREATE TABLE generations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  frame_id         UUID NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  status           generation_status NOT NULL DEFAULT 'pending',
  model            TEXT NOT NULL,
  compiled_prompt  TEXT NOT NULL,
  input_snapshot   JSONB NOT NULL,
  image_key        TEXT,
  interaction_id   TEXT,
  error_code       TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX generations_frame_idx ON generations (frame_id, created_at DESC);

-- Partial index. Serves both the stale sweep and the 409-on-duplicate check.
CREATE INDEX generations_pending_idx ON generations (created_at) WHERE status = 'pending';

-- Circular reference: frames is created before generations, so this cannot be
-- declared inline on the column.
ALTER TABLE frames
  ADD CONSTRAINT frames_selected_generation_fk
  FOREIGN KEY (selected_generation_id) REFERENCES generations(id) ON DELETE SET NULL;
