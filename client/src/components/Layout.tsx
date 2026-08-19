import { NavLink, Outlet } from "react-router-dom";

/** TECH_SPEC.md section 12.1: two tabs, persistent across all authenticated views. */
export function Layout() {
  return (
    <div className="app">
      <header className="tabs">
        <NavLink to="/concepts" className={({ isActive }) => (isActive ? "tab tab-active" : "tab")}>
          Concepts
        </NavLink>
        <NavLink to="/stories" className={({ isActive }) => (isActive ? "tab tab-active" : "tab")}>
          Stories
        </NavLink>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
