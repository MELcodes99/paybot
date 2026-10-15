// With PAY_TO set, POST /prepare must answer an unpaid call with a valid x402 402. Fake facilitator, no money.
process.env.PAYBOT_NO_LISTEN = "1";
process.env.PAJ_SESSION_TOKEN = "s";
process.env.STATUS_SECRET = "x";
process.env.PUBLIC_URL = "https://paybot.example";
process.env.PAY_TO_SOL = "4rHbgQUBPckbQBEkaLLQ7zoo2MrEmWtQCY9gSYZKmMf8";
process.env.PAY_TO_EVM = "0xf950F5D6758BcD1e79F3b89Bd339c99aF3ba3Ba4";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

let pajCalls = 0;
const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "facilitator.payai.network" && url.pathname.endsWith("/supported")) {
    return json({ kinds: [
      { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" } },
      { x402Version: 2, scheme: "exact", network: "eip155:8453" },
    ], extensions: ["bazaar"], signers: {} });
  }
  if (url.hostname === "api.paj.cash") pajCalls++;
  return json({ error: "unexpected " + url.href }, 500);
}) as any;

const { app } = await import("../server.ts");
let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`); };

const r = await app.request("/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bank: "Opay", accountNumber: "8161859340", ngn: 1500 }) });
const header = r.headers.get("payment-required");
const pr = header ? JSON.parse(Buffer.from(header, "base64").toString()) : null;
check("unpaid POST /prepare gets 402", r.status === 402, String(r.status));
const sol = pr?.accepts?.find((a: any) => a.network === SOL);
const base = pr?.accepts?.find((a: any) => a.network === "eip155:8453");
check("402 offers Solana USDC $0.01 to your wallet", sol?.amount === "10000" && sol?.payTo === process.env.PAY_TO_SOL && sol?.asset === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", JSON.stringify(sol ?? pr ?? {}).slice(0, 160));
check("402 offers Base USDC $0.01 to your wallet", base?.amount === "10000" && base?.payTo === process.env.PAY_TO_EVM);
check("402 carries the bazaar discovery info", !!pr?.extensions?.bazaar, Object.keys(pr?.extensions ?? {}).join(","));
check("402 advertises the public https address", pr?.resource?.url === "https://paybot.example/prepare", pr?.resource?.url);
check("PAJ is never touched before payment", pajCalls === 0);
const free = await app.request("/openapi.json");
check("free routes stay free", free.status === 200);
process.exit(ok ? 0 : 1);
