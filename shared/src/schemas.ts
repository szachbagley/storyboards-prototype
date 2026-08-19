import { z } from "zod";
import { CONCEPT_TYPES } from "./types.js";

/** Route params for any `/:id` endpoint. Rejects malformed UUIDs at the
 * boundary so they never reach Postgres, where they would surface as a 500.
 *
 * z.uuid() enforces the RFC version and variant nibbles, not merely the
 * hex-and-dashes shape. That is correct here because every id in this system
 * comes from gen_random_uuid(), which emits conformant v4. Be aware that a
 * hand-written placeholder such as 11111111-1111-1111-1111-111111111111 is
 * rejected -- it is not a well-formed UUID, however plausible it looks. */
export const UuidParamSchema = z.object({
  id: z.uuid(),
});

/** POST /concepts. Description is deliberately absent -- concepts start with an
 * empty description, which is then written either by hand or from the phase 3
 * /describe endpoint. */
export const CreateConceptSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(CONCEPT_TYPES),
});
export type CreateConceptBody = z.infer<typeof CreateConceptSchema>;

/** PATCH /concepts/:id. Every field optional, but an empty body is a mistake
 * rather than a no-op, so it is rejected.
 *
 * description permits the empty string (clearing a description is legitimate)
 * while name does not. The length ceiling is a sanity bound, not a content
 * rule: the identity-only rule is enforced by the meta-prompt, the textarea
 * placeholder and the compiler, never by rejecting what the user typed. */
export const UpdateConceptSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    type: z.enum(CONCEPT_TYPES).optional(),
    description: z.string().max(5000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateConceptBody = z.infer<typeof UpdateConceptSchema>;
