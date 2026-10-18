// Wallet-to-wallet USDC transfers with a fake PayBox. No network, no money.
import { sendTransfer, type Transfer } from "../lib/p2p.ts";

let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`); };

const FROM = "3YWrKex5whNtK5QeXaPGDrBZwcAqMsgRigxwFgA3kZ8M";
const TO = "7JqsrYeUEcCHKoJ5igv4J8dD9mMfE7Qd514gmv3co4LZ";

function setup(opts: { usdc?: number; sol?: number; wallet?: string; status?: string; final?: string; hasAta?: boolean } = {}) {
  const calls = { request: [] as any[], sign: [] as any[] };
  const saved: Transfer[] = [];
  const store = { get: async () => undefined, save: async (t: Transfer) => { saved.push(structuredClone(t)); } };
  let status = opts.status ?? "pending_signature";
  const client = {
    getRequest: async () => ({ status }),
    waitForRequest: async () => ({ status: opts.final ?? "success", output: { value: { tx_hash: "TXHASH" } } }),
  };
  const deps = {
    solanaWallet: async () => ({ credentialId: "sol", address: opts.wallet ?? FROM }),
    balances: async () => ({ usdc: opts.usdc ?? 10, sol: opts.sol ?? 0.01 }),
    hasUsdcAccount: async () => opts.hasAta ?? false,
    requestTransfer: async (_c: any, a: any) => { calls.request.push(a); return { request_id: "req-1", status: "pending_signature" }; },
    signPendingTransfer: async (_c: any, id: string, expect: any, before: () => Promise<void>) => { calls.sign.push({ id, expect }); await before(); status = "submitted"; return { signed: true }; },
  } as any;
  const t: Transfer = { transferId: "a".repeat(24), fromId: 1, toId: 2, toHandle: "ada_okafor", fromAddress: FROM, toAddress: TO, usdc: 2.5, chatId: 1, createdAt: new Date().toISOString() };
  return { t, calls, saved, run: (tr = t) => sendTransfer(tr, { client, store, deps }) };
}

{
  const s = setup();
  const r = await s.run();
  check("a payment completes and returns the Solscan link", r.status === "completed" && (r as any).explorer === "https://solscan.io/tx/TXHASH", JSON.stringify(r));
  check("PayBox is asked for exactly that amount to exactly that wallet", s.calls.request.length === 1 && s.calls.request[0].to === TO && s.calls.request[0].baseUnits === 2_500_000n);
  check("the plan is checked against sender, recipient and amount before signing", s.calls.sign[0]?.expect.sender === FROM && s.calls.sign[0]?.expect.recipient === TO && s.calls.sign[0]?.expect.amountBaseUnits === 2_500_000n);
  check("the request id is saved before signing", s.saved[0]?.requestId === "req-1" && !s.saved[0]?.signedAt);
  check("the signing time is saved before submitting", s.saved.some((t) => t.signedAt));
  const again = await s.run();
  check("running again resumes and never requests a second transfer", again.status === "completed" && s.calls.request.length === 1);
}
{
  const s = setup({ usdc: 1 });
  const r = await s.run();
  check("not enough USDC: nothing requested", r.status === "not_sent" && s.calls.request.length === 0 && (r as any).reason.includes("Nothing was sent"));
}
{
  const s = setup({ sol: 0.001 });
  const r = await s.run();
  check("not enough SOL for a new recipient account: nothing requested", r.status === "not_sent" && s.calls.request.length === 0, (r as any).reason);
}
{
  const s = setup({ sol: 0.001, hasAta: true });
  const r = await s.run();
  check("a little SOL is enough when the recipient already has a USDC account", r.status === "completed");
}
{
  const s = setup({ wallet: "OtherWallet111111111111111111111111111111111" });
  const r = await s.run();
  check("a changed sender wallet stops the payment", r.status === "not_sent" && s.calls.request.length === 0);
}
{
  const s = setup();
  const r = await s.run({ ...s.t, toAddress: FROM });
  check("paying your own wallet is refused", r.status === "not_sent" && s.calls.request.length === 0);
}
{
  const s = setup({ status: "pending_approval" });
  const r = await s.run();
  check("approval-mode wallets wait for approval without signing", r.status === "needs_approval" && s.calls.sign.length === 0);
}
{
  const s = setup({ final: "denied" });
  const r = await s.run();
  check("a denied transfer is reported as failed", r.status === "failed");
}
{
  const s = setup({ final: "submitted" });
  const r = await s.run();
  check("an unfinished transfer is reported as processing", r.status === "processing");
}
process.exit(ok ? 0 : 1);
