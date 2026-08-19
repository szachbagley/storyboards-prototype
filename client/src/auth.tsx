import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { clearToken, getToken, setToken, setUnauthorizedHandler } from "./api.js";

interface AuthValue {
  secret: string | null;
  signIn: (secret: string) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [secret, setSecret] = useState<string | null>(() => getToken());
  const navigate = useNavigate();

  const signIn = useCallback((next: string) => {
    setToken(next);
    setSecret(next);
  }, []);

  const signOut = useCallback(() => {
    clearToken();
    setSecret(null);
  }, []);

  // api.ts clears the token on any 401; this puts the user back on /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSecret(null);
      navigate("/login", { replace: true });
    });
  }, [navigate]);

  const value = useMemo(() => ({ secret, signIn, signOut }), [secret, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth used outside AuthProvider");
  return value;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { secret } = useAuth();
  const location = useLocation();
  if (!secret) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
