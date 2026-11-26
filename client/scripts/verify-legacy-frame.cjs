// Run against Vite on loopback with VITE_API_BASE_URL=http://mock.invalid.
// Requires Playwright and Chromium (set CHROMIUM_PATH for a system browser).
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage({ serviceWorkers: "block" });
    const origin = process.env.UI_ORIGIN || "http://127.0.0.1:5173";
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.origin !== origin) throw Error("UI_ORIGIN must be an HTTP loopback origin");
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem("storyboards.session", "fixture"));
    const frame = { id: "frame", storyId: "story", position: 1, description: "Fixture scene",
      selectedGenerationId: "generation", imageUrl: null, concepts: [], generations: [] };
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && !url.pathname.startsWith("/api/")) return route.continue();
      if (url.origin === "http://mock.invalid" && route.request().method() === "GET") {
        const fixtures = { "/api/auth/me": { id: "user", username: "fixture" },
          "/api/concepts": [], "/api/frames/frame": frame };
        if (Object.hasOwn(fixtures, url.pathname)) return route.fulfill({ json: fixtures[url.pathname] });
      }
      errors.push("Unexpected request: " + url.pathname);
      await route.abort();
    });
    const known = { provenance: "known", source: { frameId: "source", generationId: "selected",
      sourceFrameDeleted: false } };
    for (const [history, current, expected] of [
      [{}, {}, "Continuity provenance unavailable."],
      [{ continuity: null }, {}, "Continuity provenance unavailable."],
      [{ continuity: known }, { continuitySourceFrameId: "source" }, "Current source selection unavailable."],
      [{ continuity: known }, { continuitySourceSelectedGenerationId: "selected" }, "Current source selection unavailable."],
      [{ continuity: known }, { continuitySourceFrameId: "source", continuitySourceSelectedGenerationId: "selected" },
        "Used current source selection."],
    ]) {
      frame.generations = [{ id: "generation", status: "succeeded", imageUrl: null,
        errorCode: null, errorMessage: null, ...history }];
      delete frame.continuitySourceFrameId;
      delete frame.continuitySourceSelectedGenerationId;
      Object.assign(frame, current);
      await page.goto(origin + "/stories/story/frames/frame");
      await page.getByRole("region", { name: "Generation history" }).getByText(expected, { exact: false }).waitFor({ timeout: 4000 });
      assert.equal(await page.locator("textarea").first().inputValue(), frame.description);
      if (expected !== "Used current source selection.") {
        assert.equal(await page.getByText(/Used current source selection|Current source selection differs/).count(), 0);
      }
      assert.deepEqual(errors, []);
    }
    console.log("Chromium: legacy omitted/null history, both partial source pairs and known match passed");
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
