const fixture = globalThis.__key17Fixture;

export async function requestKeyValidation(apiKey, signal) {
  fixture.keysSeen.push(apiKey);
  fixture.calls.push({ hasSignal: signal instanceof AbortSignal });
  if (fixture.nextError) {
    const error = fixture.nextError;
    fixture.nextError = null;
    throw error;
  }
  return;
}
