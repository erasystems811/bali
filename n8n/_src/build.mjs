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

// Webhook variant that waits for a "Respond to Webhook" node instead of
// responding immediately -- used for internal sub-workflows (e.g. PDF
// rendering) where the caller needs the actual result back synchronously.
function webhookNodeSync(name, webhookPath, webhookId, position) {
  return {
    parameters: { httpMethod: "POST", path: webhookPath, responseMode: "responseNode", options: {} },
    name,
    type: "n8n-nodes-base.webhook",
    typeVersion: 2.1,
    position,
    webhookId,
  };
}

function httpRequestNode(name, parameters, position) {
  return {
    parameters,
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
  };
}

function respondToWebhookNode(name, parameters, position) {
  return {
    parameters,
    name,
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.2,
    position,
  };
}

function writeWorkflow(fileName, workflowName, triggerNode, codeNodeDef) {
  writeMultiTriggerWorkflow(fileName, workflowName, [[triggerNode, codeNodeDef]]);
}

// chains: array of independent node sequences -- each sequence is its own
// unconnected flow within the same workflow (e.g. a Schedule Trigger for a
// recurring job alongside a Webhook Trigger for on-demand calls), connected
// node-to-node in the order given. A chain can be any length (2+ nodes),
// not just [trigger, codeNode] pairs -- e.g. a small internal sub-workflow
// like [webhook, code, httpRequest, respond].
function writeMultiTriggerWorkflow(fileName, workflowName, chains) {
  const nodes = chains.flat();
  const connections = {};
  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      connections[chain[i].name] = { main: [[{ node: chain[i + 1].name, type: "main", index: 0 }]] };
    }
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
    // Internal sub-workflow: renders HTML to PDF via Gotenberg. Not called
    // directly by anything external -- stage3-4-action-code.js's renderPdf()
    // calls this webhook internally. Exists as its own node chain (instead of
    // a direct Gotenberg call from the Code node) because this n8n version's
    // Code-node helpers.httpRequest cannot correctly send multipart/form-data
    // (confirmed live via Gotenberg's own server logs -- every construction
    // attempt sent 0 bytes, mangled the buffer to ~100x the intended size, or
    // got the Content-Type/boundary wrong). The dedicated HTTP Request node
    // has mature native multipart/binary support and is confirmed working.
    [
      webhookNodeSync("Webhook", "bali-render-pdf", "bali-render-pdf", [-144, -144]),
      codeNode("Prepare Binary", "pdf-prepare-binary-code.js", [80, -144]),
      httpRequestNode(
        "Call Gotenberg",
        {
          method: "POST",
          url: "={{ $env.GOTENBERG_URL }}/forms/chromium/convert/html",
          sendBody: true,
          contentType: "multipart-form-data",
          bodyParameters: { parameters: [{ parameterType: "formBinaryData", name: "files", inputDataFieldName: "data" }] },
          options: { response: { response: { responseFormat: "file" } } },
        },
        [300, -144]
      ),
      respondToWebhookNode("Return PDF", { respondWith: "binary", options: {} }, [520, -144]),
    ],
    // Internal sub-workflow: uploads a PDF buffer to Meta's media library and
    // returns the media id. Same reason as the PDF-render chain above --
    // stage3-4-action-code.js's uploadWhatsAppMedia() calls this webhook
    // internally instead of doing the multipart upload directly.
    [
      webhookNodeSync("Upload Media Webhook", "bali-upload-media", "bali-upload-media", [-144, -360]),
      codeNode("Prepare Media Binary", "media-prepare-binary-code.js", [80, -360]),
      httpRequestNode(
        "Upload to Meta",
        {
          method: "POST",
          url: "=https://graph.facebook.com/v20.0/{{ $env.META_PHONE_NUMBER_ID }}/media",
          sendHeaders: true,
          headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $env.META_ACCESS_TOKEN }}" }] },
          sendBody: true,
          contentType: "multipart-form-data",
          bodyParameters: {
            parameters: [
              { parameterType: "formData", name: "messaging_product", value: "whatsapp" },
              { parameterType: "formData", name: "type", value: "application/pdf" },
              { parameterType: "formBinaryData", name: "file", inputDataFieldName: "data" },
            ],
          },
        },
        [300, -360]
      ),
      respondToWebhookNode("Return Media Id", { respondWith: "json", responseBody: "={{ $json }}", options: {} }, [520, -360]),
    ],
  ]
);
