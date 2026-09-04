import type {
  ApiErrorBody,
  AuthResponse,
  ConceptDto,
  ConceptType,
  FrameDto,
  FrameSummaryDto,
  GenerationSummaryDto,
  StoryDto,
  UserDto,
} from "@storyboards/shared";

const BASE = import.meta.env.VITE_API_BASE_URL;
const TOKEN_KEY = "storyboards.session";

/** Mirrors the ApiErrorBody shape every non-2xx response has carried since phase 1. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

// Set by AuthProvider so a 401 can bounce to /login without api.ts importing
// the router.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE}/api${path}`, { ...init, headers });

  // On 401 the client clears the stored session and returns to the login
  // screen. Handled once here so no view has to remember -- and it now covers
  // an expired or revoked session as well as a wrong credential.
  if (res.status === 401) {
    clearToken();
    onUnauthorized?.();
    throw new ApiError(401, "unauthorized", "Your session is no longer valid. Sign in again.");
  }

  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // Non-JSON error body; fall through to the status text.
    }
    throw new ApiError(
      res.status,
      body?.error.code ?? "unknown_error",
      body?.error.message ?? res.statusText,
      body?.error.details,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

export const api = {
  // --- auth ---
  register: (body: { username: string; password: string; geminiApiKey: string; signupCode?: string }) =>
    send<AuthResponse>("/auth/register", "POST", body),
  login: (body: { username: string; password: string }) => send<AuthResponse>("/auth/login", "POST", body),
  logout: () => send<void>("/auth/logout", "POST"),
  getMe: () => request<UserDto>("/auth/me"),
  updateMe: (body: { password?: string; geminiApiKey?: string }) => send<UserDto>("/auth/me", "PATCH", body),

  // --- concepts ---
  listConcepts: () => request<ConceptDto[]>("/concepts"),
  getConcept: (id: string) => request<ConceptDto>(`/concepts/${id}`),
  createConcept: (body: { name: string; type: ConceptType }) => send<ConceptDto>("/concepts", "POST", body),
  updateConcept: (id: string, body: { name?: string; type?: ConceptType; description?: string }) =>
    send<ConceptDto>(`/concepts/${id}`, "PATCH", body),
  deleteConcept: (id: string) => send<void>(`/concepts/${id}`, "DELETE"),
  describeConcept: (id: string) => send<{ description: string }>(`/concepts/${id}/describe`, "POST"),

  uploadConceptImage: (id: string, file: File) => {
    const form = new FormData();
    form.append("image", file);
    // Deliberately no Content-Type header: the browser must set it so the
    // multipart boundary is included. Setting it by hand yields a confusing 415.
    return request<ConceptDto>(`/concepts/${id}/image`, { method: "POST", body: form });
  },

  // --- stories ---
  listStories: () => request<StoryDto[]>("/stories"),
  getStory: (id: string) => request<StoryDto>(`/stories/${id}`),
  createStory: (body: { title: string }) => send<StoryDto>("/stories", "POST", body),
  deleteStory: (id: string) => send<void>(`/stories/${id}`, "DELETE"),

  // --- frames ---
  listStoryFrames: (storyId: string) => request<FrameSummaryDto[]>(`/stories/${storyId}/frames`),
  createFrame: (storyId: string, body: { description?: string }) =>
    send<FrameDto>(`/stories/${storyId}/frames`, "POST", body),
  getFrame: (id: string) => request<FrameDto>(`/frames/${id}`),
  updateFrame: (id: string, body: { description?: string; conceptIds?: string[]; position?: number }) =>
    send<FrameDto>(`/frames/${id}`, "PATCH", body),
  deleteFrame: (id: string) => send<void>(`/frames/${id}`, "DELETE"),

  // --- generation ---
  generateFrame: (frameId: string) => send<{ generationId: string }>(`/frames/${frameId}/generate`, "POST"),
  getGeneration: (id: string) => request<GenerationSummaryDto>(`/generations/${id}`),
  selectGeneration: (frameId: string, generationId: string) =>
    send<FrameDto>(`/frames/${frameId}/select-generation`, "POST", { generationId }),
};
