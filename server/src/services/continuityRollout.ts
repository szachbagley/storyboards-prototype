import { AppError } from "../lib/AppError.js";

// The API opts in only after the private input retention policy is verified.
export function requireContinuityRollout(enabled: boolean): void {
  if (!enabled) throw new AppError(422, "continuity_unavailable", "Source-frame continuity is not available yet.");
}
