import { useEffect, useState } from "react";
import { ASPECT_RATIO, IMAGE_MODEL } from "@storyboards/shared";

// Phase 1 scaffold only. This exists to prove three wirings end to end before
// phase 7 builds the real views: the API is reachable across origins, the
// VITE_API_BASE_URL environment variable arrives, and @storyboards/shared
// resolves in the browser build. Replaced entirely by the login screen and
// router in phase 7.
export function App() {
  const [health, setHealth] = useState<string>("checking...");

  useEffect(() => {
    const base = import.meta.env.VITE_API_BASE_URL;
    fetch(`${base}/api/health`)
      .then((res) => res.json())
      .then((body: unknown) => setHealth(JSON.stringify(body)))
      .catch((err: unknown) => setHealth(`unreachable: ${String(err)}`));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Storyboards</h1>
      <p>
        API base: <code>{import.meta.env.VITE_API_BASE_URL}</code>
      </p>
      <p>
        Health: <code>{health}</code>
      </p>
      <p>
        From shared config: <code>{IMAGE_MODEL}</code> at <code>{ASPECT_RATIO}</code>
      </p>
    </main>
  );
}
