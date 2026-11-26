// A tab can resume an ambiguous admission without retaining any generation inputs.
export interface OutstandingRequest {
  requestId: string | null;
  generationId: string | null;
}
const prefix = (userId: string) => `storyboards.generation.${userId}.`;
export const requestKey = (userId: string, frameId: string) => prefix(userId) + frameId;
const memory = new Map<string, OutstandingRequest | null>();
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function readOutstanding(key: string): { value: OutstandingRequest | null; storageAvailable: boolean } {
  const cached = memory.get(key) ?? null;
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(key);
  } catch { return { value: cached, storageAvailable: false }; }
  if (memory.has(key)) return { value: cached, storageAvailable: true };
  try {
    const value = JSON.parse(raw ?? "null");
    if (value && (value.requestId === null || uuid.test(value.requestId)) &&
        (value.generationId === null || uuid.test(value.generationId)) &&
        (value.requestId || value.generationId)) {
      memory.set(key, value);
      return { value, storageAvailable: true };
    }
  } catch { /* An unreadable old record contains no usable identifier. */ }
  return { value: null, storageAvailable: true };
}

export function writeOutstanding(key: string, value: OutstandingRequest | null): boolean {
  memory.set(key, value);
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}

export function clearAccountRequests(userId: string) {
  const accountPrefix = prefix(userId);
  for (const key of memory.keys()) if (key.startsWith(accountPrefix)) memory.set(key, null);
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(accountPrefix)) sessionStorage.removeItem(key);
    }
  } catch { /* Memory records are already cleared. */ }
}
