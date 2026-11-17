import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateProposal,
  DEFAULT_CONFIG,
  type PaymentProposal,
  type PolicyConfig,
} from "../src/policy.ts";

const cfg = (overrides: Partial<PolicyConfig> = {}): PolicyConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
});

// ------------------------------------------------------------- plan case 1
test("founder case: plain transfer to an EOA claiming 'staking deposit' is BLOCKED (family 1)", () => {
  // Reconstruction of the Feb 2024 fake-staking loss: a clone page of a
  // one-week-old staking project asked for a plain stETH transfer to a
  // personal wallet. No contract call, no receipt token, irreversible.
  const proposal: PaymentProposal = {
    recipient: "0x0000000000000000000000000000000000000bad",
    recipientKind: "eoa",
    firstSeen: true,
    amount: 0.042173,
    asset: "stETH",
    valueUsd: 105,
    claimedContext: "staking deposit",
    claimedProtocol: "Puffer Finance",
    siteName: "Puffin",
    memo: "Deposit now to secure your staking position and rewards.",
  };
  const decision = evaluateProposal(proposal, cfg());
  assert.equal(decision.verdict, "BLOCK");
  const hit = decision.hits.find((h) => h.code === "EOA_POSED_AS_CONTRACT");
  assert.ok(hit, "expected the family-1 hit");
  assert.equal(hit.family, 1);
});

// ------------------------------------------------------------- plan case 2
test("legit small deposit to a verified staking contract is APPROVED", () => {
  const decision = evaluateProposal(
    {
      recipient: "0x1111111111111111111111111111111111111111",
      recipientKind: "contract",
      verifiedContract: true,
      firstSeen: false,
      amount: 50,
      asset: "USDC",
      valueUsd: 50,
      claimedContext: "staking deposit",
    },
    cfg(),
  );
  assert.equal(decision.verdict, "APPROVE");
  assert.equal(decision.hits.length, 0);
});

// ------------------------------------------------------------- plan case 3
test("amount above the per-transaction limit is REVIEW, not BLOCK (family 3)", () => {
  const decision = evaluateProposal(
    {
      recipient: "0x2222222222222222222222222222222222222222",
      recipientKind: "contract",
      verifiedContract: true,
      firstSeen: false,
      amount: 5000,
      asset: "USDC",
      valueUsd: 5000,
      claimedContext: "supplier invoice payment",
    },
    cfg(),
  );
  assert.equal(decision.verdict, "REVIEW");
  assert.ok(decision.hits.some((h) => h.family === 3));
  assert.ok(decision.hits.every((h) => h.severity !== "BLOCK"));
});

test("crossing the rolling budget is REVIEW (family 3)", () => {
  const decision = evaluateProposal(
    {
      recipient: "0x2222222222222222222222222222222222222222",
      recipientKind: "eoa",
      firstSeen: false,
      amount: 300,
      asset: "USDC",
      valueUsd: 300,
      spentLast24hUsd: 2300,
      claimedContext: "vendor payment",
    },
    cfg(),
  );
  assert.equal(decision.verdict, "REVIEW");
  assert.ok(decision.hits.some((h) => h.code === "OVER_ROLLING_BUDGET"));
});

// ------------------------------------------------------------- plan case 4
test("'send gas first' prize memo is BLOCKED with a clear reason (family 4)", () => {
  const decision = evaluateProposal(
    {
      recipient: "0x3333333333333333333333333333333333333333",
      recipientKind: "eoa",
      firstSeen: true,
      amount: 25,
      asset: "USDC",
      valueUsd: 25,
      claimedContext: "prize claim fee",
      memo: "Congratulations, you are a giveaway winner! Send the gas fee " +
        "first to claim your prize — urgent, this expires immediately!",
    },
    cfg(),
  );
  assert.equal(decision.verdict, "BLOCK");
  const hit = decision.hits.find((h) => h.code === "SEND_GAS_FIRST");
  assert.ok(hit, "expected the family-4 gas-first hit");
  assert.equal(hit.family, 4);
  assert.ok(decision.explanation.includes("gas"));
});

test("site name that does not match the claimed protocol is REVIEW (family 4)", () => {
  const decision = evaluateProposal(
    {
      recipient: "0x5555555555555555555555555555555555555555",
      recipientKind: "contract",
      verifiedContract: false,
      firstSeen: false,
      amount: 50,
      asset: "USDC",
      valueUsd: 50,
      claimedContext: "staking deposit",
      claimedProtocol: "Puffer Finance",
      siteName: "Puffin",
    },
    cfg(),
  );
  assert.equal(decision.verdict, "REVIEW");
  assert.deepEqual(
    decision.hits.map((h) => h.code),
    ["NAME_MISMATCH"],
  );
});

// ------------------------------------------------------------- plan case 5
test("first-seen recipient with a large amount is REVIEW (family 5)", () => {
  const decision = evaluateProposal(
    {
      recipient: "0x4444444444444444444444444444444444444444",
      recipientKind: "eoa",
      firstSeen: true,
      amount: 750,
      asset: "USDC",
      valueUsd: 750,
      claimedContext: "vendor payment",
    },
    cfg(),
  );
  assert.equal(decision.verdict, "REVIEW");
  assert.deepEqual(
    decision.hits.map((h) => h.code),
    ["NEW_RECIPIENT_LARGE_AMOUNT"],
  );
  assert.equal(decision.hits[0].family, 5);
});

// ---------------------------------------------------------------- family 2
test("blocklisted recipient is BLOCKED (family 2)", () => {
  const blocked = "0xbad0000000000000000000000000000000000001";
  const decision = evaluateProposal(
    {
      recipient: blocked,
      recipientKind: "eoa",
      firstSeen: false,
      amount: 100,
      asset: "USDC",
      valueUsd: 100,
      claimedContext: "investment deposit",
    },
    cfg({ blocklist: [blocked] }),
  );
  assert.equal(decision.verdict, "BLOCK");
  assert.ok(decision.hits.some((h) => h.code === "BLOCKLISTED_RECIPIENT"));
});

test("lookalike of a trusted address is BLOCKED; the real address is not (family 2)", () => {
  const trusted = "0x1234567890abcdef1234567890abcdef12345678";
  const lookalike = "0x123456" + "f".repeat(28) + "345678";
  assert.equal(lookalike.length, trusted.length);

  const config = cfg({ trustedAddresses: [trusted] });
  const base = {
    recipientKind: "eoa" as const,
    firstSeen: false,
    amount: 10,
    asset: "USDC",
    valueUsd: 10,
    claimedContext: "payment",
  };

  const bad = evaluateProposal({ ...base, recipient: lookalike }, config);
  assert.equal(bad.verdict, "BLOCK");
  assert.ok(bad.hits.some((h) => h.code === "LOOKALIKE_ADDRESS"));

  const good = evaluateProposal({ ...base, recipient: trusted }, config);
  assert.equal(good.verdict, "APPROVE");
});
