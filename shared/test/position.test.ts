import { describe, expect, it } from "vitest";
import { POSITION_GAP } from "../src/config.js";
import { appendPosition, positionBetween } from "../src/position.js";

/**
 * Frame ordering (TECH_SPEC.md section 5.2), one of the three test areas
 * AGENTS.md sanctions.
 *
 * Assertions are about resulting ORDER wherever possible, not just about
 * numbers: the numbers are an implementation detail of the scheme, while the
 * order is the observable behaviour the app depends on.
 */

/** Model of a story's frames, sorted the way the API sorts them. */
function ordered(frames: { id: string; position: number }[]): string[] {
  return [...frames].sort((a, b) => a.position - b.position).map((f) => f.id);
}

describe("appendPosition", () => {
  it("gives the first frame in an empty story POSITION_GAP", () => {
    expect(appendPosition(null)).toBe(POSITION_GAP);
  });

  it("adds POSITION_GAP to the current maximum", () => {
    expect(appendPosition(3000)).toBe(4000);
  });

  it("produces an increasing run when appending repeatedly", () => {
    const positions: number[] = [];
    let max: number | null = null;
    for (let i = 0; i < 6; i += 1) {
      max = appendPosition(max);
      positions.push(max);
    }
    expect(positions).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("positionBetween", () => {
  it("returns the midpoint of two neighbours", () => {
    expect(positionBetween(1000, 2000)).toBe(1500);
  });

  it("is strictly between its neighbours", () => {
    for (const [before, after] of [[1000, 2000], [0, 1], [1000, 1000.5], [-500, 500]] as const) {
      const mid = positionBetween(before, after);
      expect(mid).toBeGreaterThan(before);
      expect(mid).toBeLessThan(after);
    }
  });

  it("inserts at the head when there is no preceding frame", () => {
    expect(positionBetween(null, 1000)).toBeLessThan(1000);
  });

  it("appends when there is no following frame", () => {
    expect(positionBetween(1000, null)).toBeGreaterThan(1000);
  });

  it("returns POSITION_GAP for an empty story", () => {
    expect(positionBetween(null, null)).toBe(POSITION_GAP);
  });
});

describe("reordering a story", () => {
  const initial = [
    { id: "f1", position: 1000 },
    { id: "f2", position: 2000 },
    { id: "f3", position: 3000 },
    { id: "f4", position: 4000 },
  ];

  it("moves the last frame between the first two", () => {
    const moved = initial.map((f) =>
      f.id === "f4" ? { ...f, position: positionBetween(1000, 2000) } : f,
    );
    expect(ordered(moved)).toEqual(["f1", "f4", "f2", "f3"]);
  });

  it("moves a middle frame to the head", () => {
    const moved = initial.map((f) =>
      f.id === "f3" ? { ...f, position: positionBetween(null, 1000) } : f,
    );
    expect(ordered(moved)).toEqual(["f3", "f1", "f2", "f4"]);
  });

  it("moves a middle frame to the tail", () => {
    const moved = initial.map((f) =>
      f.id === "f2" ? { ...f, position: positionBetween(4000, null) } : f,
    );
    expect(ordered(moved)).toEqual(["f1", "f3", "f4", "f2"]);
  });

  it("rewrites exactly one row per move", () => {
    const moved = initial.map((f) =>
      f.id === "f4" ? { ...f, position: positionBetween(1000, 2000) } : f,
    );
    const changed = moved.filter((f, i) => f.position !== initial[i]!.position);
    // The whole point of the float scheme: a reorder never renumbers the rest.
    expect(changed).toHaveLength(1);
  });
});

describe("repeated insertion at the same spot", () => {
  it("keeps every inserted frame in the intended order", () => {
    const frames = [
      { id: "head", position: 1000 },
      { id: "tail", position: 2000 },
    ];
    // Each new frame is inserted directly after "head", so the expected order
    // is head, newest, ..., oldest, tail.
    const inserted: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const after = frames.find((f) => f.id === (inserted[0] ?? "tail"))!.position;
      const position = positionBetween(1000, after);
      const id = `i${i}`;
      frames.push({ id, position });
      inserted.unshift(id);
    }
    expect(ordered(frames)).toEqual(["head", ...inserted, "tail"]);
  });

  it("has a documented precision floor rather than an unbounded one", () => {
    // Establishes the number quoted in the module comment, so a future change
    // to the scheme cannot quietly make it worse.
    let before = 1000;
    const after = 2000;
    let halvings = 0;
    while (halvings < 200) {
      const mid = positionBetween(before, after);
      if (mid <= before || mid >= after) break;
      before = mid;
      halvings += 1;
    }
    expect(halvings).toBeGreaterThanOrEqual(40);
    expect(halvings).toBeLessThan(60);
  });
});
