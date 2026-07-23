// Assembles n8n workflow JSON files from the plain-JS files in this folder.
// Building via JSON.stringify avoids hand-escaping mistakes in the raw JSON files.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dir, "..");

function codeNode(name, jsFile, position) {
  return {
    parameters: { mode: "runOnceForAllItems", jsCode: readFileSync(path.join(dir, jsFile), "utf8") },
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
  };
}

function webhookNode(name, webhookPath, webhookId, position) {
  return {
    parameters: { httpMethod: "POST", path: webhookPath, responseMode: "onReceived", options: {} },
    name,
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position,
    webhookId,
  };
}

function scheduleNode(name, position, { field, interval }) {
  return {
    parameters: { rule: { interval: [{ field, [`${field}Interval`]: interval }] } },
    name,
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position,
  };
}

function writeWorkflow(fileName, workflowName, triggerNode, codeNodeDef) {
  writeMultiTriggerWorkflow(fileName, workflowName, [[triggerNode, codeNodeDef]]);
}

// chains: array of independent [triggerNode, codeNodeDef] pairs -- each pair
// is its own unconnected flow within the same workflow (e.g. a Schedule
// Trigger for a recurring job alongside a Webhook Trigger for on-demand calls).
function writeMultiTriggerWorkflow(fileName, workflowName, chains) {
  const nodes = chains.flatMap(([t, c]) => [t, c]);
  const connections = {};
  for (const [t, c] of chains) {
    connections[t.name] = { main: [[{ node: c.name, type: "main", index: 0 }]] };
  }
  const workflow = { name: workflowName, nodes, connections, active: false, settings: { executionOrder: "v1" } };
  writeFileSync(path.join(outDir, fileName), JSON.stringify(workflow, null, 2) + "\n");
  console.log("Wrote", fileName);
}

writeWorkflow(
  "02-stage1-sales-flow.json",
  "Bali - 02 Stage 1 Sales Flow",
  webhookNode("Stage1 Trigger", "stage1-sales-flow", "bali-stage1-sales-flow", [-200, 0]),
  codeNode("Handle Stage 1 Message", "stage1-code.js", [40, 0])
);

writeWorkflow(
  "03-pm-toggle.json",
  "Bali - 03 PM Toggle",
  webhookNode("PM Toggle Trigger", "pm-toggle", "bali-pm-toggle", [-200, 0]),
  codeNode("Handle PM Message", "pm-toggle-code.js", [40, 0])
);

writeWorkflow(
  "04-kb-check.json",
  "Bali - 04 KB Check",
  webhookNode("KB Trigger", "kb-check", "bali-kb-check", [-200, 0]),
  codeNode("Handle KB Action", "kb-check-code.js", [40, 0])
);

writeWorkflow(
  "05-stage5-fanout.json",
  "Bali - 05 Stage 5 Fan-Out",
  scheduleNode("Every 5 Minutes", [-200, 0], { field: "minutes", interval: 5 }),
  codeNode("Fan Out Signed Bookings", "stage5-fanout-code.js", [40, 0])
);

writeMultiTriggerWorkflow(
  "99-stage3-4-invoice-contract.json",
  "Bali - 99 Stage 3-4 Invoice & Contract",
  [
    [scheduleNode("Every Hour", [-200, 0], { field: "hours", interval: 1 }), codeNode("Lawyer 24h Nudge", "stage3-4-nudge-code.js", [40, 0])],
    [webhookNode("Stage3-4 Trigger", "stage3-4", "bali-stage3-4", [-200, 220]), codeNode("Handle Stage 3-4 Action", "stage3-4-action-code.js", [40, 220])],
  ]
);
