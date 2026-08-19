import { query } from "./pool.js";

export interface StoryRow {
  id: string;
  title: string;
  coverImageKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The cover thumbnail is the FIRST frame's selected generation, where "first"
 * means lowest position.
 *
 * LEFT JOIN LATERAL ... ON true is what allows a correlated LIMIT 1 per story
 * row; a plain join cannot express "one row per story, chosen by that story's
 * own frame ordering". This keeps the list to a single query with no N+1.
 *
 * Consequence: a story whose first frame has no selected generation yields
 * null even when a later frame does. To prefer the first frame that actually
 * has an image, order the subquery by (selected_generation_id IS NULL), position.
 */
const SELECT_STORIES = `
  SELECT s.id,
         s.title,
         g.image_key AS "coverImageKey",
         s.created_at AS "createdAt",
         s.updated_at AS "updatedAt"
  FROM stories s
  LEFT JOIN LATERAL (
    SELECT f.selected_generation_id
    FROM frames f
    WHERE f.story_id = s.id
    ORDER BY f.position ASC
    LIMIT 1
  ) ff ON true
  LEFT JOIN generations g ON g.id = ff.selected_generation_id
`;

export async function listStories(): Promise<StoryRow[]> {
  const { rows } = await query<StoryRow>(`${SELECT_STORIES} ORDER BY s.created_at DESC`);
  return rows;
}

export async function getStoryById(id: string): Promise<StoryRow | null> {
  const { rows } = await query<StoryRow>(`${SELECT_STORIES} WHERE s.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function storyExists(id: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM stories WHERE id = $1) AS exists",
    [id],
  );
  return rows[0]?.exists ?? false;
}

export async function insertStory(title: string): Promise<StoryRow> {
  const { rows } = await query<{ id: string }>(
    "INSERT INTO stories (title) VALUES ($1) RETURNING id",
    [title],
  );
  const created = await getStoryById(rows[0]!.id);
  return created!;
}

export async function updateStoryTitle(id: string, title: string): Promise<StoryRow | null> {
  const { rowCount } = await query(
    "UPDATE stories SET title = $2, updated_at = now() WHERE id = $1",
    [id, title],
  );
  return rowCount ? getStoryById(id) : null;
}

/** Frames, frame_concepts and generations all cascade from the schema. */
export async function deleteStory(id: string): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM stories WHERE id = $1", [id]);
  return rowCount === 1;
}
