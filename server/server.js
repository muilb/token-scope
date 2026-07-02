"use strict";
/**
 * Entry point. Run: `node server.js`
 * Config via env:
 *   PORT          (default 8787)
 *   HOST          (default 127.0.0.1 — LAN/VPN only, not exposed to Internet)
 *   INGEST_KEY    shared token clients send as X-Ingest-Key (empty = no gate; dev only)
 *   ADMIN_KEY     protects /admin + pricing edits (empty = open; dev only)
 *   DB_PATH       (default ./data/usage.db)
 */
const path = require("path");
const { openDb } = require("./db");
const { buildApp } = require("./app");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const INGEST_KEY = process.env.INGEST_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "usage.db");

const db = openDb(DB_PATH);
const app = buildApp(db, { ingestKey: INGEST_KEY, adminKey: ADMIN_KEY });

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    console.log(`tokenscope-central listening on http://${HOST}:${PORT}  (db: ${DB_PATH})`);
    if (!INGEST_KEY) console.warn("WARN: INGEST_KEY empty — ingest is unauthenticated (dev only).");
    if (!ADMIN_KEY) console.warn("WARN: ADMIN_KEY empty — pricing admin (/admin) is open (dev only).");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

// Graceful shutdown: fold the WAL back into usage.db and close the DB cleanly so
// the machine can be turned off between shifts without stranding data in the WAL
// (and so a backup can copy usage.db alone). Committed rows are already crash-safe;
// this just tidies the files. Idempotent-guarded against double signals.
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} received — checkpointing WAL and closing DB…`);
  try {
    app.close().catch(() => {});
    db.pragma("wal_checkpoint(TRUNCATE)"); // merge WAL into the main file
    db.close();
    console.log("DB closed cleanly.");
  } catch (e) {
    console.error("shutdown error:", e);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => shutdown("SIGINT")); // Ctrl+C
process.on("SIGTERM", () => shutdown("SIGTERM")); // kill / service stop
