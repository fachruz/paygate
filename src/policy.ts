// PayGate policy engine.
//
// A pure, deterministic function: the same proposal + config always yields
// the same decision. No I/O, no randomness, no clock access — timestamps and
// persistence live in receipts.ts / server.ts, never here.
//
// Five rule families (see the project README / concept doc):
//   1. Recipient-type check — an EOA posing as a staking/pool contract.
//   2. Blocklist + lookalike addresses.
//   3. Value limits — per-transaction and rolling budget.
//   4. Memo / metadata red-flag screening (incl. claimed-name mismatch).
//   5. First-seen recipient + large amount.
//
// The verdict is the most severe hit: BLOCK > REVIEW > APPROVE.
// This is a heuristic screen, not a guarantee: it cannot prove a recipient
// is honest, it can only catch known-dangerous shapes.

export type Verdict = "APPROVE" | "REVIEW" | "BLOCK";
export type RecipientKind = "eoa" | "contract";

export interface PaymentProposal {
  /** Destination address (0x… for EVM). Compared case-insensitively. */
  recipient: string;
  /** Whether the recipient is a personal wallet (EOA) or a contract. */
  recipientKind: RecipientKind;
  /** True when the recipient contract is a known, verified contract. */
  verifiedContract?: boolean;
  /** True when this recipient has never been paid before. */
  firstSeen?: boolean;
  /** Amount in `asset` units. */
  amount: number;
  /** Asset symbol, e.g. "ETH", "stETH", "USDC". */
  asset: string;
  /** USD value of the payment; limit checks use this (defaults to `amount`). */
  valueUsd?: number;
  /** What the payment claims to be, e.g. "staking deposit". */
  claimedContext?: string;
  /** Protocol the counterparty claims to represent, e.g. "Puffer Finance". */
  claimedProtocol?: string;
  /** Name of the site/page asking for the payment, e.g. "Puffin". */
  siteName?: string;
  /** Free-text memo / metadata supplied by the counterparty. */
  memo?: string;
  /** USD already spent inside the rolling window (for family 3). */
  spentLast24hUsd?: number;
}

export interface PolicyConfig {
  /** A single payment above this USD value goes to human REVIEW. */
  perTxReviewLimitUsd: number;
  /** Rolling-window budget in USD; crossing it goes to human REVIEW. */
  rollingBudgetUsd: number;
  /** "Large amount" threshold in USD for family 5. */
  largeAmountUsd: number;
  /** Addresses reported as scams. Matching is case-insensitive. */
  blocklist: string[];
  /** Known-good addresses that scammers imitate (family 2 lookalike check). */
  trustedAddresses: string[];
}

export const DEFAULT_CONFIG: PolicyConfig = {
  perTxReviewLimitUsd: 1000,
  rollingBudgetUsd: 2500,
  largeAmountUsd: 500,
  blocklist: [],
  trustedAddresses: [],
};

export interface RuleHit {
  family: 1 | 2 | 3 | 4 | 5;
  code: string;
  severity: Verdict;
  explanation: string;
}

export interface Decision {
  verdict: Verdict;
  hits: RuleHit[];
  /** Human-readable summary of why this verdict was reached. */
  explanation: string;
}

const SEVERITY_RANK: Record<Verdict, number> = { APPROVE: 0, REVIEW: 1, BLOCK: 2 };

function valueOf(p: PaymentProposal): number {
  return p.valueUsd ?? p.amount;
}

function normalizeAddress(a: string): string {
  return a.trim().toLowerCase();
}

// ---------------------------------------------------------------- family 1
// The founding fraud pattern: a page claims the payment is a deposit into a
// staking/pool CONTRACT, but the destination is a personal wallet (EOA) and
// the "deposit" is a plain, irreversible transfer. No contract is called, no
// receipt token is issued.

const CONTRACT_CLAIM_PATTERN =
  /\b(staking|stake|staked|pool|vault|farming|yield|smart contract)\b/i;

function family1RecipientType(p: PaymentProposal): RuleHit[] {
  if (p.recipientKind !== "eoa") return [];
  const ctx = p.claimedContext ?? "";
  if (!CONTRACT_CLAIM_PATTERN.test(ctx)) return [];
  return [
    {
      family: 1,
      code: "EOA_POSED_AS_CONTRACT",
      severity: "BLOCK",
      explanation:
        `The payment claims to be "${ctx}", which should go to a smart ` +
        `contract, but the recipient is a personal wallet (EOA). A plain ` +
        `transfer to an EOA is not a deposit: no contract is called, no ` +
        `receipt token is issued, and the transfer cannot be reversed. ` +
        `This is the classic fake-staking pattern.`,
    },
  ];
}

// ---------------------------------------------------------------- family 2

function family2BlocklistAndLookalike(
  p: PaymentProposal,
  cfg: PolicyConfig,
): RuleHit[] {
  const hits: RuleHit[] = [];
  const recipient = normalizeAddress(p.recipient);

  if (cfg.blocklist.some((b) => normalizeAddress(b) === recipient)) {
    hits.push({
      family: 2,
      code: "BLOCKLISTED_RECIPIENT",
      severity: "BLOCK",
      explanation:
        "The recipient address is on the blocklist of reported scam addresses.",
    });
  }

  // Lookalike / address-poisoning check: same length, identical opening and
  // closing characters as a trusted address, but not the address itself.
  for (const trustedRaw of cfg.trustedAddresses) {
    const trusted = normalizeAddress(trustedRaw);
    if (recipient === trusted) continue;
    if (recipient.length !== trusted.length || recipient.length < 14) continue;
    const sharesPrefix = recipient.slice(0, 8) === trusted.slice(0, 8);
    const sharesSuffix = recipient.slice(-6) === trusted.slice(-6);
    if (sharesPrefix && sharesSuffix) {
      hits.push({
        family: 2,
        code: "LOOKALIKE_ADDRESS",
        severity: "BLOCK",
        explanation:
          `The recipient imitates a trusted address: it shares the trusted ` +
          `address's opening and closing characters but is a different ` +
          `address. Funds sent there do not reach the trusted party.`,
      });
      break;
    }
  }
  return hits;
}

// ---------------------------------------------------------------- family 3

function family3ValueLimits(p: PaymentProposal, cfg: PolicyConfig): RuleHit[] {
  const hits: RuleHit[] = [];
  const value = valueOf(p);

  if (value > cfg.perTxReviewLimitUsd) {
    hits.push({
      family: 3,
      code: "OVER_PER_TX_LIMIT",
      severity: "REVIEW",
      explanation:
        `The payment value ($${value}) is above the per-transaction review ` +
        `limit ($${cfg.perTxReviewLimitUsd}), so a human should approve it. ` +
        `This is a size check, not an accusation.`,
    });
  }

  const spent = p.spentLast24hUsd ?? 0;
  if (spent + value > cfg.rollingBudgetUsd) {
    hits.push({
      family: 3,
      code: "OVER_ROLLING_BUDGET",
      severity: "REVIEW",
      explanation:
        `Together with the $${spent} already spent in the current window, ` +
        `this payment would cross the rolling budget of ` +
        `$${cfg.rollingBudgetUsd}, so a human should approve it.`,
    });
  }
  return hits;
}

// ---------------------------------------------------------------- family 4

const GAS_FIRST_PATTERN =
  /\b(send|transfer|kirim|pay)\b[^.!?]{0,60}\b(gas|fee|biaya)\b[^.!?]{0,30}\b(first|dulu|before|sebelum)\b|\b(gas|fee)\b[^.!?]{0,20}\b(first|dulu)\b/i;
const URGENCY_PATTERN =
  /\b(urgent|urgently|immediately|act now|hurry|limited time|expires?|expiring|deadline|segera|cepat|buruan|jangan sampai|sekarang juga)\b/i;
const PRIZE_PATTERN =
  /\b(prize|giveaway|winner|won|airdrop|hadiah|menang|bonus)\b/i;
const GUARANTEED_PATTERN =
  /\b(guaranteed|guarantee|double your|risk[- ]?free|pasti untung|pasti profit|lipat ganda)\b/i;

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(finance|protocol|app|official|site|io|xyz|com|net|fi)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function family4MemoScreening(p: PaymentProposal): RuleHit[] {
  const hits: RuleHit[] = [];
  const memo = p.memo ?? "";

  if (GAS_FIRST_PATTERN.test(memo)) {
    hits.push({
      family: 4,
      code: "SEND_GAS_FIRST",
      severity: "BLOCK",
      explanation:
        `The memo asks for a gas/fee payment to be sent first. Legitimate ` +
        `protocols never need a separate "gas first" transfer from the ` +
        `user — this is a well-known advance-fee scam step.`,
    });
  }
  if (URGENCY_PATTERN.test(memo)) {
    hits.push({
      family: 4,
      code: "ARTIFICIAL_URGENCY",
      severity: "REVIEW",
      explanation:
        "The memo uses artificial urgency (act now / limited time / segera). " +
        "Pressure to skip checking is itself a red flag.",
    });
  }
  if (PRIZE_PATTERN.test(memo)) {
    hits.push({
      family: 4,
      code: "PRIZE_LURE",
      severity: "REVIEW",
      explanation:
        "The memo dangles a prize, giveaway or winnings. Unsolicited prizes " +
        "attached to a payment request are a common lure.",
    });
  }
  if (GUARANTEED_PATTERN.test(memo)) {
    hits.push({
      family: 4,
      code: "GUARANTEED_RETURN_CLAIM",
      severity: "REVIEW",
      explanation:
        "The memo promises guaranteed or doubled returns. No legitimate " +
        "staking or investment product can guarantee returns.",
    });
  }

  // Several independent red flags in one memo escalate to a block.
  if (hits.length >= 2) {
    hits.push({
      family: 4,
      code: "MULTIPLE_RED_FLAGS",
      severity: "BLOCK",
      explanation:
        "The memo stacks multiple independent red flags at once, which is " +
        "characteristic of scripted scam pages rather than real protocols.",
    });
  }

  // Claimed-name mismatch: the page name does not match the protocol it
  // claims to be (e.g. a site called "Puffin" claiming to be Puffer Finance).
  if (p.claimedProtocol && p.siteName) {
    const claimed = normalizeName(p.claimedProtocol);
    const site = normalizeName(p.siteName);
    const claimedCore = claimed.split(" ")[0] ?? "";
    if (
      claimedCore.length >= 3 &&
      !site.includes(claimedCore) &&
      !claimed.includes(site.split(" ")[0] ?? "")
    ) {
      hits.push({
        family: 4,
        code: "NAME_MISMATCH",
        severity: "REVIEW",
        explanation:
          `The site calls itself "${p.siteName}" but claims to be ` +
          `"${p.claimedProtocol}". A name that merely sounds like a real ` +
          `protocol is a hallmark of clone/phishing pages.`,
      });
    }
  }
  return hits;
}

// ---------------------------------------------------------------- family 5

function family5NewRecipientLarge(
  p: PaymentProposal,
  cfg: PolicyConfig,
): RuleHit[] {
  const value = valueOf(p);
  if (p.firstSeen === true && value >= cfg.largeAmountUsd) {
    return [
      {
        family: 5,
        code: "NEW_RECIPIENT_LARGE_AMOUNT",
        severity: "REVIEW",
        explanation:
          `This recipient has never been paid before and the amount ` +
          `($${value}) is large. First payments to a new address deserve a ` +
          `human check (or a small test payment first).`,
      },
    ];
  }
  return [];
}

// ------------------------------------------------------------------ engine

export function evaluateProposal(
  proposal: PaymentProposal,
  config: PolicyConfig = DEFAULT_CONFIG,
): Decision {
  const hits: RuleHit[] = [
    ...family1RecipientType(proposal),
    ...family2BlocklistAndLookalike(proposal, config),
    ...family3ValueLimits(proposal, config),
    ...family4MemoScreening(proposal),
    ...family5NewRecipientLarge(proposal, config),
  ];

  let verdict: Verdict = "APPROVE";
  for (const hit of hits) {
    if (SEVERITY_RANK[hit.severity] > SEVERITY_RANK[verdict]) {
      verdict = hit.severity;
    }
  }

  const explanation =
    hits.length === 0
      ? "No policy rule raised a concern: the recipient type matches the " +
        "claimed purpose, the address is not flagged, the memo is clean, " +
        "and the amount is within limits. (Heuristic screen — not a " +
        "guarantee that the recipient is honest.)"
      : hits.map((h) => `[${h.code}] ${h.explanation}`).join(" ");

  return { verdict, hits, explanation };
}
