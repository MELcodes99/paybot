// PayBot step 2b: send 1.1 USDC from PayBox to the PAJ order address. REAL MONEY.
import { PayboxClient } from "@paybox-sh/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { getSession, getTransaction, USDC_MINT } from "./lib/paj.ts";

const ORDER_ID = "6ad0d2fb372552a19a9ff36c";
const SOL_CRED = "d7a890b7-b326-4d36-9698-d44e67954820";
const SOL_ADDR = "3YWrKex5whNtK5QeXaPGDrBZwcAqMsgRigxwFgA3kZ8M";
const MAX_USDC = 2; // hard cap for this test
const LEDGER = "sent-requests.json";
const RPC = "https://api.mainnet-beta.solana.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (label: string, v: unknown) => console.log(`\n${label}:`, JSON.stringify(v, null, 2));
async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
function toolJson(res: any) {
  if (res?.structuredContent) return res.structuredContent;
  const text = res?.content?.find((c: any) => c.type === "text")?.text;
  try { return JSON.parse(text); } catch { return res; }
}

// 0) Never send twice for the same order.
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {};
if (ledger[ORDER_ID]) {
  console.log(`A transfer was already requested for order ${ORDER_ID}:`, ledger[ORDER_ID]);
  console.log("Not sending again. Ask Claude how to check its status.");
  process.exit(0);
}

// 1) Re-check the PAJ order.
const token = await getSession();
const order = await getTransaction(token, ORDER_ID);
show("PAJ order", order);
const usdc = Number(order.amount);
if (order.status !== "INIT") throw new Error(`Order is ${order.status}, not INIT. Not sending.`);
if (order.chain !== "SOLANA") throw new Error("Order is not on Solana.");
if (order.mint !== USDC_MINT) throw new Error("Order is not USDC.");
if (!(usdc > 0 && usdc <= MAX_USDC)) throw new Error(`Amount ${usdc} USDC is outside the test cap.`);
const baseUnits = String(Math.round(usdc * 1_000_000));

// 2) Check balances and the recipient account.
const client: any = await (PayboxClient as any).fromConfig();
const pf = await client.getPortfolio({ address: SOL_ADDR });
const usdcItem = pf.items.find((i: any) => i.tokenAddress === USDC_MINT);
const haveUsdc = Number(usdcItem?.balance ?? 0) / 1_000_000;
if (haveUsdc < usdc) throw new Error(`Wallet has ${haveUsdc} USDC, needs ${usdc}.`);
const sol = await rpc("getBalance", [SOL_ADDR]);
const ata = await rpc("getTokenAccountsByOwner", [order.address, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
const ataExists = (ata?.value?.length ?? 0) > 0;
console.log(`\nYour wallet: ${haveUsdc} USDC, ${(sol?.value ?? 0) / 1e9} SOL`);
console.log(`PAJ address already has a USDC account: ${ataExists ? "yes" : "no (one must be created)"}`);

// 3) Confirm.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  `\nSEND ${usdc} USDC (${baseUnits} base units) on Solana\n` +
  `from ${SOL_ADDR}\nto   ${order.address}\n` +
  `to pay N${Number(order.fiatAmount).toLocaleString()} into the account on PAJ order ${ORDER_ID}.\n` +
  `Type send to continue: `,
);
rl.close();
if (answer.trim().toLowerCase() !== "send") { console.log("Cancelled. Nothing sent."); process.exit(0); }

// 4) Request the transfer ONCE.
const args = { credential_id: SOL_CRED, chain: "solana:mainnet", to: order.address,
  amount: baseUnits, token: USDC_MINT, value_cents: Math.round(usdc * 100) };
const first = toolJson(await client.mcp.callTool("request_transfer", args, "in-process"));
show("request_transfer reply", first);
const requestId = first?.request_id;
ledger[ORDER_ID] = { requestId, at: new Date().toISOString(), args };
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
if (!requestId) throw new Error("No request_id came back. Do NOT rerun. Paste this to Claude.");

// 5) Sign locally if PayBox is waiting for a signature.
if (first.status === "pending_signature") {
  try { show("After local signing", await client.completeWalletSignRequest(requestId)); }
  catch (e: any) { console.log("\nLocal signing did not run:", e.message); }
}

// 6) Poll PayBox to a final status.
const final = await client.waitForRequest(requestId, { intervalMs: 3000, timeoutMs: 180000 });
show("PayBox final status", final);

// 7) Watch the PAJ order.
console.log("\nWatching the PAJ order (up to 5 minutes)...");
let last = "";
for (let i = 0; i < 30; i++) {
  const o = await getTransaction(token, ORDER_ID);
  if (o.status !== last) { console.log(`${new Date().toLocaleTimeString()} PAJ status: ${o.status}`, o.signature ? `tx ${o.signature}` : ""); last = o.status; }
  if (o.status === "COMPLETED") break;
  await sleep(10000);
}
console.log("\nDone. Paste everything above back to Claude. Do not rerun this script.");
