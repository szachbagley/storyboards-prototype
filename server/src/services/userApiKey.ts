import { AppError } from "../lib/AppError.js";
import type { AuthUser } from "../middleware/auth.js";
import { decryptSecret } from "./secretBox.js";

/**
 * Decrypt the caller's Gemini API key, or explain that they have not set one.
 *
 * Kept in its own module so every AI entry point resolves the key the same way,
 * and so the "no key" case is a clear 422 pointing at Settings rather than an
 * empty string reaching Google and coming back as an opaque upstream error.
 *
 * The plaintext exists only in the caller's local scope. It is never logged,
 * never stored in input_snapshot, and never returned in a response.
 */
export function resolveUserApiKey(user: AuthUser): string {
  if (!user.geminiKeyCiphertext || !user.geminiKeyIv || !user.geminiKeyTag) {
    throw new AppError(
      422,
      "no_api_key",
      "Add your Gemini API key in Settings before generating.",
    );
  }
  return decryptSecret({
    ciphertext: user.geminiKeyCiphertext,
    iv: user.geminiKeyIv,
    tag: user.geminiKeyTag,
  });
}
