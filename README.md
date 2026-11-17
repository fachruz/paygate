# PayGate — a payment guard for autonomous agents

**PayGate screens a proposed crypto payment before money moves.** Send it the
payment (recipient, amount, asset, claimed purpose, counterparty memo) and it
returns a decision — **APPROVE**, **REVIEW** (a human should look first), or
**BLOCK** — with plain-language reasons and a **hash-chained receipt** that
anyone can verify afterwards.

PayGate never holds funds and never signs transactions. It only decides and
explains; execution stays with the owner of the funds.

## Why this exists

The most common retail crypto fraud is disarmingly simple: a page claims to
be a staking/pool **contract**, but asks for a plain transfer to a **personal
wallet**. No contract is called, no receipt token is issued, and a plain
transfer cannot be reversed.

This project grows out of a real loss of exactly that shape: in February
2024 the founder lost ±0.042 stETH + 0.012 ETH to a clone page of a
one-week-old staking project (a site calling itself "Puffin" while claiming
to be a real protocol). Demo preset 1 reconstructs that payment — PayGate
blocks it.

## How it works

`POST /decide` runs a deterministic policy engine (pure function: same
input, same decision) with five rule families:

1. **Recipient-type check** — a personal wallet (EOA) claiming to be a
   staking/pool contract deposit is **BLOCK**ed. This is the founding fraud
   pattern.
2. **Blocklist + lookalike addresses** — reported scam addresses are
   **BLOCK**ed; addresses that imitate a trusted address (same opening and
   closing characters, different middle) are **BLOCK**ed.
3. **Value limits** — a payment above the per-transaction limit, or one that
   crosses the rolling budget, goes to **REVIEW** (human approval queue).
   A size check, not an accusation.
4. **Memo / metadata red flags** — "send gas first", artificial urgency,
   prize lures, guaranteed-return claims → **REVIEW**/**BLOCK**; a site name
   that doesn't match the protocol it claims to be → **REVIEW**.
5. **First-seen recipient + large amount** → **REVIEW** (or make a small
   test payment first).

The verdict is the most severe rule hit: BLOCK > REVIEW > APPROVE.

### Verifiable receipts

Every decision appends a receipt to a SHA-256 hash chain: each receipt
embeds the previous receipt's hash, so editing, deleting or reordering any
past decision breaks verification of everything after it. `GET /receipts`
returns the chain and its validity; the verification algorithm is in
`src/receipts.ts` and can be re-implemented independently. (Anchoring the
chain head to zkVerify as a proof is an honest optional next step — for this
entry the chain stands on its own and is fully open.)

## Endpoints

| Route          | What it does                                            |
| -------------- | ------------------------------------------------------- |
| `GET /`        | Landing + demo page with preset scenarios and a form    |
| `GET /health`  | Liveness, receipt count, chain validity                 |
| `GET /presets` | The demo scenarios as JSON                              |
| `POST /decide` | Screen a proposal → `{ decision, receipt }`             |
| `GET /receipts`| All receipts + `valid` flag for the chain               |

Example:

```bash
curl -X POST https://<your-host>/decide \
  -H 'content-type: application/json' \
  -d '{
    "recipient": "0x0000000000000000000000000000000000000bad",
    "recipientKind": "eoa",
    "amount": 0.042173,
    "asset": "stETH",
    "valueUsd": 105,
    "claimedContext": "staking deposit",
    "claimedProtocol": "Puffer Finance",
    "siteName": "Puffin"
  }'
# -> decision.verdict == "BLOCK", code EOA_POSED_AS_CONTRACT (+ NAME_MISMATCH)
```

## Run it locally

Requires Node ≥ 22.18 (the code is TypeScript run directly by Node; there
are **no runtime dependencies**).

```bash
npm test          # unit tests: every rule family + the receipt chain
npm start         # serves on $PORT (default 8787)
```

## Honest limits

- PayGate is a **heuristic screen, not a guarantee**. It catches
  known-dangerous shapes; it cannot prove a recipient is honest, and a
  novel scam shape can pass it.
- Recipient type (EOA vs contract) and "verified contract" status are
  inputs supplied by the caller in this version; wiring them to live chain
  lookups is future work.
- Hosted on a free tier: the first request after idle can take ±30–50 s
  while the service wakes up.

## Build context (declared openly)

The code in this repository was written fresh for the zkVerify Agent Games
(build window 17–19 Nov 2026). The policy-engine *pattern* — deterministic
rules, severity ladder, human-approval queue for mid-tier risk — is adapted
from the author's two earlier hackathon projects, **Gatekeeper** (an agent
payment guard on NEAR) and **KiteGuard** (an agent shopping guard for the
OpenServ/Kite hackathon). No code was copied; the rules, receipts and
service here are new, and the founding story (the Feb 2024 fake-staking
loss) is the author's own.
