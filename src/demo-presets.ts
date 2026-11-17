// Demo scenarios for the PayGate landing page and manual testing.
// All addresses are synthetic (nobody's real wallet); amounts/contexts are
// modelled on documented scam shapes — preset 1 reconstructs the February
// 2024 fake-staking loss that motivated this project (a clone "staking" page
// asking for a plain transfer of stETH to a personal wallet).

import type { PaymentProposal } from "./policy.ts";

/** Synthetic address that the demo server config puts on the blocklist. */
export const DEMO_BLOCKLISTED_ADDRESS =
  "0xbad0000000000000000000000000000000000001";

export interface DemoPreset {
  id: string;
  title: string;
  description: string;
  proposal: PaymentProposal;
}

export const DEMO_PRESETS: DemoPreset[] = [
  {
    id: "fake-staking-2024",
    title: "Fake staking page (Feb 2024 reconstruction)",
    description:
      "A one-week-old staking project's clone page asks for a 'staking " +
      "deposit' of stETH — as a plain transfer to a personal wallet. This " +
      "is the exact shape of the founder's real Feb 2024 loss " +
      "(±0.042 stETH + 0.012 ETH). Expected: BLOCK.",
    proposal: {
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
    },
  },
  {
    id: "legit-staking-small",
    title: "Legit staking deposit, small amount",
    description:
      "A modest deposit to a verified staking contract. Expected: APPROVE.",
    proposal: {
      recipient: "0x1111111111111111111111111111111111111111",
      recipientKind: "contract",
      verifiedContract: true,
      firstSeen: false,
      amount: 50,
      asset: "USDC",
      valueUsd: 50,
      claimedContext: "staking deposit",
    },
  },
  {
    id: "over-limit-payment",
    title: "Large payment over the per-transaction limit",
    description:
      "A $5,000 payment to a known supplier — nothing scammy, just big. " +
      "Expected: REVIEW (human approval), not BLOCK.",
    proposal: {
      recipient: "0x2222222222222222222222222222222222222222",
      recipientKind: "contract",
      verifiedContract: true,
      firstSeen: false,
      amount: 5000,
      asset: "USDC",
      valueUsd: 5000,
      claimedContext: "supplier invoice payment",
    },
  },
  {
    id: "gas-first-lure",
    title: "'Send gas first' prize lure",
    description:
      "A memo promising a prize if a gas fee is sent first, wrapped in " +
      "urgency. Expected: BLOCK.",
    proposal: {
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
  },
  {
    id: "new-vendor-large",
    title: "First payment to a new vendor, large amount",
    description:
      "First-ever payment to a new address, $750. Expected: REVIEW.",
    proposal: {
      recipient: "0x4444444444444444444444444444444444444444",
      recipientKind: "eoa",
      firstSeen: true,
      amount: 750,
      asset: "USDC",
      valueUsd: 750,
      claimedContext: "vendor payment",
    },
  },
  {
    id: "blocklisted-address",
    title: "Reported scam address",
    description:
      "The recipient is on the blocklist of reported addresses. " +
      "Expected: BLOCK.",
    proposal: {
      recipient: DEMO_BLOCKLISTED_ADDRESS,
      recipientKind: "eoa",
      firstSeen: false,
      amount: 100,
      asset: "USDC",
      valueUsd: 100,
      claimedContext: "investment deposit",
    },
  },
];
