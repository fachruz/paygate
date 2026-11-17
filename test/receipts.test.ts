import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateProposal, type PaymentProposal } from "../src/policy.ts";
import {
  ReceiptChain,
  verifyChain,
  GENESIS_HASH,
  type Receipt,
} from "../src/receipts.ts";

const proposalA: PaymentProposal = {
  recipient: "0x1111111111111111111111111111111111111111",
  recipientKind: "contract",
  verifiedContract: true,
  amount: 50,
  asset: "USDC",
  valueUsd: 50,
  claimedContext: "staking deposit",
};

const proposalB: PaymentProposal = {
  recipient: "0x0000000000000000000000000000000000000bad",
  recipientKind: "eoa",
  amount: 0.042173,
  asset: "stETH",
  valueUsd: 105,
  claimedContext: "staking deposit",
};

// ------------------------------------------------------------- plan case 6
test("second receipt chains to the first; tampering breaks verification", () => {
  const chain = new ReceiptChain();
  const r1 = chain.append(
    proposalA,
    evaluateProposal(proposalA),
    "2026-11-17T00:00:00.000Z",
  );
  const r2 = chain.append(
    proposalB,
    evaluateProposal(proposalB),
    "2026-11-17T00:01:00.000Z",
  );

  // Linkage: receipt 2 embeds receipt 1's hash; receipt 1 starts at genesis.
  assert.equal(r1.prevHash, GENESIS_HASH);
  assert.equal(r2.prevHash, r1.hash);
  assert.equal(r1.verdict, "APPROVE");
  assert.equal(r2.verdict, "BLOCK");
  assert.deepEqual(r2.codes, ["EOA_POSED_AS_CONTRACT"]);

  // The untouched chain verifies.
  assert.equal(chain.verify(), true);
  assert.equal(verifyChain(chain.list()), true);

  // Tampering with a stored decision breaks the chain.
  const tamperedVerdict = JSON.parse(
    JSON.stringify(chain.list()),
  ) as Receipt[];
  tamperedVerdict[0].verdict = "BLOCK";
  assert.equal(verifyChain(tamperedVerdict), false);

  // Tampering with a stored proposal amount also breaks the chain.
  const tamperedAmount = JSON.parse(JSON.stringify(chain.list())) as Receipt[];
  tamperedAmount[1].proposal.amount = 999;
  assert.equal(verifyChain(tamperedAmount), false);

  // Dropping the first receipt breaks linkage/index verification.
  assert.equal(verifyChain(chain.list().slice(1)), false);
});

test("hash is deterministic for identical inputs", () => {
  const a = new ReceiptChain();
  const b = new ReceiptChain();
  const ts = "2026-11-17T00:00:00.000Z";
  const ra = a.append(proposalA, evaluateProposal(proposalA), ts);
  const rb = b.append(proposalA, evaluateProposal(proposalA), ts);
  assert.equal(ra.hash, rb.hash);
});
