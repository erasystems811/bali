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
  const workflow = {
    name: workflowName,
    nodes: [triggerNode, codeNodeDef],
    connections: {
      [triggerNode.name]: { main: [[{ node: codeNodeDef.name, type: "main", index: 0 }]] },
    },
    active: false,
    settings: { executionOrder: "v1" },
  };
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

writeWorkflow(
  "99-stage3-4-invoice-contract.json",
  "Bali - 99 Stage 3-4 Stub (Lawyer Nudge)",
  scheduleNode("Every Hour", [-200, 0], { field: "hours", interval: 1 }),
  codeNode("Lawyer 24h Nudge", "stage3-4-stub-code.js", [40, 0])
);
