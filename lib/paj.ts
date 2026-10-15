// Shared PAJ client used by every part of PayBot.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { FILES, USDC_MINT } from "./config.ts";

export { USDC_MINT };
const BASE = process.env.PAJ_BASE_URL || "https://api.paj.cash";

// Common names people type, mapped to words in PAJ's official bank names.
const ALIASES: Record<string, string> = {
  gtbank: "guaranty trust", gtb: "guaranty trust", gtco: "guaranty trust",
  uba: "united bank for africa", fcmb: "first city monument",
  firstbank: "first bank", "first bank of nigeria": "first bank",
  zenith: "zenith", access: "access bank", fidelity: "fidelity",
  stanbic: "stanbic", sterling: "sterling", wema: "wema", union: "union bank",
  polaris: "polaris", keystone: "keystone", providus: "providus",
  kuda: "kuda", moniepoint: "moniepoint", palmpay: "palmpay", opay: "opay",
};

export async function pajCall(path: string, opts: { method?: string; body?: unknown; token?: string; apiKey?: boolean } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) {
    if (!process.env.PAJ_API_KEY) throw new Error("PAJ_API_KEY missing from .env");
    headers["x-api-key"] = process.env.PAJ_API_KEY;
  }
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`PAJ ${opts.method ?? "GET"} ${path} failed (${res.status}): ${text}`);
  return data;
}

// ---------- Session ----------

function readSaved() {
  return existsSync(FILES.session) ? JSON.parse(readFileSync(FILES.session, "utf8")) : {};
}

// Non-interactive: used by the Claude Code server, which can't ask for a code.
export function loadSession(): string {
  // Hosted service: the session token comes from an environment variable (no file, no code prompt).
  if (process.env.PAJ_SESSION_TOKEN) return process.env.PAJ_SESSION_TOKEN.trim();
  const saved = readSaved();
  if (saved.token && saved.expiresAt && new Date(saved.expiresAt).getTime() > Date.now() + 60_000) return saved.token;
  throw new Error("PAJ login needed. In Terminal, inside the paybot folder, run: npm run login");
}

export async function login(askCode: (email: string) => Promise<string>): Promise<{ expiresAt: string }> {
  const saved = readSaved();
  const deviceId: string = saved.deviceId ?? randomUUID();
  const email = process.env.PAJ_EMAIL;
  if (!email) throw new Error("PAJ_EMAIL missing from .env");
  await pajCall("/pub/initiate", { method: "POST", apiKey: true, body: { email } });
  const otp = (await askCode(email)).trim();
  const v = await pajCall("/pub/verify", {
    method: "POST", apiKey: true,
    body: { email, otp, device: { uuid: deviceId, device: "Desktop", os: "MacOS" } },
  });
  writeFileSync(FILES.session, JSON.stringify({ token: v.token, expiresAt: v.expiresAt, deviceId }, null, 2), { mode: 0o600 });
  return { expiresAt: v.expiresAt };
}

// Interactive version, kept for the step scripts.
export async function getSession(): Promise<string> {
  try { return loadSession(); } catch { /* fall through to login */ }
  await login(async (email) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = await rl.question(`PAJ sent a code to ${email}. Type it here: `);
    rl.close();
    return code;
  });
  return loadSession();
}

// ---------- Names and banks ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export const sameName = (a: string, b: string) =>
  !!a && !!b && norm(a).split(" ").sort().join(" ") === norm(b).split(" ").sort().join(" ");

let bankCache: { at: number; banks: any[] } | null = null;
export async function listBanks(token: string): Promise<{ id: string; name: string; code: string }[]> {
  if (!bankCache || Date.now() - bankCache.at > 3600_000) {
    const raw: any[] = await pajCall("/pub/bank", { token });
    bankCache = { at: Date.now(), banks: raw.filter((b) => typeof b.name === "string" && b.name.trim()) };
  }
  return bankCache.banks.map((b) => ({ id: b.id, name: b.name, code: b.code }));
}

// Banks matching what someone typed: exact name first, then names containing every typed word.
export async function searchBanks(token: string, typed: string) {
  const banks = await listBanks(token);
  for (const want of [...new Set([norm(ALIASES[norm(typed)] ?? typed), norm(typed)])]) {
    const exact = banks.filter((b) => norm(b.name) === want);
    if (exact.length) return exact;
    const words = want.split(" ");
    const partial = banks.filter((b) => { const n = ` ${norm(b.name)} `; return words.every((w) => n.includes(` ${w} `) || n.includes(` ${w}`)); });
    if (partial.length) return partial;
  }
  return [];
}

// Exactly one bank, or an error listing the choices. Never guesses.
export async function findBank(token: string, typed: string) {
  const found = await searchBanks(token, typed);
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`No bank matching "${typed}". Use list_banks to search.`);
  throw new Error(`"${typed}" matches ${found.length} banks: ${found.slice(0, 10).map((b) => b.name).join("; ")}. Ask which one.`);
}

// ---------- Accounts, rates, orders ----------

export async function confirmAccount(token: string, bankId: string, accountNumber: string) {
  if (!/^\d{10}$/.test(accountNumber)) throw new Error("Account number must be exactly 10 digits.");
  return pajCall(`/pub/bank-account/confirm?bankId=${encodeURIComponent(bankId)}&accountNumber=${accountNumber}`, { token });
}

export async function saveAccount(token: string, bankId: string, accountNumber: string) {
  return pajCall("/pub/bank-account", { method: "POST", token, body: { bankId, accountNumber } });
}

export async function getOfframpRate(): Promise<{ rate: number; createdAt?: string }> {
  return pajCall("/pub/rate/offRamp");
}

export async function createOfframp(token: string, o: { bankId: string; accountNumber: string; ngn: number; feeUsdc?: number; description?: string }) {
  const body: Record<string, unknown> = {
    bank: o.bankId, accountNumber: o.accountNumber, currency: "NGN",
    fiatAmount: o.ngn, mint: USDC_MINT, chain: "SOLANA", description: o.description ?? "PayBot payout",
  };
  if (o.feeUsdc) body.businessUSDCFee = o.feeUsdc;
  return pajCall("/pub/offramp", { method: "POST", token, body });
}

export async function getTransaction(token: string, id: string) {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error(`Not a PAJ order id: ${id}`);
  return pajCall(`/pub/transactions/${id}`, { token });
}
