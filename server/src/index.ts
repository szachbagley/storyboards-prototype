import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { startSweeper } from "./services/sweep.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[server] listening on :${env.PORT} (${env.NODE_ENV})`);
});

// Runs once now and then every SWEEP_INTERVAL_MS. The start-up run is what
// recovers generations orphaned by the previous container being replaced.
const stopSweeper = startSweeper();

// Railway sends SIGTERM on every deploy. Closing the pool here keeps the
// database from accumulating abandoned connections across restarts, and
// stopping the sweeper lets the process exit promptly.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  stopSweeper();

  server.close(() => {
    void pool.end().then(() => {
      process.exit(0);
    });
  });

  // Do not hang forever on a stuck connection.
  setTimeout(() => {
    console.error("[server] forced exit after shutdown timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
