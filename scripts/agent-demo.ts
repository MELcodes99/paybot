// Plays the part of ANY PayBox agent using the live PayBot service. REAL MONEY.
// 1. Pays $0.01 (x402) to the hosted /prepare.  2. Shows the bank-verified name and cost, waits for yes.
// 3. Pays the USDC with PayBox request_transfer (checked + signed locally).  4. Polls the status link.
//
//   npm run agent -- Opay 8161859340 2000 "Somtochukwu Mel Okoye"
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ROOT, USDC_MINT } from "../lib/config.ts";
import { balances, paybox, requestTransfer, signPendingTransfer, solanaWallet } from "../lib/paybox.ts";

const SERVICE = (process.env.PAYBOT_URL || "https://paybot-562g.onrender.com").replace(/\/$/, "");
const LEDGER = join(ROOT, "agent-demo-payments.json");
const [bank, accountNumber, ngnArg, ...nameParts] = process.argv.slice(2);
const ngn = Number(ngnArg);
const expectedName = nameParts.join(" ") || undefined;
if (!bank || !accountNumber || !Number.isInteger(ngn) || ngn <= 0) {
  console.log('Usage: npm run agent -- <bank> <account number> <naira> ["recipient name"]');
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ask = async (q: string) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question(q); rl.close(); return a.trim(); };
const parse = (b: unknown) => { if (typeof b !== "string") return b; try { return JSON.parse(b); } catch { return b; } };

const client: any = await paybox();
const w = await solanaWallet(client);
const bal = await balances(client, w.address);
console.log(`Agent wallet ${w.address}: ${bal.usdc} USDC, ${bal.sol} SOL`);
console.log(`Service: ${SERVICE}\n`);

// ---- 1. Pay $0.01 to prepare the payout ----
console.log("1) Calling PayBot /prepare (pays $0.01 over x402)...");
const started = await client.useService({
  credentialId: w.credentialId, url: `${SERVICE}/prepare`, method: "POST",
  body: { bank, accountNumber, ngn, ...(expectedName ? { expectedName } : {}) },
});
let req = started.response;
if (req?.request_id && !["success", "error", "denied"].includes(req.status)) {
  req = await client.waitForRequest(req.request_id, { intervalMs: 2000, timeoutMs: 120_000 });
}
const value = req?.output?.value ?? {};
const httpStatus = value.resource?.status ?? value.response?.status;
const body: any = parse(value.resource?.body ?? value.response?.body);
const paidFee = value.payment?.status ?? value.payment?.ok;
console.log(`   PayBox request ${req?.request_id}: ${req?.status}; service answered ${httpStatus}; fee payment: ${JSON.stringify(paidFee)}`);
if (!body?.payoutId) {
  console.log("\nPayBot did not prepare a payout:", JSON.stringify(body ?? req, null, 2));
  process.exit(1);
}

// ---- 2. Check what came back and ask the human ----
if (body.pay?.chain !== "solana:mainnet" || body.pay?.token !== USDC_MINT || !/^\d+$/.test(body.pay?.amount ?? "")) {
  throw new Error("Unexpected payment instructions from the service. Not paying.");
}
console.log(`\n2) Bank-verified recipient: ${body.recipient.accountName}, ${body.recipient.bank} ${body.recipient.accountNumber}`);
console.log(`   ${body.confirm}`);
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {};
if (ledger[body.payoutId]) throw new Error(`Payout ${body.payoutId} was already paid. Not paying twice.`);
if ((await ask("   Type yes to pay: ")).toLowerCase() !== "yes") { console.log("Cancelled. Only the $0.01 fee was spent."); process.exit(0); }

// ---- 3. Pay the USDC once, with the transaction checked before signing ----
const amount = BigInt(body.pay.amount);
console.log(`\n3) Paying ${body.usdc} USDC to ${body.pay.to}...`);
const t = await requestTransfer(client, { credentialId: w.credentialId, to: body.pay.to, baseUnits: amount });
if (!t?.request_id) { console.log(`PayBox could not prepare the transfer: ${t?.message}. Nothing was moved.`); process.exit(1); }
ledger[body.payoutId] = { requestId: t.request_id, at: new Date().toISOString(), statusUrl: body.statusUrl };
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
if (t.status === "pending_signature") {
  const s = await signPendingTransfer(client, t.request_id, { sender: w.address, recipient: body.pay.to, amountBaseUnits: amount }, () => {});
  for (const n of s.notes) console.log(`   check passed: ${n}`);
}
const final = await client.waitForRequest(t.request_id, { intervalMs: 3000, timeoutMs: 120_000 });
const tx = final.output?.value?.tx_hash;
console.log(`   PayBox transfer: ${final.status}${tx ? `  https://solscan.io/tx/${tx}` : ""}`);
if (final.status !== "success") { console.log("Not confirmed yet. Do not pay again; check the status link:", body.statusUrl); process.exit(1); }

// ---- 4. Watch the payout ----
console.log("\n4) Watching the payout...");
let last = "";
for (let i = 0; i < 24; i++) {
  const s: any = await (await fetch(body.statusUrl)).json().catch(() => ({}));
  if (s.status && s.status !== last) { console.log(`   ${new Date().toLocaleTimeString()}  ${s.status}  ${s.note ?? ""}`); last = s.status; }
  if (s.done) { console.log(`\nDone. N${Number(body.ngn).toLocaleString("en-NG")} paid to ${body.recipient.accountName}.`); process.exit(0); }
  await sleep(5000);
}
console.log("\nStill processing. Do not pay again. Status link:", body.statusUrl);
