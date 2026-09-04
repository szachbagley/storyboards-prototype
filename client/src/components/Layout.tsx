import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth.js";

/** TECH_SPEC.md section 12.1: two tabs, persistent across all authenticated views. */
export function Layout() {
  const { user } = useAuth();

  return (
    <div className="app">
      <header className="tabs">
        <NavLink to="/concepts" className={({ isActive }) => (isActive ? "tab tab-active" : "tab")}>
          Concepts
        </NavLink>
        <NavLink to="/stories" className={({ isActive }) => (isActive ? "tab tab-active" : "tab")}>
          Stories
        </NavLink>
        <span style={{ marginLeft: "auto" }} className="row">
          {user && <span className="muted">{user.username}</span>}
          <Link to="/settings" className="tab" style={{ paddingBottom: 12 }}>
            Settings
          </Link>
        </span>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
