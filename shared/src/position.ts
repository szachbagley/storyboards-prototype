import { POSITION_GAP } from "./config.js";

// Frame ordering (TECH_SPEC.md section 5.2).
//
// frames.position is DOUBLE PRECISION rather than a sequence integer so that
// inserting or reordering rewrites exactly one row instead of renumbering every
// frame after it.
//
// These live in shared/ rather than on the server because the ordering scheme
// has two callers: the server appends (POST /stories/:id/frames), and the
// client computes a target position for a reorder and sends it as
// PATCH /frames/:id { position }. One implementation, used by both, so the two
// halves cannot drift apart.

/** Position for a frame appended to the end of a story. */
export function appendPosition(currentMax: number | null): number {
  return (currentMax ?? 0) + POSITION_GAP;
}

/**
 * Position that sorts strictly between two neighbours.
 *
 * Pass null for a missing neighbour: `positionBetween(null, first)` inserts at
 * the head, `positionBetween(last, null)` appends, and both null yields the
 * first position in an empty story.
 *
 * Precision limit: repeatedly inserting at the same spot halves the gap each
 * time, and double precision runs out after roughly 53 consecutive midpoints
 * from a 1000-unit gap (43 from a 1-unit gap). Past that the midpoint equals a
 * neighbour and two frames share a position, making their relative order
 * arbitrary. Reaching it requires 43+ inserts between the same two frames with
 * no intervening append, so no renormalization pass is implemented.
 */
export function positionBetween(before: number | null, after: number | null): number {
  if (before !== null && after !== null) return (before + after) / 2;
  if (after !== null) return after - POSITION_GAP;
  if (before !== null) return before + POSITION_GAP;
  return POSITION_GAP;
}
