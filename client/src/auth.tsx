import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type { UserDto } from "@storyboards/shared";
import { api, clearToken, getToken, setToken, setUnauthorizedHandler, TOKEN_KEY } from "./api.js";
import { clearAccountRequests } from "./generationRequests.js";

interface AuthValue {
  user: UserDto | null;
  /** True until the stored token has been checked against the server. */
  loading: boolean;
  signIn: (token: string, user: UserDto) => void;
  signOut: () => Promise<void>;
  setUser: (user: UserDto) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(() => getToken() !== null);
  const navigate = useNavigate();
  const account = useRef<string | null>(null);

  const signIn = useCallback((token: string, next: UserDto) => {
    if (account.current && account.current !== next.id) clearAccountRequests(account.current);
    account.current = next.id;
    setToken(token);
    setLoading(false);
    setUserState(next);
  }, []);

  const signOut = useCallback(async () => {
    // Best effort: the server deletes the session row so the token cannot be
    // replayed. Even if the call fails, drop it locally.
    const previous = account.current;
    if (previous) clearAccountRequests(previous);
    const logout = api.logout();
    clearToken();
    account.current = null;
    setUserState(null);
    navigate("/login", { replace: true });
    try {
      await logout;
    } catch {
      /* already invalid, or offline */
    }
  }, [navigate]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (account.current) clearAccountRequests(account.current);
      account.current = null;
      setUserState(null);
      navigate("/login", { replace: true });
    });
  }, [navigate]);

  // Rehydrate from a stored token on load, which also detects a session that
  // was revoked or expired while the tab was closed.
  useEffect(() => {
    let epoch = 0;
    async function rehydrate() {
      const sequence = ++epoch;
      const token = getToken();
      setLoading(Boolean(token));
      if (!token) return;
      try {
        const me = await api.getMe();
        if (sequence === epoch && token === getToken()) {
          account.current = me.id;
          setUserState(me);
        }
      } catch {
        if (sequence === epoch && token === getToken()) clearToken();
      } finally {
        if (sequence === epoch) setLoading(false);
      }
    }
    function sessionChanged(event: StorageEvent) {
      if (event.storageArea !== localStorage || (event.key !== null && event.key !== TOKEN_KEY)) return;
      if (account.current) clearAccountRequests(account.current);
      account.current = null;
      setUserState(null);
      void rehydrate();
    }
    void rehydrate();
    window.addEventListener("storage", sessionChanged);
    return () => {
      epoch++;
      window.removeEventListener("storage", sessionChanged);
    };
  }, []);

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, setUser: setUserState }),
    [user, loading, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth used outside AuthProvider");
  return value;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  // Waiting rather than redirecting: a stored token that is still valid would
  // otherwise bounce to /login for a frame before rehydrating.
  if (loading) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
