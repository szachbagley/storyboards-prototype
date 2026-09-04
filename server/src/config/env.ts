import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Resolves to server/.env from both src/config/ and dist/config/, so the file
// is found regardless of the process working directory.
loadDotenv({ path: new URL("../../.env", import.meta.url), quiet: true });

// Only variables the current phase actually uses are required, so a developer
// can boot the API without credentials it does not yet need.
//
// Application constants (model IDs, aspect ratio, concept caps) are NOT
// environment variables -- they live in shared/src/config.ts. See TECH_SPEC.md
// section 11.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // The AWS SDK's default credential provider chain reads the two key
  // variables from process.env itself, so they are never passed to the client
  // explicitly. They are validated here purely to fail at boot with a clear
  // message rather than on the first upload.
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),

  // Master key for encrypting each user's Gemini API key at rest. Validated for
  // decoded length, not just presence: a 31-byte key would fail only later, at
  // the first createCipheriv call.
  //
  // Losing or changing this makes every stored Gemini key unrecoverable. Users
  // would have to re-enter them.
  ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "must be 32 bytes, base64-encoded (openssl rand -base64 32)",
    }),

  // Optional registration gate. Unset means open registration.
  SIGNUP_CODE: z.string().min(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Report every problem at once; fixing them one boot at a time is miserable.
  console.error("[env] invalid environment:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
