import { AppError } from "../lib/AppError.js";

// Only the offline fixture opts in pending release and verification that
// bucket lifecycle rules retain private inputs until destination deletion.
export function requireContinuityRollout(enabled: boolean): void {
  if (!enabled) throw new AppError(422, "continuity_unavailable", "Source-frame continuity is not available yet.");
}
