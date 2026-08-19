import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Resolves to server/.env from both src/config/ and dist/config/, so the file
// is found regardless of the process working directory.
loadDotenv({ path: new URL("../../.env", import.meta.url), quiet: true });

// Only variables the current phase actually uses are required, so a developer
// can boot the API without AWS or Gemini credentials. Add S3 variables here in
// phase 2 and GEMINI_API_KEY in phase 3.
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
