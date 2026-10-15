// PayBot step 2c: check and sign the PayBox transfer that is waiting for a signature. REAL MONEY.
// It does NOT create a new transfer. It finishes the one already recorded for this order.
import { PayboxClient } from "@paybox-sh/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { getSession, getTransaction, USDC_MINT } from "./lib/paj.ts";
import { checkTransferPlan } from "./lib/transfer-check.ts";
import { buildEnvelopes } from "./lib/sign-plan.ts";

const ORDER_ID = "6ad0d2fb372552a19a9ff36c";
const SOL_ADDR = "3YWrKex5whNtK5QeXaPGDrBZwcAqMsgRigxwFgA3kZ8M";
const LEDGER = "sent-requests.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (label: string, v: unknown) => console.log(`\n${label}:`, JSON.stringify(v, null, 2));
function toolJson(res: any) {
  if (res?.isError) throw new Error(res.content?.map((c: any) => c.text).join(" ") || "PayBox tool error");
  if (res?.structuredContent) return res.structuredContent;
  return JSON.parse(res?.content?.find((c: any) => c.type === "text")?.text ?? "null");
}

// 1) Find the request we already made. Never create a new one here.
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {};
const entry = ledger[ORDER_ID];
if (!entry?.requestId) throw new Error(`No PayBox request recorded for order ${ORDER_ID}. Ask Claude.`);
if (entry.signedAt) {
  console.log(`Already signed at ${entry.signedAt}. Not signing again. Checking status only.`);
}
const requestId: string = entry.requestId;
const client: any = await (PayboxClient as any).fromConfig();
const creds = client.signingCreds();
if (!creds) throw new Error("No local PayBox signing key found. Run the PayBox connect step first.");

// 2) The request must still be waiting for a signature.
let req = await client.getRequest(requestId);
console.log(`PayBox request ${requestId} is: ${req.status}`);
if (req.status !== "pending_signature" || entry.signedAt) {
  show("Request details", req);
  console.log("\nNothing to sign. Paste this to Claude.");
  process.exit(0);
}

// 3) The PAJ order must still be unpaid.
const token = await getSession();
const order = await getTransaction(token, ORDER_ID);
if (order.status !== "INIT") throw new Error(`PAJ order is ${order.status}, not INIT. Not signing.`);
if (order.chain !== "SOLANA" || order.mint !== USDC_MINT) throw new Error("PAJ order is not Solana USDC.");
const amount = BigInt(Math.round(Number(order.amount) * 1_000_000));
const expect = { sender: SOL_ADDR, recipient: order.address, amountBaseUnits: amount };

// 4) Get the transaction PayBox wants signed, and check every instruction in it.
const reopened = toolJson(await client.mcp.callTool("reopen_signing_window", { request_id: requestId }, "in-process"));
if (reopened?.request_id !== requestId) throw new Error("PayBox returned a different request. Not signing.");
let plan = reopened.plan;
const notes = checkTransferPlan(plan, expect);
console.log("\nTransaction check PASSED:");
for (const n of notes) console.log(" - " + n);

// 5) Confirm.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  `\nSIGN: ${Number(amount) / 1e6} USDC from ${SOL_ADDR}\n` +
  `to PAJ address ${order.address}\n` +
  `for N${Number(order.fiatAmount).toLocaleString()} to the account on PAJ order ${ORDER_ID}.\n` +
  `Type send to sign: `,
);
rl.close();
if (answer.trim().toLowerCase() !== "send") { console.log("Cancelled. Nothing signed."); process.exit(0); }

// 6) Get a fresh copy of the transaction (Solana transactions go stale in about a minute), re-check it.
try {
  const fresh = await client.poster(`/agent/requests/${requestId}/refresh`, {});
  if (fresh?.plan) { plan = fresh.plan; checkTransferPlan(plan, expect); console.log("Refreshed and re-checked the transaction."); }
} catch (e: any) {
  console.log(`(Could not refresh the transaction: ${e.message}. Using the one already checked.)`);
}

// 7) Sign once.
req = await client.getRequest(requestId);
if (req.status !== "pending_signature") throw new Error(`Request changed to ${req.status} before signing. Not signing.`);
const envelopes = buildEnvelopes(plan, creds);
ledger[ORDER_ID] = { ...entry, signedAt: new Date().toISOString() };
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
try {
  await client.poster(`/agent/requests/${requestId}/envelopes`, { envelopes });
  console.log("\nSigned and submitted to PayBox.");
} catch (e: any) {
  console.log(`\nSubmitting the signature failed: ${e.message}`);
}

// 8) Poll PayBox to a final status.
const final = await client.waitForRequest(requestId, { intervalMs: 3000, timeoutMs: 180000 });
show("PayBox final status", final);

// 9) Watch the PAJ order.
console.log("\nWatching the PAJ order (up to 5 minutes)...");
let last = "";
for (let i = 0; i < 30; i++) {
  const o = await getTransaction(token, ORDER_ID);
  if (o.status !== last) { console.log(`${new Date().toLocaleTimeString()} PAJ status: ${o.status}`, o.signature ? `tx ${o.signature}` : ""); last = o.status; }
  if (o.status === "COMPLETED") break;
  await sleep(10000);
}
console.log("\nDone. Paste everything above back to Claude. Do not rerun this script.");
