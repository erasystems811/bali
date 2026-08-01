#!/usr/bin/env node
// Pushes the built n8n workflow JSON to the REAL production n8n instance,
// over its public HTTPS API (N8N_PRODUCTION_URL + N8N_PRODUCTION_API_KEY in
// .env) -- no SSH into the droplet needed, unlike sandbox-sync-now.mjs.
// Requires the working tree to be clean and pushed, same convention as the
// sandbox script, so deploy granularity stays tied to real commits.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    if (line.includes("=") && !line.trim().startsWith("#")) {
      const idx = line.indexOf("=");
      env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return env;
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", cwd: ROOT, ...opts });
}
function runInherit(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

// Only the workflows production actually runs -- no 10-sandbox-ui.json.
const WORKFLOW_IDS = {
  "01-inbound-router.json": "WrIcsX1kuTlres8E",
  "02-stage1-sales-flow.json": "Ijz4XBeFDmmph6RW",
  "03-pm-toggle.json": "3DDmA34YYDV5DAOd",
  "04-kb-check.json": "lUtkh2KOzGLODksy",
  "05-stage5-fanout.json": "xZdzBBNwFuqXGzIa",
  "06-privacy-policy.json": "EhItizBYKluZvF0x",
  "99-stage3-4-invoice-contract.json": "L5mbUnBN0VZwkr8d",
};

function withoutId(nodes) {
  return nodes.map(({ id, ...rest }) => rest);
}

async function api(env, method, path, body) {
  const res = await fetch(`${env.N8N_PRODUCTION_URL}/api/v1${path}`, {
    method,
    headers: {
      "X-N8N-API-KEY": env.N8N_PRODUCTION_API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function main() {
  const status = run("git status --porcelain").trim();
  if (status) {
    console.error("Working tree has uncommitted changes -- commit before syncing:\n");
    console.error(status);
    process.exit(1);
  }

  const ahead = run("git rev-list --count origin/main..HEAD").trim();
  if (ahead !== "0") {
    console.log(`Pushing ${ahead} commit(s) to origin/main...`);
    runInherit("git push origin main");
  }

  console.log("\nRebuilding workflow JSON from _src...");
  runInherit("node n8n/_src/build.mjs");

  const env = loadEnv();
  if (!env.N8N_PRODUCTION_URL || !env.N8N_PRODUCTION_API_KEY) {
    console.error("Missing N8N_PRODUCTION_URL / N8N_PRODUCTION_API_KEY in .env");
    process.exit(1);
  }

  console.log("\nSyncing to production...\n");
  const changed = [], unchanged = [], failed = [];

  for (const [fname, wid] of Object.entries(WORKFLOW_IDS)) {
    const wf = JSON.parse(readFileSync(join(ROOT, "n8n", fname), "utf8"));
    let cur;
    try {
      cur = await api(env, "GET", `/workflows/${wid}`);
    } catch (e) {
      console.error(`${fname}: could not fetch current production state: ${e.message}`);
      failed.push(fname);
      continue;
    }

    const sameNodes = JSON.stringify(withoutId(cur.nodes)) === JSON.stringify(withoutId(wf.nodes));
    const sameConnections = JSON.stringify(cur.connections) === JSON.stringify(wf.connections);
    if (sameNodes && sameConnections) {
      unchanged.push(fname);
      continue;
    }

    const body = {
      name: cur.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: cur.settings || { executionOrder: "v1" },
    };

    try {
      const wasActive = cur.active;
      if (wasActive) await api(env, "POST", `/workflows/${wid}/deactivate`);
      await api(env, "PUT", `/workflows/${wid}`, body);
      if (wasActive) await api(env, "POST", `/workflows/${wid}/activate`);
      changed.push(fname);
    } catch (e) {
      console.error(`${fname}: update FAILED: ${e.message}`);
      failed.push(fname);
    }
  }

  console.log(`\nPRODUCTION sync complete -- changed: ${JSON.stringify(changed)} | unchanged: ${unchanged.length} | failed: ${JSON.stringify(failed)}`);
  if (failed.length) process.exit(1);
}

main();
