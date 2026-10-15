// The hosted service end to end against a fake PAJ. Paywall off (no PAY_TO set). No network, no money.
process.env.PAYBOT_NO_LISTEN = "1";
process.env.PAJ_SESSION_TOKEN = "test-session";
process.env.STATUS_SECRET = "test-secret";
process.env.PUBLIC_URL = "https://paybot.example";
delete process.env.PAY_TO_SOL; delete process.env.PAY_TO_EVM;

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAJ_ADDR = "7JqsrYeUEcCHKoJ5igv4J8dD9mMfE7Qd514gmv3co4LZ";
const orders: Record<string, any> = {};
let offramps = 0;
const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "api.paj.cash") return realFetch(input, init);
  if (init.headers?.Authorization && init.headers.Authorization !== "Bearer test-session") return json({ error: "bad session" }, 401);
  const p = url.pathname, method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : {};
  if (p === "/pub/bank") return json([{ id: "op", name: "Opay", code: "100004" }, { id: "gt", name: "Guaranty Trust Bank", code: "000013" }, { id: "x", code: "1" }]);
  if (p === "/pub/bank-account/confirm") return json({ accountName: "TUNDE BAKARE" });
  if (p === "/pub/bank-account") return json({ id: "a" });
  if (p === "/pub/offramp" && method === "POST") {
    offramps++;
    const id = String(offramps).padStart(24, "b");
    orders[id] = { id, address: PAJ_ADDR, mint: USDC, amount: 3.69, fiatAmount: body.fiatAmount, rate: 1354.19, fee: 0, chain: "SOLANA", status: "INIT" };
    return json(orders[id]);
  }
  const m = p.match(/^\/pub\/transactions\/(\w+)$/);
  if (m) return orders[m[1]] ? json(orders[m[1]]) : json({ error: "nf" }, 404);
  if (p === "/pub/rate/offRamp") return json({ rate: 1354.19 });
  return json({ error: "unmocked " + p }, 404);
}) as any;

const { app } = await import("../server.ts");
const call = (path: string, init?: RequestInit) => app.request(path, init);
const post = (body: unknown) => call("/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`); };

let r = await post({ bank: "GTBank", accountNumber: "0123456789", ngn: 5000, expectedName: "Tunde Bakare" });
const prep: any = await r.json();
check("POST /prepare returns verified name and exact payment", r.status === 200 && prep.recipient.accountName === "TUNDE BAKARE" && prep.pay.amount === "3690000" && prep.pay.to === PAJ_ADDR && prep.pay.token === USDC, prep.confirm);
check("prepare tells the agent how to pay with PayBox", prep.paybox.tool === "request_transfer" && prep.paybox.args.amount === "3690000");
check("prepare tells the agent how to check status live (PayBox probe)", prep.statusCheck?.tool === "use_service" && prep.statusCheck?.mode === "probe" && prep.statusCheck?.url === prep.statusUrl);

r = await post({ bank: "GTBank", accountNumber: "0123456789", ngn: 5000, expectedName: "Someone Else" });
const mism: any = await r.json();
check("name mismatch is a 422 (x402 does not charge)", r.status === 422 && mism.charged === false && offramps === 1, mism.error);

r = await post({ bank: "GTBank", accountNumber: "123", ngn: -5 });
check("bad body is a 400 with an example", r.status === 400 && !!(await r.json() as any).example);

r = await call(new URL(prep.statusUrl).pathname + new URL(prep.statusUrl).search);
const st: any = await r.json();
check("status link works", r.status === 200 && st.status === "INIT" && st.done === false, st.note);
check("status is never cached", (r.headers.get("cache-control") ?? "").includes("no-store"), r.headers.get("cache-control") ?? "none");

r = await call(`/status/${prep.payoutId}?token=wrong`);
check("status needs the right token", r.status === 404);
orders[prep.payoutId].status = "COMPLETED"; orders[prep.payoutId].signature = "SIG";
r = await call(new URL(prep.statusUrl).pathname + new URL(prep.statusUrl).search);
const done: any = await r.json();
check("status shows COMPLETED with tx signature", done.done === true && done.txSignature === "SIG");

r = await call("/banks?search=opay");
const b: any = await r.json();
check("GET /banks finds Opay", r.status === 200 && b.banks.length === 1 && b.banks[0].name === "Opay");

r = await call("/quote?ngn=5000");
const q: any = await r.json();
check("GET /quote estimates USDC", r.status === 200 && q.usdcEstimate > 3.6 && q.usdcEstimate < 3.7, String(q.usdcEstimate));

r = await call("/openapi.json");
const spec: any = await r.json();
check("openapi.json has x-guidance and x-payment-info", spec.openapi === "3.1.0" && spec.info["x-guidance"].includes("request_transfer") && spec.paths["/prepare"].post["x-payment-info"].price.amount === "0.010000" && spec.servers[0].url === "https://paybot.example");

r = await call("/llms.txt");
const llms = await r.text();
check("llms.txt explains the flow", r.status === 200 && llms.includes("explicit yes"));
check("llms.txt shows the one-line request format and probe status checks", llms.includes("Send 5,000 naira to GTBank 0123456789, Tunde Bakare") && llms.includes('mode: "probe"'));
r = await call("/");
const html = await r.text();
check("landing page renders", r.status === 200 && html.includes("Send naira from any agent wallet") && !html.includes("—"));
r = await call("/health");
check("health is ok", r.status === 200 && (await r.json() as any).ok === true);
process.exit(ok ? 0 : 1);
