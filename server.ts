// PayBot as a hosted x402 service: any PayBox agent can send naira to a Nigerian bank account.
// The agent pays $0.01 to prepare a payout, shows the user the bank-verified name, then pays the
// USDC itself with PayBox request_transfer. PayBot never holds anyone's keys or funds.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createFacilitatorConfig } from "@coinbase/x402";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { USDC_MINT, toBaseUnits } from "./lib/config.ts";
import { getTransaction, loadSession } from "./lib/paj.ts";
import { banks, createPayout, quote } from "./lib/payout.ts";
import { landingPage, llmsTxt, openApi } from "./lib/site.ts";
import { webhookCallback } from "grammy";
import { postgresStore } from "./lib/bot-store.ts";
import { createPaybot } from "./lib/telegram.ts";

const PORT = Number(process.env.PORT ?? 8787);
const BASE = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const PRICE = process.env.PRICE ?? "$0.01";
const EVM_NET = process.env.X402_EVM_NETWORK ?? "eip155:8453";
const SVM_NET = process.env.X402_SVM_NETWORK ?? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PAY_TO_EVM = process.env.PAY_TO_EVM?.trim();
const PAY_TO_SOL = process.env.PAY_TO_SOL?.trim();
// Coinbase's (CDP) facilitator when its API key is set: payments settled there get PayBot indexed
// in the CDP Bazaar, which PayBox searches. Otherwise fall back to a public facilitator.
const CDP_KEY_ID = process.env.CDP_API_KEY_ID?.trim();
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET?.trim();
const USE_CDP = Boolean(CDP_KEY_ID && CDP_KEY_SECRET);
const FACILITATOR = USE_CDP ? "cdp" : process.env.FACILITATOR_URL ?? "https://facilitator.payai.network";
// Plain description of what the endpoint does (CDP rejects descriptions over 500 characters,
// and the Bazaar delists metadata that reads as instructions to agents).
const DESCRIPTION = "PayBot: naira payouts to Nigerian bank and fintech accounts. Returns the bank-verified account holder name, the exact USDC amount, and the Solana deposit address for the payout. The payout settles in naira, usually within seconds of the USDC arriving.";
const SECRET = process.env.STATUS_SECRET || process.env.PAJ_API_KEY || "";

const app = new Hono();
app.use("*", cors());

// ---------- Request shapes ----------

const PrepareBody = z.object({
  bank: z.string().min(2).max(80),
  accountNumber: z.string().min(10).max(16),
  ngn: z.number().int().positive().max(10_000_000),
  expectedName: z.string().max(120).optional(),
});
const exampleBody = { bank: "GTBank", accountNumber: "0123456789", ngn: 5000, expectedName: "Tunde Bakare" };

// ---------- Status links: only whoever prepared a payout can look it up ----------

const statusToken = (id: string) => createHmac("sha256", SECRET).update(`paybot-status:${id}`).digest("base64url").slice(0, 32);
function validToken(id: string, token?: string) {
  if (!SECRET || !token) return false;
  const a = Buffer.from(statusToken(id)), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- Light rate limit for the free endpoints ----------

const hits = new Map<string, number[]>();
function limited(c: any, perMinute = 30) {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) return true;
  hits.set(ip, [...recent, now]);
  return false;
}

// ---------- x402 paywall on POST /prepare ----------

const paid = Boolean(PAY_TO_EVM || PAY_TO_SOL);
if (paid) {
  const facilitator = USE_CDP ? createFacilitatorConfig(CDP_KEY_ID, CDP_KEY_SECRET) : { url: FACILITATOR };
  const server = new x402ResourceServer(new HTTPFacilitatorClient(facilitator));
  server.registerExtension(bazaarResourceServerExtension);
  const accepts: any[] = [];
  if (PAY_TO_SOL) { server.register(SVM_NET as any, new ExactSvmScheme()); accepts.push({ scheme: "exact", price: PRICE, network: SVM_NET, payTo: PAY_TO_SOL }); }
  if (PAY_TO_EVM) { server.register(EVM_NET as any, new ExactEvmScheme()); accepts.push({ scheme: "exact", price: PRICE, network: EVM_NET, payTo: PAY_TO_EVM }); }
  app.use(paymentMiddleware({
    "POST /prepare": {
      accepts,
      // Behind Render's proxy the app sees http://; advertise the real public https address.
      ...(process.env.PUBLIC_URL ? { resource: `${BASE}/prepare` } : {}),
      description: DESCRIPTION,
      mimeType: "application/json",
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: exampleBody,
        inputSchema: {
          properties: {
            bank: { type: "string", description: "Bank name, e.g. GTBank, Opay, Access" },
            accountNumber: { type: "string", description: "10-digit NUBAN account number" },
            ngn: { type: "integer", description: "Naira the recipient should receive" },
            expectedName: { type: "string", description: "Recipient name the user gave; a mismatch stops the payout" },
          },
          required: ["bank", "accountNumber", "ngn"],
        },
        output: { example: { payoutId: "6ad0d2fb372552a19a9ff36c", recipient: { accountName: "TUNDE BAKARE", bank: "Guaranty Trust Bank", accountNumber: "0123456789" }, ngn: 5000, usdc: 3.69, pay: { chain: "solana:mainnet", token: USDC_MINT, to: "<PAJ deposit address>", amount: "3690000" } } },
      } as any),
    },
  } as any, server, undefined, undefined, process.env.X402_SYNC !== "0"));
} else {
  console.warn("[paybot] PAY_TO_EVM / PAY_TO_SOL not set: /prepare is FREE (dev mode)");
}

// ---------- Paid: prepare a payout ----------

app.post("/prepare", async (c) => {
  const parsed = PrepareBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid request", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`), example: exampleBody }, 400);
  }
  try {
    const p = await createPayout(parsed.data);
    const amount = toBaseUnits(p.usdc).toString();
    const naira = `N${p.ngn.toLocaleString("en-NG")}`;
    const statusUrl = `${BASE}/status/${p.payoutId}?token=${statusToken(p.payoutId)}`;
    return c.json({
      payoutId: p.payoutId,
      status: "awaiting_payment",
      recipient: { accountName: p.accountName, bank: p.bank.name, accountNumber: p.accountNumber },
      ngn: p.ngn,
      usdc: p.usdc,
      rate: p.rate,
      pay: { chain: "solana:mainnet", token: USDC_MINT, to: p.address, amount, amountUsdc: p.usdc, decimals: 6 },
      paybox: {
        tool: "request_transfer",
        args: { credential_id: "<your Solana wallet credential_id>", chain: "solana:mainnet", to: p.address, amount, token: USDC_MINT },
      },
      confirm: `${p.accountName}, ${p.bank.name} ${p.accountNumber}. ${naira} costs ${p.usdc} USDC. Send it?`,
      rules: [
        "Show the user the confirm text and pay only after an explicit yes.",
        "Pay exactly pay.amount of USDC on Solana to pay.to, once. Never pay this payoutId twice.",
        "Pay within 15 minutes. If later, call /prepare again for a fresh payout.",
        "After paying, check statusUrl with PayBox use_service in probe mode (free, live) until status is COMPLETED. ERROR can be temporary; keep checking, do not pay again.",
      ],
      statusUrl,
      statusCheck: { tool: "use_service", mode: "probe", method: "GET", url: statusUrl, note: "Free and live (no payment, no cache). Repeat every few seconds until status is COMPLETED." },
    });
  } catch (e: any) {
    // 422 means the request was understood but cannot be paid out; x402 cancels the charge on any 4xx.
    return c.json({ error: e?.message ?? String(e), charged: false }, 422);
  }
});

// ---------- Free: status, banks, quote ----------

// Status and rates change by the second: never let a browser, proxy or agent web reader cache them.
app.use("/status/*", async (c, next) => { await next(); c.header("Cache-Control", "no-store, max-age=0"); });
app.use("/quote", async (c, next) => { await next(); c.header("Cache-Control", "no-store, max-age=0"); });

app.get("/status/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-f0-9]{24}$/i.test(id) || !validToken(id, c.req.query("token"))) return c.json({ error: "Unknown payout or wrong token" }, 404);
  if (limited(c, 60)) return c.json({ error: "Slow down" }, 429);
  try {
    const o = await getTransaction(loadSession(), id);
    const done = o.status === "COMPLETED";
    return c.json({
      payoutId: id, status: o.status, done, ngn: Number(o.fiatAmount), usdc: Number(o.amount),
      txSignature: o.signature || null,
      note: done ? "Naira paid." : o.status === "INIT" ? "Waiting for the USDC payment." : "Processing. ERROR can be temporary: keep polling, never pay again.",
    });
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 502);
  }
});

app.get("/banks", async (c) => {
  if (limited(c)) return c.json({ error: "Slow down: 30 requests a minute." }, 429);
  try { return c.json(await banks(c.req.query("search") || undefined)); }
  catch (e: any) { return c.json({ error: e?.message ?? String(e) }, 502); }
});

app.get("/quote", async (c) => {
  if (limited(c)) return c.json({ error: "Slow down: 30 requests a minute." }, 429);
  const ngn = Number(c.req.query("ngn")) || undefined;
  const usdc = Number(c.req.query("usdc")) || undefined;
  try { return c.json(await quote({ ngn, usdc })); }
  catch (e: any) { return c.json({ error: e?.message ?? String(e) }, 502); }
});

// ---------- Docs for agents and people ----------

app.get("/", (c) => c.html(landingPage(BASE, PRICE)));
app.get("/llms.txt", (c) => c.text(llmsTxt(BASE, PRICE)));
app.get("/openapi.json", (c) => c.json(openApi(BASE, PRICE)));
app.get("/health", (c) => c.json({ ok: true, service: "paybot", paid, telegram, facilitator: USE_CDP ? "coinbase-cdp" : FACILITATOR, networks: [PAY_TO_SOL && SVM_NET, PAY_TO_EVM && EVM_NET].filter(Boolean) }));

// ---------- Telegram bot (only when its settings exist) ----------

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const DB_URL = process.env.DATABASE_URL?.trim();
let telegram = "off";
if (TG_TOKEN && TG_SECRET && DB_URL && process.env.PAYBOT_NO_LISTEN !== "1") {
  try {
    const bot = createPaybot(TG_TOKEN, { store: await postgresStore(DB_URL) });
    // Secret path plus Telegram's secret header: only Telegram can deliver updates.
    app.post(`/telegram/${TG_SECRET}`, webhookCallback(bot, "hono", { secretToken: TG_SECRET, timeoutMilliseconds: 25_000 }));
    await bot.api.setWebhook(`${BASE}/telegram/${TG_SECRET}`, { secret_token: TG_SECRET, drop_pending_updates: false, allowed_updates: ["message", "callback_query"] });
    await bot.api.setMyCommands([
      { command: "connect", description: "Link your PayBox wallet" },
      { command: "send", description: "Send naira: /send 5000 GTBank 0123456789 Name" },
      { command: "wallet", description: "Your balance" },
      { command: "history", description: "Your recent payouts" },
      { command: "disconnect", description: "Remove your PayBox connection" },
      { command: "help", description: "How PayBot works" },
    ]);
    telegram = "on";
  } catch (e: any) {
    telegram = "error";
    console.error("[paybot] Telegram bot failed to start:", e.message);
  }
}

if (!SECRET) console.warn("[paybot] STATUS_SECRET not set: status links will not work.");
if (process.env.PAYBOT_NO_LISTEN !== "1") {
  serve({ fetch: app.fetch, port: PORT }, () => console.log(`[paybot] ${BASE} (x402 ${paid ? "ON" : "OFF"}, facilitator ${USE_CDP ? "coinbase-cdp" : FACILITATOR}, telegram ${telegram})`));
}

export { app, statusToken };
