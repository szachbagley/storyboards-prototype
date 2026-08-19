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
  APP_SECRET: z.string().min(8),

  // The AWS SDK's default credential provider chain reads the two key
  // variables from process.env itself, so they are never passed to the client
  // explicitly. They are validated here purely to fail at boot with a clear
  // message rather than on the first upload.
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),

  // Read by the @google/genai default client, same pattern as the AWS keys:
  // validated here only so a missing key fails at boot rather than on the first
  // description request. It never reaches the browser (invariant 1) -- all
  // Gemini traffic originates on the server.
  GEMINI_API_KEY: z.string().min(1),
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
