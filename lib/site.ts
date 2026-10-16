// What agents and people read: the OpenAPI contract, llms.txt and the landing page.
import { USDC_MINT } from "./config.ts";

const GUIDANCE = (base: string, price: string) =>
  `PayBot sends naira to any Nigerian bank account, paid in USDC on Solana. Flow for PayBox agents: ` +
  `(1) POST ${base}/prepare with {bank, accountNumber, ngn, expectedName?}. It costs ${price} over x402 (USDC on Base or Solana) and returns the bank-verified account name, a payoutId, a statusUrl, and pay {chain, token, to, amount}. ` +
  `If expectedName is given and the bank's name differs, it returns 422 and you are not charged. ` +
  `(2) Show the user the response's confirm text (verified name, bank, account number, naira, USDC) and wait for an explicit yes. Never pay without it. ` +
  `(3) Pay with PayBox request_transfer {credential_id: your Solana wallet, chain: "solana:mainnet", to: pay.to, amount: pay.amount, token: "${USDC_MINT}"}, exactly once, within 15 minutes. Poll get_request with the same request_id; never re-call request_transfer. ` +
  `(4) Check statusUrl until status is COMPLETED, using PayBox use_service with mode "probe" (free, live, never cached; plain web readers may show a stale page). ERROR can be temporary: keep checking, never pay again. ` +
  `Users usually ask in one line, e.g. "Send 5,000 naira to GTBank 0123456789, Tunde Bakare": map it to bank "GTBank", accountNumber "0123456789", ngn 5000, expectedName "Tunde Bakare". ` +
  `Free helpers: GET ${base}/banks?search=opay and GET ${base}/quote?ngn=5000. The paying wallet needs about 0.0021 SOL for network fees.`;

export function openApi(base: string, price: string) {
  const amount = price.replace(/^\$/, "");
  const err = { description: "Error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } };
  return {
    openapi: "3.1.0",
    info: {
      title: "PayBot",
      version: "0.2.0",
      description: "Send naira to any Nigerian bank account from an agent wallet. USDC on Solana in, naira out, via PAJ. Bank-verified recipient names before every payment. PayBot never holds keys or funds: the agent pays the PAJ address directly.",
      "x-guidance": GUIDANCE(base, price),
      contact: { name: "Jedi Labs", url: "https://github.com/MELcodes99/paybot" },
    },
    servers: [{ url: base }],
    paths: {
      "/prepare": {
        post: {
          operationId: "prepare_payout",
          summary: "Create a naira payout to a Nigerian bank account",
          description: "Verifies the account with the bank and creates a payout. Returns the bank-verified account name, the exact USDC amount and the Solana address to pay, and a status link. No money moves until the agent pays pay.to. Errors return 422 and are not charged.",
          "x-payment-info": { price: { amount: Number(amount).toFixed(6), currency: "USD", mode: "fixed" }, protocols: [{ x402: {} }], description: "Prepare a naira payout" },
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["bank", "accountNumber", "ngn"],
              properties: {
                bank: { type: "string", description: "Bank name as the user said it, e.g. GTBank, Opay, Access, Kuda", example: "GTBank" },
                accountNumber: { type: "string", description: "10-digit NUBAN account number", example: "0123456789" },
                ngn: { type: "integer", minimum: 1, description: "Naira the recipient should receive", example: 5000 },
                expectedName: { type: "string", description: "Recipient name the user gave. If the bank says otherwise, nothing is created and you are not charged.", example: "Tunde Bakare" },
              },
            } } },
          },
          responses: {
            "200": { description: "Payout prepared", content: { "application/json": { schema: {
              type: "object",
              required: ["payoutId", "recipient", "ngn", "usdc", "pay", "confirm", "statusUrl"],
              properties: {
                payoutId: { type: "string" },
                status: { type: "string", enum: ["awaiting_payment"] },
                recipient: { type: "object", properties: { accountName: { type: "string" }, bank: { type: "string" }, accountNumber: { type: "string" } } },
                ngn: { type: "integer" },
                usdc: { type: "number", description: "USDC to pay, fees included" },
                rate: { type: "number" },
                pay: { type: "object", properties: {
                  chain: { type: "string", enum: ["solana:mainnet"] },
                  token: { type: "string", enum: [USDC_MINT] },
                  to: { type: "string", description: "PAJ deposit address for this payout" },
                  amount: { type: "string", description: "USDC base units (6 decimals) for request_transfer.amount" },
                } },
                confirm: { type: "string", description: "Show this to the user and wait for a yes" },
                statusUrl: { type: "string" },
              },
            } } } },
            "400": err, "402": { description: "Payment Required (x402)" }, "422": err,
          },
        },
      },
      "/status/{payoutId}": {
        get: {
          operationId: "payout_status",
          summary: "Fetch the status of a prepared naira payout",
          parameters: [
            { name: "payoutId", in: "path", required: true, schema: { type: "string", pattern: "^[a-f0-9]{24}$" }, description: "payoutId returned by /prepare" },
            { name: "token", in: "query", required: true, schema: { type: "string" }, description: "From statusUrl" },
          ],
          responses: { "200": { description: "Status", content: { "application/json": { schema: { type: "object", properties: {
            status: { type: "string", enum: ["INIT", "PAID", "PROCESSING", "ERROR", "COMPLETED"] }, done: { type: "boolean" },
            ngn: { type: "number" }, usdc: { type: "number" }, txSignature: { type: ["string", "null"] }, note: { type: "string" },
          } } } } }, "404": err },
        },
      },
      "/banks": {
        get: {
          operationId: "list_banks", summary: "Search Nigerian banks and fintechs PayBot can pay into",
          parameters: [{ name: "search", in: "query", required: false, schema: { type: "string" }, example: "opay" }],
          responses: { "200": { description: "Banks", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/quote": {
        get: {
          operationId: "quote", summary: "Fetch the live naira payout rate and a USDC estimate",
          parameters: [
            { name: "ngn", in: "query", required: false, schema: { type: "number" }, description: "Naira amount to estimate the USDC cost for", example: 5000 },
            { name: "usdc", in: "query", required: false, schema: { type: "number" }, description: "USDC amount to estimate the naira payout for", example: 10 },
          ],
          responses: { "200": { description: "Rate and estimate", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  };
}

export function llmsTxt(base: string, price: string) {
  return `# PayBot
> Send naira to any Nigerian bank account from an agent wallet. USDC on Solana in, naira out, via PAJ.

## Flow (PayBox)
1. use_service({ credential_id, url: "${base}/prepare", method: "POST", body: { "bank": "GTBank", "accountNumber": "0123456789", "ngn": 5000, "expectedName": "Tunde Bakare" } })
   Price: ${price} over x402. Errors (bad account, name mismatch) return 422 and are not charged.
2. Show the user the response's "confirm" text: bank-verified name, bank, account number, naira and USDC. Wait for an explicit yes.
3. request_transfer({ credential_id: <your Solana wallet>, chain: "solana:mainnet", to: pay.to, amount: pay.amount, token: "${USDC_MINT}" })
   Once. Within 15 minutes. Poll get_request with the same request_id; never call request_transfer again for this payout.
4. Check statusUrl until "status" is "COMPLETED":
   use_service({ credential_id, url: <statusUrl>, method: "GET", mode: "probe" })
   Probe mode is free and live. Plain web readers can show a cached, out-of-date status.
   "ERROR" can be temporary: keep checking, never pay again.

## How people ask
"Send 5,000 naira to GTBank 0123456789, Tunde Bakare"
-> bank: "GTBank", accountNumber: "0123456789", ngn: 5000, expectedName: "Tunde Bakare"
Also common: "Pay Ada Okafor 20k on Opay 8012345678" (20k = 20000).

## Free helpers
- GET ${base}/banks?search=opay
- GET ${base}/quote?ngn=5000
- GET ${base}/openapi.json

## Rules
- Never pay without the user's yes to the bank-verified name.
- Pay exactly pay.amount to pay.to. Nothing else.
- One payment per payoutId.
- The paying Solana wallet needs about 0.0021 SOL for network fees.
`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

export function landingPage(base: string, price: string) {
  const b = esc(base), p = esc(price);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PayBot</title>
<meta name="description" content="Send naira to any Nigerian bank account from an agent wallet.">
<style>
:root{--ink:#111;--paper:#f6f4ef;--mute:#6b6760;--line:#d9d5cc;--accent:#0a7d4f}
@media (prefers-color-scheme:dark){:root{--ink:#eceae4;--paper:#121211;--mute:#9a968d;--line:#2c2b28;--accent:#3ccf8e}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:56px 20px 80px}
.tag{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
h1{font-size:clamp(34px,7vw,56px);line-height:1.04;letter-spacing:-.02em;margin:14px 0 18px}
.lede{font-size:20px;color:var(--mute);max-width:36ch;margin:0 0 40px}
ol{list-style:none;padding:0;margin:0 0 44px;border-top:1px solid var(--line)}
ol li{display:grid;grid-template-columns:44px 1fr;gap:4px;padding:18px 0;border-bottom:1px solid var(--line)}
ol li b{font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent);padding-top:3px}
h2{font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:40px 0 12px}
pre{background:transparent;border:1px solid var(--line);border-radius:10px;padding:16px;overflow-x:auto;font:13.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
table{width:100%;border-collapse:collapse;font-size:15px}td{padding:10px 0;border-bottom:1px solid var(--line);vertical-align:top}
td:first-child{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;padding-right:18px}
a{color:inherit}footer{margin-top:56px;color:var(--mute);font-size:14px}
</style></head><body><main>
<div class="tag">PayBot · x402 · PayBox</div>
<h1>Send naira from any agent wallet.</h1>
<p class="lede">USDC on Solana in. Naira in a Nigerian bank account out, in seconds. The bank confirms the name before anyone pays.</p>
<ol>
<li><b>01</b><div><strong>Prepare.</strong> Your agent sends the bank, account number and amount. PayBot checks the account with the bank and returns the verified name and the exact USDC to pay. ${p}.</div></li>
<li><b>02</b><div><strong>Confirm.</strong> The agent shows the person the verified name and the cost, and waits for a yes.</div></li>
<li><b>03</b><div><strong>Pay.</strong> The agent pays the USDC from its own wallet with PayBox <code>request_transfer</code>. PayBot never holds keys or funds.</div></li>
<li><b>04</b><div><strong>Done.</strong> PAJ pays the naira out. The status link turns <code>COMPLETED</code>.</div></li>
</ol>
<h2>For agents</h2>
<pre>use_service POST ${b}/prepare
{ "bank": "Opay", "accountNumber": "8012345678", "ngn": 5000,
  "expectedName": "Ada Okafor" }

request_transfer { chain: "solana:mainnet", to: pay.to,
  amount: pay.amount, token: "${USDC_MINT}" }</pre>
<h2>Endpoints</h2>
<table>
<tr><td>POST /prepare</td><td>Verified name + exact USDC to pay. ${p} over x402. Errors are not charged.</td></tr>
<tr><td>GET /status/:id</td><td>Payout status. Link comes with each payout.</td></tr>
<tr><td>GET /banks</td><td>Search Nigerian banks. Free.</td></tr>
<tr><td>GET /quote</td><td>Live naira rate. Free.</td></tr>
<tr><td>GET /openapi.json</td><td>Contract for agents. Also <a href="/llms.txt">/llms.txt</a>.</td></tr>
</table>
<footer>Built by Jedi Labs on PayBox and PAJ. <a href="https://github.com/MELcodes99/paybot">Source</a>.</footer>
</main></body></html>`;
}
