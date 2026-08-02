// One-off / re-runnable helper: applies supabase/schema.sql to the DATABASE_URL in .env.
// Usage: node supabase/apply-schema.mjs
//
// Postgres on the Hetzner box is bound to 127.0.0.1 only (not exposed
// publicly, deliberately) -- so DATABASE_URL points at localhost:15432 and
// this script opens a throwaway SSH tunnel to get there, since the box
// already trusts this machine's key (see docs/setup.md). Port 15432, not
// 5432 -- this machine also runs an unrelated local embedded-postgres
// (HostelSure's local-db) squatting on 5432.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "pg";

const dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(dir, "..", ".env");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
);

const sql = readFileSync(path.join(dir, "schema.sql"), "utf8");

const SSH_HOST = "root@167.233.242.179"; // Hetzner (bali-production)

function openTunnel() {
  const proc = spawn("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-N", "-L", "15432:localhost:5432",
    SSH_HOST,
  ]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(proc), 3000); // ssh -N prints nothing on success
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`ssh tunnel exited early (code ${code})`)); });
  });
}

const tunnel = await openTunnel();

const client = new Client({ connectionString: env.DATABASE_URL });

try {
  await client.connect();
  await client.query(sql);
  console.log("Schema applied successfully.");
} catch (err) {
  console.error("Schema apply failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
  tunnel.kill();
}
