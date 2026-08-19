import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[server] listening on :${env.PORT} (${env.NODE_ENV})`);
});

// Railway sends SIGTERM on every deploy. Closing the pool here keeps the
// database from accumulating abandoned connections across restarts. The phase 6
// stale-generation sweep interval gets cleared here too.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);

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
