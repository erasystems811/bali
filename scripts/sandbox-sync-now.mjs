#!/usr/bin/env node
// Skips the cron wait (sandbox-sync.py on the droplet polls every 5 min) by
// pushing then triggering an immediate run over SSH. Requires the working
// tree to be clean and pushed -- this intentionally does NOT auto-commit,
// so commit granularity (and thus one-by-one undo via git revert) stays a
// deliberate choice, not something this script papers over.
import { execSync } from "node:child_process";

// Hetzner (bali-production), migrated 2026-08-01. The old DigitalOcean
// droplet (143.198.179.150) is rollback-only and no longer receives live
// traffic or code updates -- don't point this at it.
const DROPLET = "root@167.233.242.179";

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts });
}

function runInherit(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

const status = run("git status --porcelain").trim();
if (status) {
  console.error("Working tree has uncommitted changes -- commit (in as many separate commits as makes sense) before syncing:\n");
  console.error(status);
  process.exit(1);
}

const ahead = run("git rev-list --count origin/main..HEAD").trim();
if (ahead !== "0") {
  console.log(`Pushing ${ahead} commit(s) to origin/main...`);
  runInherit("git push origin main");
} else {
  console.log("Already up to date with origin/main -- triggering a sync anyway (in case a previous push hasn't synced yet).");
}

console.log("\nTriggering sandbox sync on the droplet...\n");
runInherit(`ssh -o StrictHostKeyChecking=no ${DROPLET} "python3 /opt/bali/sandbox-sync.py"`);
