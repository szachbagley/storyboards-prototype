// Deliberately local, in-memory substitutes for generation and S3. Imported
// only by the offline verification script's module resolve hook.
const state = globalThis.__package1Harness;

export async function validateApiKey() {
  state.calls.validate += 1;
  return true;
}
export async function describeImage() {
  state.calls.describe += 1;
  return "Fixture description";
}
export async function generateImage() {
  state.calls.generate += 1;
  if (state.gate) await state.gate;
  if (state.nextGenerationError) {
    const error = state.nextGenerationError;
    state.nextGenerationError = null;
    throw error;
  }
  return { base64: Buffer.from("fixture-output").toString("base64"), interactionId: "fixture-interaction" };
}
export const conceptImageKey = (id) => `concepts/${id}/reference.jpg`;
export const generationImageKey = (id) => `generations/${id}.jpg`;
export async function putObject(key, bytes) {
  state.calls.put += 1;
  state.objects.set(key, Buffer.from(bytes));
}
export async function getObjectBytes(key) {
  state.calls.get += 1;
  if (state.getGate) await state.getGate;
  const bytes = state.objects.get(key);
  if (!bytes) throw new Error("fixture object absent");
  return Buffer.from(bytes);
}
export async function deleteObject(key) {
  state.calls.delete += 1;
  state.objects.delete(key);
}
export async function getPresignedUrl(key) {
  return `http://127.0.0.1/fixture/${encodeURIComponent(key)}`;
}
