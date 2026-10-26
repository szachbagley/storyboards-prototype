-- Additive continuity and admission contracts. Apply only after generation
-- ingress has stopped and active work has drained.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM generations WHERE status = 'pending'
    GROUP BY frame_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate pending generations; drain and investigate before migration';
  END IF;
END;
$$;

ALTER TABLE frames ADD COLUMN continuity_source_frame_id UUID;
ALTER TABLE frames ADD CONSTRAINT frames_continuity_not_self
  CHECK (continuity_source_frame_id IS NULL OR continuity_source_frame_id <> id);
ALTER TABLE frames ADD CONSTRAINT frames_continuity_source_fk
  FOREIGN KEY (continuity_source_frame_id) REFERENCES frames(id) ON DELETE SET NULL;
CREATE INDEX frames_continuity_source_idx ON frames (continuity_source_frame_id)
  WHERE continuity_source_frame_id IS NOT NULL;

ALTER TABLE generations ADD COLUMN request_id UUID;
CREATE UNIQUE INDEX generations_frame_request_uidx
  ON generations (frame_id, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX generations_one_pending_per_frame_uidx
  ON generations (frame_id) WHERE status = 'pending';
