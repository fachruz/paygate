// Hash-chained decision receipts.
//
// Every PayGate decision produces a receipt. Each receipt embeds the SHA-256
// hash of the previous receipt, forming a chain: editing, deleting or
// reordering any past decision breaks verification of everything after it.
// Anyone holding the receipt list can verify the chain independently —
// no trust in this server is required.

import { createHash } from "node:crypto";
import type { Decision, PaymentProposal, Verdict } from "./policy.ts";

export interface Receipt {
  index: number;
  /** ISO-8601 timestamp supplied by the caller (kept outside the policy
   *  engine so policy evaluation stays deterministic). */
  timestamp: string;
  proposal: PaymentProposal;
  verdict: Verdict;
  /** Reason codes of the rule hits that produced the verdict ([] = clean). */
  codes: string[];
  prevHash: string;
  hash: string;
}

/** prevHash of the first receipt in any chain. */
export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: object keys sorted recursively, so two structurally
 *  equal values always hash identically regardless of key order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(record[k])).join(",") +
    "}"
  );
}

type ReceiptCore = Omit<Receipt, "hash">;

export function computeReceiptHash(core: ReceiptCore): string {
  return createHash("sha256").update(canonicalize(core), "utf8").digest("hex");
}

/** Verify a whole chain: index sequence, prevHash linkage, and every
 *  receipt's hash recomputed from its contents. */
export function verifyChain(receipts: Receipt[]): boolean {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (r.index !== i) return false;
    if (r.prevHash !== expectedPrev) return false;
    const { hash, ...core } = r;
    if (computeReceiptHash(core) !== hash) return false;
    expectedPrev = hash;
  }
  return true;
}

/** Append-only in-memory receipt chain (the server owns one instance). */
export class ReceiptChain {
  private receipts: Receipt[] = [];

  append(
    proposal: PaymentProposal,
    decision: Decision,
    timestamp: string,
  ): Receipt {
    // Normalize through JSON so the stored form is exactly the hashed form
    // (drops undefined fields, detaches the caller's object).
    const storedProposal = JSON.parse(
      JSON.stringify(proposal),
    ) as PaymentProposal;
    const core: ReceiptCore = {
      index: this.receipts.length,
      timestamp,
      proposal: storedProposal,
      verdict: decision.verdict,
      codes: decision.hits.map((h) => h.code),
      prevHash:
        this.receipts.length === 0
          ? GENESIS_HASH
          : this.receipts[this.receipts.length - 1].hash,
    };
    const receipt: Receipt = { ...core, hash: computeReceiptHash(core) };
    this.receipts.push(receipt);
    return receipt;
  }

  list(): Receipt[] {
    return [...this.receipts];
  }

  get length(): number {
    return this.receipts.length;
  }

  verify(): boolean {
    return verifyChain(this.receipts);
  }
}
