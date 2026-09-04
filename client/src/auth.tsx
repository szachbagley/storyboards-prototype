import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type { UserDto } from "@storyboards/shared";
import { api, clearToken, getToken, setToken, setUnauthorizedHandler } from "./api.js";

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

  const signIn = useCallback((token: string, next: UserDto) => {
    setToken(token);
    setUserState(next);
  }, []);

  const signOut = useCallback(async () => {
    // Best effort: the server deletes the session row so the token cannot be
    // replayed. Even if the call fails, drop it locally.
    try {
      await api.logout();
    } catch {
      /* already invalid, or offline */
    }
    clearToken();
    setUserState(null);
    navigate("/login", { replace: true });
  }, [navigate]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUserState(null);
      navigate("/login", { replace: true });
    });
  }, [navigate]);

  // Rehydrate from a stored token on load, which also detects a session that
  // was revoked or expired while the tab was closed.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    api
      .getMe()
      .then((me) => {
        if (!cancelled) setUserState(me);
      })
      .catch(() => {
        if (!cancelled) clearToken();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
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
