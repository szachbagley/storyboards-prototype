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

// Every read and write is scoped to the owning user. The lateral cover-thumbnail
// subquery is already correlated to s.id, so filtering the outer query is
// sufficient -- a story's frames cannot belong to anyone else.

export async function listStories(userId: string): Promise<StoryRow[]> {
  const { rows } = await query<StoryRow>(
    `${SELECT_STORIES} WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
    [userId],
  );
  return rows;
}

/** Null for another user's story, exactly as for one that does not exist. */
export async function getStoryById(id: string, userId: string): Promise<StoryRow | null> {
  const { rows } = await query<StoryRow>(`${SELECT_STORIES} WHERE s.id = $1 AND s.user_id = $2`, [id, userId]);
  return rows[0] ?? null;
}

export async function storyExists(id: string, userId: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM stories WHERE id = $1 AND user_id = $2) AS exists",
    [id, userId],
  );
  return rows[0]?.exists ?? false;
}

export async function insertStory(userId: string, title: string): Promise<StoryRow> {
  const { rows } = await query<{ id: string }>(
    "INSERT INTO stories (user_id, title) VALUES ($1, $2) RETURNING id",
    [userId, title],
  );
  const created = await getStoryById(rows[0]!.id, userId);
  return created!;
}

export async function updateStoryTitle(id: string, userId: string, title: string): Promise<StoryRow | null> {
  const { rowCount } = await query(
    "UPDATE stories SET title = $3, updated_at = now() WHERE id = $1 AND user_id = $2",
    [id, userId, title],
  );
  return rowCount ? getStoryById(id, userId) : null;
}

/** Frames, frame_concepts and generations all cascade from the schema. */
export async function deleteStory(id: string, userId: string): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM stories WHERE id = $1 AND user_id = $2", [id, userId]);
  return rowCount === 1;
}
