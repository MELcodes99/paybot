// Shared PAJ client used by every part of PayBot.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE = process.env.PAJ_BASE_URL ?? "https://api.paj.cash";
const SESSION_FILE = ".paj-session.json";

const ALIASES: Record<string, string> = {
  gtbank: "guaranty trust bank", gtb: "guaranty trust bank", gtco: "guaranty trust bank",
  uba: "united bank for africa", ecobank: "ecobank plc", opay: "opay",
  firstbank: "first bank of nigeria", "first bank": "first bank of nigeria",
  zenith: "zenith bank", access: "access bank", kuda: "kuda microfinance bank",
  moniepoint: "moniepoint microfinance bank", palmpay: "palmpay",
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
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${path} failed (${res.status}): ${text}`);
  return data;
}

export async function getSession(): Promise<string> {
  const saved = existsSync(SESSION_FILE) ? JSON.parse(readFileSync(SESSION_FILE, "utf8")) : {};
  const deviceId: string = saved.deviceId ?? randomUUID();
  if (saved.token && saved.expiresAt && new Date(saved.expiresAt).getTime() > Date.now() + 60_000) return saved.token;
  const email = process.env.PAJ_EMAIL;
  if (!email) throw new Error("PAJ_EMAIL missing from .env");
  await pajCall("/pub/initiate", { method: "POST", apiKey: true, body: { email } });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const otp = (await rl.question(`PAJ sent a code to ${email}. Type it here: `)).trim();
  rl.close();
  const v = await pajCall("/pub/verify", {
    method: "POST", apiKey: true,
    body: { email, otp, device: { uuid: deviceId, device: "Desktop", os: "MacOS" } },
  });
  writeFileSync(SESSION_FILE, JSON.stringify({ token: v.token, expiresAt: v.expiresAt, deviceId }, null, 2));
  return v.token;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export const sameName = (a: string, b: string) =>
  norm(a).split(" ").sort().join(" ") === norm(b).split(" ").sort().join(" ");

export async function findBank(token: string, typed: string) {
  const banks: any[] = await pajCall("/pub/bank", { token });
  const named = banks.filter((b) => typeof b.name === "string" && b.name.trim());
  const want = norm(ALIASES[norm(typed)] ?? typed);
  const exact = named.filter((b) => norm(b.name) === want);
  if (exact.length === 1) return exact[0];
  const partial = named.filter((b) => norm(b.name).includes(want));
  if (partial.length === 1) return partial[0];
  const shown = (exact.length ? exact : partial).map((b) => b.name);
  throw new Error(shown.length ? `"${typed}" matches several banks: ${shown.join(", ")}.` : `No bank called "${typed}".`);
}

export async function confirmAccount(token: string, bankId: string, accountNumber: string) {
  if (!/^\d{10}$/.test(accountNumber)) throw new Error("Account number must be exactly 10 digits.");
  return pajCall(`/pub/bank-account/confirm?bankId=${encodeURIComponent(bankId)}&accountNumber=${accountNumber}`, { token });
}

export async function saveAccount(token: string, bankId: string, accountNumber: string) {
  return pajCall("/pub/bank-account", { method: "POST", token, body: { bankId, accountNumber } });
}

export async function createOfframp(token: string, o: { bankId: string; accountNumber: string; ngn: number; feeUsdc?: number }) {
  const body: Record<string, unknown> = {
    bank: o.bankId, accountNumber: o.accountNumber, currency: "NGN",
    fiatAmount: o.ngn, mint: USDC_MINT, chain: "SOLANA", description: "PayBot payout",
  };
  if (o.feeUsdc) body.businessUSDCFee = o.feeUsdc;
  return pajCall("/pub/offramp", { method: "POST", token, body });
}

export async function getTransaction(token: string, id: string) {
  return pajCall(`/pub/transactions/${id}`, { token });
}
