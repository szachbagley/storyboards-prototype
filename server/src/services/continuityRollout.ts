import { AppError } from "../lib/AppError.js";

// The production app uses the default closed gate until destination deletion
// inventories retained inputs (#12). Only the offline app fixture opts in.
export function requireContinuityRollout(enabled: boolean): void {
  if (!enabled) throw new AppError(422, "continuity_unavailable", "Source-frame continuity is not available yet.");
}
