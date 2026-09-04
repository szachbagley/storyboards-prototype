import { z } from "zod";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from "./config.js";
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

/** POST /stories */
export const CreateStorySchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export type CreateStoryBody = z.infer<typeof CreateStorySchema>;

/** PATCH /stories/:id. Title is the only field, so an empty body is always a
 * mistake rather than a no-op -- hence required, not optional. */
export const UpdateStorySchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export type UpdateStoryBody = z.infer<typeof UpdateStorySchema>;

/** POST /stories/:id/frames. Appends; a frame may start with no description.
 * The non-empty requirement is a generation-time rule, not a creation-time one. */
export const CreateFrameSchema = z.object({
  description: z.string().max(5000).optional(),
});
export type CreateFrameBody = z.infer<typeof CreateFrameSchema>;

/** PATCH /frames/:id.
 *
 * conceptIds replaces the attachment set wholesale and its array index becomes
 * frame_concepts.ord, which becomes the reference-image enumeration order in
 * the compiled prompt. It is deliberately uncapped here: TECH_SPEC.md section
 * 8.3 places the 4-character and 10-total caps on generation, not attachment.
 *
 * position must be finite. Postgres accepts 'NaN'::double precision without
 * complaint and sorts it above every real value, so a NaN would silently pin a
 * frame to the end of its story with no error and no way to reorder it back. */
export const UpdateFrameSchema = z
  .object({
    description: z.string().max(5000).optional(),
    conceptIds: z
      .array(z.uuid())
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "conceptIds must not contain duplicates",
      })
      .optional(),
    position: z.number().finite().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateFrameBody = z.infer<typeof UpdateFrameSchema>;

/** POST /frames/:id/select-generation */
export const SelectGenerationSchema = z.object({
  generationId: z.uuid(),
});
export type SelectGenerationBody = z.infer<typeof SelectGenerationSchema>;

// --- Identity -------------------------------------------------------------

const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH)
  .max(USERNAME_MAX_LENGTH)
  .regex(USERNAME_PATTERN, "Use letters, numbers, underscores or hyphens only");

const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

// Not trimmed on the inner value beyond the edges: an API key is opaque and we
// must not silently alter it, but pasted whitespace is a common mistake.
const geminiKeySchema = z.string().trim().min(1).max(200);

/** POST /auth/register */
export const RegisterSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  geminiApiKey: geminiKeySchema,
  /** Only required when the server has SIGNUP_CODE set. */
  signupCode: z.string().optional(),
});
export type RegisterBody = z.infer<typeof RegisterSchema>;

/** POST /auth/login. Deliberately loose: an existing account may predate any
 *  later tightening of the username or password rules, and login must not
 *  reject a valid credential because the policy moved. */
export const LoginSchema = z.object({
  username: z.string().trim().min(1).max(USERNAME_MAX_LENGTH),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
export type LoginBody = z.infer<typeof LoginSchema>;

/** PATCH /auth/me */
export const UpdateMeSchema = z
  .object({
    password: passwordSchema.optional(),
    geminiApiKey: geminiKeySchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateMeBody = z.infer<typeof UpdateMeSchema>;
