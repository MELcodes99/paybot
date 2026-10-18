// Pay Telegram users from any PayBox agent (Claude, Grok, ...), not just inside the bot.
//   resolve: @username -> the PayBox Solana wallet that person connected to the PayBot bot
//   notify:  after the agent pays, tell the recipient on Telegram, but only for a real,
//            confirmed USDC payment into that person's wallet (checked on-chain).
// Same rules as /pay in the bot: only connected users are findable, and the handle is checked
// against Telegram right now, because usernames can change hands.
import { SOLANA_RPC, USDC_MINT } from "./config.ts";
import type { BotStore } from "./bot-store.ts";

export type Profile = { username?: string; first_name?: string; last_name?: string };
export type TgDeps = {
  store: BotStore;
  getChat: (telegramId: number) => Promise<Profile>;
  sendMessage: (telegramId: number, html: string) => Promise<unknown>;
  getTransaction?: (signature: string) => Promise<any>;
  botUsername?: string;
  notified?: { has(sig: string): Promise<boolean> | boolean; add(sig: string): Promise<void> | void };
};

const HANDLE = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/;
const nameOf = (p: Profile) => [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || undefined;
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const cleanHandle = (u: unknown) => (typeof u === "string" ? u.trim().match(HANDLE)?.[1].toLowerCase() : undefined);

export type ResolveResult =
  | { found: true; username: string; name?: string; chain: "solana:mainnet"; token: string; address: string }
  | { found: false; username?: string; reason: string };

export async function resolveTelegram(d: TgDeps, username: unknown): Promise<ResolveResult> {
  const handle = cleanHandle(username);
  if (!handle) return { found: false, reason: "That isn't a valid Telegram username (5 to 32 letters, digits or underscores, starting with a letter)." };
  const rec = await d.store.findHandle(handle);
  const user = rec ? await d.store.getUser(rec.telegramId) : undefined;
  if (!rec || !user?.walletAddress) {
    return { found: false, username: handle, reason: `@${handle} hasn't connected a PayBox wallet to PayBot on Telegram. Ask them to open ${d.botUsername ? `t.me/${d.botUsername}` : "the PayBot Telegram bot"} and send /connect.` };
  }
  let profile: Profile;
  try { profile = await d.getChat(rec.telegramId); }
  catch { return { found: false, username: handle, reason: `@${handle} can't be reached on Telegram right now (they may have blocked PayBot), so their wallet can't be confirmed.` }; }
  if (profile.username?.toLowerCase() !== handle) {
    await d.store.saveHandle(rec.telegramId, profile.username, nameOf(profile));
    return { found: false, username: handle, reason: `@${handle} no longer belongs to the PayBot user known by that name. Ask for their current username.` };
  }
  return { found: true, username: handle, name: nameOf(profile), chain: "solana:mainnet", token: USDC_MINT, address: user.walletAddress };
}

async function rpcTransaction(signature: string) {
  const r = await fetch(SOLANA_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`Solana RPC: ${j.error.message}`);
  return j.result;
}

// How much USDC this transaction added to `owner`'s balance (0 if none, or if it failed).
export function usdcReceived(tx: any, owner: string): number {
  if (!tx?.meta || tx.meta.err) return 0;
  const sum = (list: any[] = []) => list.filter((b) => b.mint === USDC_MINT && b.owner === owner)
    .reduce((a, b) => a + BigInt(b.uiTokenAmount?.amount ?? "0"), 0n);
  const delta = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  return delta > 0n ? Number(delta) / 1e6 : 0;
}

export type NotifyResult = { notified: boolean; reason?: string; usdc?: number };

export async function notifyTelegram(d: TgDeps, body: { username?: unknown; signature?: unknown; note?: unknown }): Promise<NotifyResult> {
  const sig = typeof body.signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(body.signature.trim()) ? body.signature.trim() : undefined;
  if (!sig) return { notified: false, reason: "Pass the Solana transaction signature of the payment as `signature`." };
  const r = await resolveTelegram(d, body.username);
  if (!r.found) return { notified: false, reason: r.reason };
  if (await d.notified?.has(sig)) return { notified: false, reason: "This payment was already announced." };
  const tx = await (d.getTransaction ?? rpcTransaction)(sig);
  if (!tx) return { notified: false, reason: "That transaction isn't confirmed on Solana yet. Try again in a few seconds." };
  const usdc = usdcReceived(tx, r.address);
  if (!usdc) return { notified: false, reason: `That transaction didn't pay USDC into @${r.username}'s PayBox wallet.` };
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 100) : "";
  await d.notified?.add(sig);
  await d.sendMessage(Number((await d.store.findHandle(r.username))!.telegramId), [
    `💰 <b>You received ${+usdc.toFixed(6)} USDC!</b>`,
    ``,
    `🤖 Sent by a PayBox agent to your PayBox wallet <code>${r.address.slice(0, 4)}...${r.address.slice(-4)}</code>`,
    ...(note ? [`📝 ${esc(note)}`] : []),
    ``,
    `🔗 <a href="https://solscan.io/tx/${sig}">View on Solscan</a>`,
  ].join("\n"));
  return { notified: true, usdc };
}
