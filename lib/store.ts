// Local record of every payout (payouts.json, never committed).
// It is what stops PayBot from ever sending twice for the same payout.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { FILES } from "./config.ts";

export type Payout = {
  payoutId: string;            // the PAJ order id
  bank: { id: string; name: string };
  accountNumber: string;
  accountName: string;         // bank-verified
  ngn: number;
  usdc: number;                // what PAJ asked for, fee included
  rate?: number;
  fee?: number;
  address: string;             // PAJ deposit address for this order
  createdAt: string;
  requestId?: string;          // PayBox transfer request (set once, never replaced)
  requestedAt?: string;
  signedAt?: string;           // set just before our signature is submitted
  txHash?: string;
  payboxStatus?: string;
  pajStatus?: string;
  updatedAt?: string;
};

function load(): Record<string, Payout> {
  return existsSync(FILES.payouts) ? JSON.parse(readFileSync(FILES.payouts, "utf8")) : {};
}

export function getPayout(id: string): Payout | undefined {
  return load()[id];
}

export function savePayout(p: Payout) {
  const all = load();
  const before = all[p.payoutId];
  if (before?.requestId && p.requestId !== before.requestId) throw new Error("Refusing to replace a recorded PayBox request.");
  all[p.payoutId] = { ...p, updatedAt: new Date().toISOString() };
  const tmp = FILES.payouts + ".tmp";
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  renameSync(tmp, FILES.payouts);
}
