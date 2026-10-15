// With a CDP API key set, PayBot must use Coinbase's facilitator (signed requests) and a plain,
// non-instructional description under 500 characters. Throwaway key, fake Coinbase endpoint, no money.
import nacl from "tweetnacl";

const kp = nacl.sign.keyPair();
process.env.PAYBOT_NO_LISTEN = "1";
process.env.PAJ_SESSION_TOKEN = "s";
process.env.STATUS_SECRET = "x";
process.env.PUBLIC_URL = "https://paybot.example";
process.env.PAY_TO_SOL = "4rHbgQUBPckbQBEkaLLQ7zoo2MrEmWtQCY9gSYZKmMf8";
process.env.PAY_TO_EVM = "0xf950F5D6758BcD1e79F3b89Bd339c99aF3ba3Ba4";
process.env.CDP_API_KEY_ID = "00000000-0000-0000-0000-000000000000";
process.env.CDP_API_KEY_SECRET = Buffer.from(kp.secretKey).toString("base64");
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const seen: { host: string; path: string; auth: string }[] = [];
const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const h = new Headers(init.headers ?? (typeof input === "string" ? undefined : input.headers));
  seen.push({ host: url.hostname, path: url.pathname, auth: h.get("authorization") ?? "" });
  if (url.hostname === "api.cdp.coinbase.com" && url.pathname === "/platform/v2/x402/supported") {
    return json({ kinds: [
      { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" } },
      { x402Version: 2, scheme: "exact", network: "eip155:8453" },
    ], extensions: ["bazaar"], signers: {} });
  }
  return json({ error: "unexpected " + url.href }, 500);
}) as any;

const { app } = await import("../server.ts");
let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`); };

const r = await app.request("/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bank: "Opay", accountNumber: "8161859340", ngn: 1500 }) });
const pr = JSON.parse(Buffer.from(r.headers.get("payment-required") ?? "", "base64").toString() || "null");
const cdp = seen.find((s) => s.host === "api.cdp.coinbase.com");
check("uses Coinbase's facilitator, not PayAI", !!cdp && !seen.some((s) => s.host === "facilitator.payai.network"), cdp?.path);
check("Coinbase requests carry a signed CDP token", /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(cdp?.auth ?? ""));
check("402 still offers Solana and Base", r.status === 402 && pr?.accepts?.some((a: any) => a.network === SOL) && pr?.accepts?.some((a: any) => a.network === "eip155:8453"));
const desc: string = pr?.resource?.description ?? "";
check("description is under 500 characters", desc.length > 0 && desc.length <= 500, `${desc.length} chars`);
check("description does not instruct agents", !/\b(show|ask|must|should|never|always|before paying|get a yes)\b/i.test(desc), desc.slice(0, 70) + "...");
const health: any = await (await app.request("/health")).json();
check("health reports the Coinbase facilitator", health.facilitator === "coinbase-cdp");
process.exit(ok ? 0 : 1);
