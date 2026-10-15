// Full payout flow against fake PAJ, fake PayBox and fake Solana. No network, no money.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const DATA = mkdtempSync(join(tmpdir(), "paybot-test-"));
process.env.PAYBOT_DATA_DIR = DATA;
writeFileSync(join(DATA, ".paj-session.json"), JSON.stringify({ token: "t", expiresAt: "2099-01-01T00:00:00Z", deviceId: "d" }));

const { ataOf, USDC_MINT_PK } = await import("../lib/transfer-check.ts");
const { solanaMessageHex } = await import("../lib/sign-plan.ts");
const { usePayboxClientForTests } = await import("../lib/paybox.ts");
const { prepare, send, status } = await import("../lib/payout.ts");

const SENDER = "3YWrKex5whNtK5QeXaPGDrBZwcAqMsgRigxwFgA3kZ8M";
const PAJ_ADDR = "7JqsrYeUEcCHKoJ5igv4J8dD9mMfE7Qd514gmv3co4LZ";
const OPAY = { id: "679be2527f99f556d77b8d9c", name: "Opay", code: "100004" };
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// ---- fake world state ----
let orderSeq = 0, offrampCalls = 0, transferRequests = 0, envelopePosts = 0;
let lamports = 10_000_000;
let reqStatus = "pending_signature";
let failNextEnvelope = false;
let pajAfterPaid: string[] = [];
const orders: Record<string, any> = {};

function planTx() {
  const s = new PublicKey(SENDER), r = new PublicKey(PAJ_ADDR);
  const d = Buffer.alloc(10); d[0] = 12; d.writeBigUInt64LE(1100000n, 1); d[9] = 6;
  const ix = new TransactionInstruction({ programId: TOKEN, data: d, keys: [
    { pubkey: ataOf(s), isSigner: false, isWritable: true }, { pubkey: USDC_MINT_PK, isSigner: false, isWritable: false },
    { pubkey: ataOf(r), isSigner: false, isWritable: true }, { pubkey: s, isSigner: true, isWritable: false }] });
  const msg = new TransactionMessage({ payerKey: s, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}
const plan = () => ({
  binding: { wallet_id: "w", key_id: "k", derivation_path: "m" }, sender: SENDER, credential_id: "cred-sol",
  transfer: { recipient: PAJ_ADDR, token: USDC_MINT_PK.toBase58(), amount: "1100000" },
  txs: [{ kind: "transfer", vm: "solana", transaction: planTx() }],
});

const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (url.hostname === "api.mainnet-beta.solana.com") {
    if (body.method === "getBalance") return json({ result: { value: lamports } });
    if (body.method === "getTokenAccountsByOwner") return json({ result: { value: [] } });
  }
  const p = url.pathname;
  if (p === "/pub/bank") return json([{ id: "x", country: "NG", code: "1" }, OPAY, { id: "g", name: "Guaranty Trust Bank", code: "000013" }]);
  if (p === "/pub/bank-account/confirm") return json({ accountName: "SOMTOCHUKWU MEL OKOYE", accountNumber: url.searchParams.get("accountNumber") });
  if (p === "/pub/bank-account" && method === "POST") return json({ id: "acct", address: "5Pw9" });
  if (p === "/pub/offramp" && method === "POST") {
    offrampCalls++;
    const id = (++orderSeq).toString(16).padStart(24, "a");
    orders[id] = { id, address: PAJ_ADDR, mint: USDC_MINT_PK.toBase58(), currency: "NGN", amount: 1.1, fiatAmount: body.fiatAmount, rate: 1353.67, fee: 0, chain: "SOLANA", status: "INIT" };
    return json(orders[id]);
  }
  const m = p.match(/^\/pub\/transactions\/(\w+)$/);
  if (m) {
    const o = orders[m[1]];
    if (reqStatus === "success" && pajAfterPaid.length) o.status = pajAfterPaid.shift();
    return json(o);
  }
  if (p === "/pub/rate/offRamp") return json({ rate: 1354.19 });
  return json({ error: `unmocked ${method} ${p}` }, 404);
}) as any;

const seed = nacl.randomBytes(32);
const kp = nacl.sign.keyPair.fromSeed(seed);
const creds = { apiPubHex: Buffer.from(kp.publicKey).toString("hex"), apiPrivHex: Buffer.from(seed).toString("hex") };
const REQ = "5d1584b4-6f7e-4fe4-be70-7fcbab9b6691";
usePayboxClientForTests({
  signingCreds: () => creds,
  listCredentials: async () => ({ credentials: [
    { credential: { id: "cred-sol", name: "sol-default", credential_type: "wallet", disabled_at: null, metadata: { address: SENDER, chains: ["solana"] } } },
    { credential: { id: "cred-evm", name: "evm-default", credential_type: "wallet", disabled_at: null, metadata: { address: "0x1", chains: ["evm"] } } },
  ] }),
  getPortfolio: async () => ({ items: [{ tokenAddress: USDC_MINT_PK.toBase58(), balance: "2970000" }] }),
  mcp: { callTool: async (name: string, args: any) => {
    if (name === "request_transfer") {
      transferRequests++;
      if (args.to !== PAJ_ADDR || args.amount !== "1100000" || args.chain !== "solana:mainnet") throw new Error("bad transfer args");
      return { structuredContent: { request_id: REQ, status: reqStatus, plan: plan() } };
    }
    if (name === "reopen_signing_window") return { structuredContent: { request_id: REQ, status: reqStatus, plan: plan() } };
    throw new Error("unexpected tool " + name);
  } },
  poster: async (path: string, body: any) => {
    if (path.endsWith("/refresh")) return { plan: plan() };
    if (path.endsWith("/envelopes")) {
      envelopePosts++;
      if (failNextEnvelope) { failNextEnvelope = false; throw new Error("network dropped"); }
      const env = body.envelopes[0];
      const signed = Buffer.from(env.signed_body, "hex");
      const okSig = nacl.sign.detached.verify(signed, Buffer.from(env.agent_signature, "hex"), kp.publicKey);
      const payload = JSON.parse(signed.toString()).raw_signing_payload;
      if (!okSig || payload !== solanaMessageHex(planTx())) throw new Error("bad envelope");
      reqStatus = "success";
      return {};
    }
    throw new Error("unexpected post " + path);
  },
  getRequest: async () => ({ request_id: REQ, status: reqStatus }),
  waitForRequest: async () => ({ request_id: REQ, status: reqStatus, output: { value: reqStatus === "success" ? { tx_hash: "TXHASH" } : {} } }),
});

// ---- scenarios ----
let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`); };
const err = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e: any) { return e.message as string; } };

// 1. Wrong recipient name stops before any order exists.
let e = await err(() => prepare({ bank: "opay", accountNumber: "8161859340", ngn: 1500, expectedName: "Tunde Bakare" }));
check("wrong name stops prepare, no PAJ order created", e.includes("belongs to") && offrampCalls === 0, e);

// 2. Prepare works and reports the bank-verified name.
const prep = await prepare({ bank: "Opay", accountNumber: "816 185 9340", ngn: 1500, expectedName: "Somtochukwu Mel Okoye" });
check("prepare returns verified name and USDC cost", prep.accountName === "SOMTOCHUKWU MEL OKOYE" && prep.usdc === 1.1, prep.say);

// 3. Confirming with a different name is refused.
e = await err(() => send({ payoutId: prep.payoutId, confirmedAccountName: "Someone Else" }));
check("send refuses a name the user did not confirm", e.includes("does not match") && transferRequests === 0, e);

// 4. Not enough SOL stops before PayBox is asked.
lamports = 1000;
e = await err(() => send({ payoutId: prep.payoutId, confirmedAccountName: "Somtochukwu Mel Okoye" }));
check("low SOL stops send before any transfer request", e.includes("SOL") && transferRequests === 0, e);
lamports = 10_000_000;

// 5. Signature submission drops mid-way: the transfer is requested once, and a retry does not re-request.
failNextEnvelope = true;
e = await err(() => send({ payoutId: prep.payoutId, confirmedAccountName: "Somtochukwu Mel Okoye" }));
check("dropped signature surfaces an error", e.includes("network dropped") && transferRequests === 1, e);
const again = await send({ payoutId: prep.payoutId, confirmedAccountName: "Somtochukwu Mel Okoye" });
check("immediate retry does not re-request or re-sign", again.status === "processing" && transferRequests === 1 && envelopePosts === 1, again.say);

// 6. Two minutes later the stuck signature is re-signed once; PAJ wobbles ERROR then COMPLETED.
const rec = JSON.parse(readFileSync(join(DATA, "payouts.json"), "utf8"));
rec[prep.payoutId].signedAt = new Date(Date.now() - 180_000).toISOString();
writeFileSync(join(DATA, "payouts.json"), JSON.stringify(rec));
pajAfterPaid = ["PROCESSING", "ERROR", "COMPLETED"];
const done: any = await send({ payoutId: prep.payoutId, confirmedAccountName: "SOMTOCHUKWU MEL OKOYE" });
check("payout completes through a temporary PAJ ERROR", done.status === "completed" && done.txHash === "TXHASH", done.say);
check("still exactly one transfer request in total", transferRequests === 1, `requests=${transferRequests}, signatures=${envelopePosts}`);

// 7. Calling send again after completion never sends again.
const after: any = await send({ payoutId: prep.payoutId, confirmedAccountName: "SOMTOCHUKWU MEL OKOYE" });
check("send after completion is harmless", transferRequests === 1 && after.status === "completed", after.status);

// 8. Status reflects both sides.
const st = await status(prep.payoutId);
check("payout_status shows PayBox success and PAJ COMPLETED", st.payboxStatus === "success" && st.pajStatus === "COMPLETED", st.hint);

process.exit(ok ? 0 : 1);
