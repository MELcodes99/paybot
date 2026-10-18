// Pay another PayBot user in USDC, wallet to wallet on Solana. Both people connected their own
// PayBox wallet to the bot, so the recipient's address came from PayBox itself, never from a chat
// message. The money moves with the same checks as a naira payout: PayBox builds the transfer,
// we verify the plan pays exactly that amount to exactly that wallet, then sign once.
import { randomBytes } from "node:crypto";
import { toBaseUnits } from "./config.ts";
import {
  ACCOUNT_RENT_SOL, BASE_FEE_SOL, balances, hasUsdcAccount,
  requestTransfer, signPendingTransfer, solanaWallet,
} from "./paybox.ts";

export type Transfer = {
  transferId: string;      // 24 hex characters
  fromId: number;          // sender's Telegram id
  toId: number;            // recipient's Telegram id
  toHandle: string;        // recipient's @username when prepared (lowercase, no @)
  toName?: string;         // recipient's Telegram display name when prepared
  fromHandle?: string;     // sender's @username, for the recipient's receipt
  fromName?: string;
  fromAddress: string;     // sender's PayBox Solana wallet
  toAddress: string;       // recipient's PayBox Solana wallet
  usdc: number;
  note?: string;
  chatId: number;
  messageId?: number;
  createdAt: string;
  requestId?: string;      // PayBox transfer request (set once, never replaced)
  requestedAt?: string;
  signedAt?: string;       // set just before our signature is submitted
  txHash?: string;
  payboxStatus?: string;
  notifiedAt?: string;     // when the recipient was told
  updatedAt?: string;
};

export type TransferStore = {
  get(id: string): Promise<Transfer | undefined>;
  save(t: Transfer): Promise<void>;
};

export type TransferResult =
  | { status: "completed"; txHash?: string; explorer?: string }
  | { status: "needs_approval" }
  | { status: "processing" }
  | { status: "failed"; reason: string }
  | { status: "not_sent"; reason: string };

export const newTransferId = () => randomBytes(12).toString("hex");

const PAYBOX_WAIT_MS = 120_000;

export type TransferDeps = {
  solanaWallet: typeof solanaWallet;
  balances: typeof balances;
  hasUsdcAccount: typeof hasUsdcAccount;
  requestTransfer: typeof requestTransfer;
  signPendingTransfer: typeof signPendingTransfer;
};
const realDeps: TransferDeps = { solanaWallet, balances, hasUsdcAccount, requestTransfer, signPendingTransfer };

// Moves real money. Safe to call again with the same transfer: it resumes, never re-sends.
export async function sendTransfer(t: Transfer, ctx: { client: any; store: TransferStore; deps?: Partial<TransferDeps> }): Promise<TransferResult> {
  const d = { ...realDeps, ...ctx.deps };
  const { client, store } = ctx;
  const w = await d.solanaWallet(client);
  if (w.address !== t.fromAddress) {
    return { status: "not_sent", reason: "Your PayBox wallet changed since this payment was prepared. Nothing was sent. Send the /pay again." };
  }
  if (t.fromAddress === t.toAddress) return { status: "not_sent", reason: "That's your own wallet. Nothing was sent." };

  if (!t.requestId) {
    const bal = await d.balances(client, w.address);
    if (bal.usdc < t.usdc) {
      return { status: "not_sent", reason: `Your wallet has ${bal.usdc} USDC and this needs ${t.usdc}. Top up and try again. Nothing was sent.` };
    }
    const needSol = BASE_FEE_SOL * 2 + ((await d.hasUsdcAccount(t.toAddress)) ? 0 : ACCOUNT_RENT_SOL);
    if (bal.sol < needSol) {
      return { status: "not_sent", reason: `Your wallet has ${bal.sol} SOL and this needs about ${+needSol.toFixed(6)} SOL for network fees. Add a little SOL and try again. Nothing was sent.` };
    }
    const res = await d.requestTransfer(client, { credentialId: w.credentialId, to: t.toAddress, baseUnits: toBaseUnits(t.usdc) });
    if (!res?.request_id) {
      return { status: "not_sent", reason: `PayBox couldn't prepare the transfer: ${res?.message ?? "no reason given"}. Nothing was sent.` };
    }
    t.requestId = res.request_id; t.requestedAt = new Date().toISOString(); t.payboxStatus = res.status;
    await store.save(t);
  }

  const req = await client.getRequest(t.requestId);
  if (req.status === "pending_approval") {
    t.payboxStatus = req.status; await store.save(t);
    return { status: "needs_approval" };
  }
  // A request is a single transfer, so signing again is only allowed when an earlier signature
  // clearly never landed (still waiting 2+ minutes later).
  const staleSignature = t.signedAt && Date.now() - new Date(t.signedAt).getTime() > 120_000;
  if (req.status === "pending_signature" && (!t.signedAt || staleSignature)) {
    await d.signPendingTransfer(client, t.requestId!, { sender: w.address, recipient: t.toAddress, amountBaseUnits: toBaseUnits(t.usdc) }, async () => {
      t.signedAt = new Date().toISOString(); await store.save(t);
    });
  }
  const final = await client.waitForRequest(t.requestId, { intervalMs: 3000, timeoutMs: PAYBOX_WAIT_MS });
  t.payboxStatus = final.status;
  t.txHash = final.output?.value?.tx_hash ?? t.txHash;
  await store.save(t);
  if (final.status === "denied" || final.status === "error") {
    return { status: "failed", reason: final.status === "denied" ? "PayBox declined the transfer." : `PayBox reported an error${final.error ? `: ${final.error}` : ""}.` };
  }
  if (final.status !== "success") return { status: "processing" };
  return { status: "completed", txHash: t.txHash, explorer: t.txHash ? `https://solscan.io/tx/${t.txHash}` : undefined };
}
