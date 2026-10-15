// PayBot for Claude Code: a local MCP server (stdio). Never print to stdout here.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { banks, prepare, quote, send, status, wallet } from "./lib/payout.ts";

const FLOW = `PayBot sends naira to Nigerian bank accounts by paying USDC on Solana from the user's PayBox wallet through PAJ.
Flow, always in this order:
1. prepare_payout with the bank, 10-digit account number and naira amount (and the name the user gave, as expectedName). This moves no money.
2. Show the user the bank-verified account name, bank, account number, naira amount and USDC cost, and ask for an explicit yes.
3. Only after the user's yes, call send_naira with the payoutId and the bank-verified accountName.
Never call send_naira without a yes from the user for that exact payout. Never call send_naira to "retry" a payout that is processing; use payout_status. Calling send_naira again with the same payoutId is safe: it resumes and never sends twice.`;

const server = new McpServer({ name: "paybot", version: "0.1.0" }, { instructions: FLOW });

function run<T>(fn: () => Promise<T>) {
  return fn().then(
    (out) => ({ content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] }),
    (err) => ({ isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] }),
  );
}

server.registerTool("list_banks", {
  title: "List Nigerian banks",
  description: "Search Nigerian banks PAJ can pay into. Use when a bank name is ambiguous or unknown.",
  inputSchema: { search: z.string().optional().describe("Part of a bank name, e.g. 'opay', 'gtbank', 'access'") },
  annotations: { readOnlyHint: true },
}, ({ search }) => run(() => banks(search)));

server.registerTool("quote", {
  title: "Naira rate",
  description: "Live PAJ payout rate. Give ngn to estimate the USDC needed, or usdc to estimate naira. Estimate only; prepare_payout fixes the exact amount.",
  inputSchema: { ngn: z.number().positive().optional(), usdc: z.number().positive().optional() },
  annotations: { readOnlyHint: true },
}, (a) => run(() => quote(a)));

server.registerTool("wallet_status", {
  title: "PayBox wallet",
  description: "The PayBox Solana wallet PayBot pays from, with its USDC and SOL balances.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, () => run(() => wallet()));

server.registerTool("prepare_payout", {
  title: "Prepare a naira payout (no money moves)",
  description: "Step 1 of 2. Verifies the bank account with the bank and creates a PAJ order with the exact USDC cost. Moves NO money. "
    + "Afterwards you MUST show the user the bank-verified accountName, bank, accountNumber, naira amount and USDC cost, and wait for an explicit yes before send_naira. "
    + "If the user gave a recipient name, pass it as expectedName; a mismatch stops here.",
  inputSchema: {
    bank: z.string().min(2).describe("Bank name as the user said it, e.g. 'Opay', 'GTBank'"),
    accountNumber: z.string().describe("10-digit NUBAN account number"),
    ngn: z.number().int().positive().describe("Naira amount the recipient should receive"),
    expectedName: z.string().optional().describe("Recipient name the user gave, if any"),
  },
}, (a) => run(() => prepare(a)));

server.registerTool("send_naira", {
  title: "Send the prepared payout (MOVES REAL MONEY)",
  description: "Step 2 of 2. Pays the USDC for a prepared payout from the PayBox wallet and waits for the naira payout. MOVES REAL MONEY. "
    + "Only call after the user explicitly said yes to the prepare_payout summary in their latest message. "
    + "confirmedAccountName must be the bank-verified accountName that was shown to the user. "
    + "If the result says processing or awaiting payout, do NOT call again to retry; use payout_status. Re-calling with the same payoutId only resumes and never sends twice.",
  inputSchema: {
    payoutId: z.string().describe("payoutId returned by prepare_payout"),
    confirmedAccountName: z.string().describe("The bank-verified account name the user confirmed"),
  },
  annotations: { destructiveHint: true, idempotentHint: true },
}, (a) => run(() => send(a)));

server.registerTool("payout_status", {
  title: "Payout status",
  description: "Current PayBox transfer and PAJ payout status for a payoutId.",
  inputSchema: { payoutId: z.string() },
  annotations: { readOnlyHint: true },
}, ({ payoutId }) => run(() => status(payoutId)));

process.on("unhandledRejection", (e) => console.error("paybot:", e));
await server.connect(new StdioServerTransport());
console.error("PayBot MCP server ready.");
