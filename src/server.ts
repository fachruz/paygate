// PayGate HTTP service.
//
//   GET  /          landing + demo page (preset scenarios, manual form)
//   GET  /health    liveness + receipt-chain status
//   GET  /presets   demo scenarios as JSON
//   POST /decide    screen a proposed payment -> decision + receipt
//   GET  /receipts  all decision receipts + chain validity
//
// PayGate never holds funds and never signs transactions. It only returns a
// decision (APPROVE / REVIEW / BLOCK), the reasons, and a hash-chained
// receipt that anyone can verify later.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  evaluateProposal,
  DEFAULT_CONFIG,
  type PaymentProposal,
  type PolicyConfig,
} from "./policy.ts";
import { ReceiptChain } from "./receipts.ts";
import { DEMO_PRESETS, DEMO_BLOCKLISTED_ADDRESS } from "./demo-presets.ts";

export interface PayGateService {
  chain: ReceiptChain;
  config: PolicyConfig;
}

export function createPayGateService(): PayGateService {
  return {
    chain: new ReceiptChain(),
    config: { ...DEFAULT_CONFIG, blocklist: [DEMO_BLOCKLISTED_ADDRESS] },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function validateProposal(raw: unknown): PaymentProposal | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object";
  const p = raw as Record<string, unknown>;
  if (typeof p.recipient !== "string" || p.recipient.length === 0)
    return "recipient (string) is required";
  if (p.recipientKind !== "eoa" && p.recipientKind !== "contract")
    return 'recipientKind must be "eoa" or "contract"';
  if (typeof p.amount !== "number" || !Number.isFinite(p.amount) || p.amount < 0)
    return "amount (non-negative number) is required";
  if (typeof p.asset !== "string" || p.asset.length === 0)
    return "asset (string) is required";
  return p as unknown as PaymentProposal;
}

const DEMO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PayGate — a payment guard for autonomous agents</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 46rem; padding: 0 1rem; line-height: 1.5; }
  .verdict { font-weight: 700; }
  .APPROVE { color: #137333; } .REVIEW { color: #b06000; } .BLOCK { color: #c5221f; }
  button { margin: .25rem .25rem .25rem 0; padding: .45rem .8rem; cursor: pointer; }
  pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  textarea, input, select { width: 100%; margin: .2rem 0 .6rem; padding: .4rem; }
  label { font-weight: 600; font-size: .9rem; }
</style>
</head>
<body>
<h1>PayGate</h1>
<p><strong>A payment guard that stands in front of a transfer.</strong>
Before money moves, the proposed payment is screened by a deterministic
policy engine. PayGate returns <span class="verdict APPROVE">APPROVE</span>,
<span class="verdict REVIEW">REVIEW</span> (a human should look) or
<span class="verdict BLOCK">BLOCK</span>, with plain-language reasons and a
hash-chained receipt anyone can verify. PayGate never holds funds and never
signs transactions.</p>
<p>Why: the most common retail crypto fraud is a page that claims to be a
staking/pool contract but asks for a plain transfer to a personal wallet —
no contract call, no receipt token, no way back. Preset 1 reconstructs a
real February 2024 loss of exactly that shape.</p>
<p><em>Honest limits: this is a heuristic screen, not a guarantee. It catches
known-dangerous shapes; it cannot prove a recipient is honest.</em></p>

<h2>Try a scenario</h2>
<div id="presets"></div>
<h2>Or screen your own proposal</h2>
<form id="manual">
  <label>Recipient address <input name="recipient" required value="0x0000000000000000000000000000000000000001"></label>
  <label>Recipient type
    <select name="recipientKind"><option value="eoa">Personal wallet (EOA)</option><option value="contract">Contract</option></select></label>
  <label>Amount <input name="amount" type="number" step="any" required value="100"></label>
  <label>Asset <input name="asset" required value="USDC"></label>
  <label>Claimed context <input name="claimedContext" value="payment"></label>
  <label>Memo from counterparty <textarea name="memo" rows="2"></textarea></label>
  <button type="submit">Screen this payment</button>
</form>
<h2>Result</h2>
<pre id="out">No decision yet.</pre>
<p>Receipt chain: <span id="chain">…</span> — see <a href="/receipts">/receipts</a>.</p>
<script>
async function decide(proposal) {
  const out = document.getElementById('out');
  out.textContent = 'Screening…';
  const res = await fetch('/decide', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(proposal) });
  const data = await res.json();
  out.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'verdict ' + (data.decision ? data.decision.verdict : '');
  span.textContent = data.decision ? data.decision.verdict : 'ERROR';
  out.appendChild(span);
  out.appendChild(document.createTextNode('\\n' + JSON.stringify(data, null, 2)));
  refreshChain();
}
async function refreshChain() {
  const res = await fetch('/receipts');
  const data = await res.json();
  document.getElementById('chain').textContent = data.count + ' receipt(s), chain valid: ' + data.valid;
}
fetch('/presets').then(r => r.json()).then(presets => {
  const box = document.getElementById('presets');
  for (const p of presets) {
    const b = document.createElement('button');
    b.textContent = p.title;
    b.title = p.description;
    b.onclick = () => decide(p.proposal);
    box.appendChild(b);
  }
});
document.getElementById('manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  decide({
    recipient: f.get('recipient'),
    recipientKind: f.get('recipientKind'),
    amount: Number(f.get('amount')),
    asset: f.get('asset'),
    valueUsd: Number(f.get('amount')),
    claimedContext: f.get('claimedContext'),
    memo: f.get('memo') || undefined,
  });
});
refreshChain();
</script>
</body>
</html>`;

export function createPayGateServer(service: PayGateService = createPayGateService()) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          service: "paygate",
          receipts: service.chain.length,
          chainValid: service.chain.verify(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/presets") {
        sendJson(res, 200, DEMO_PRESETS);
        return;
      }

      if (req.method === "GET" && url.pathname === "/receipts") {
        sendJson(res, 200, {
          count: service.chain.length,
          valid: service.chain.verify(),
          receipts: service.chain.list(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/decide") {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "body must be valid JSON" });
          return;
        }
        const proposal = validateProposal(parsed);
        if (typeof proposal === "string") {
          sendJson(res, 400, { error: proposal });
          return;
        }
        const decision = evaluateProposal(proposal, service.config);
        const receipt = service.chain.append(
          proposal,
          decision,
          new Date().toISOString(),
        );
        sendJson(res, 200, { decision, receipt });
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DEMO_PAGE);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  });
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  createPayGateServer().listen(port, () => {
    console.log(`PayGate listening on port ${port}`);
  });
}
