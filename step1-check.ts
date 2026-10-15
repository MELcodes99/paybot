// PayBot step 1: read-only PAJ check. Moves NO money and creates NO order.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const BASE = process.env.PAJ_BASE_URL ?? "https://api.paj.cash";
const API_KEY = process.env.PAJ_API_KEY;
const EMAIL = process.env.PAJ_EMAIL;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const TEST = {
  bank: "Opay",
  accountNumber: "8161859340",
  expectedName: "Somtochukwu Mel Okoye",
  ngn: 5000,
};

// Common names people type, mapped to PAJ's official bank names.
const ALIASES: Record<string, string> = {
  gtbank: "guaranty trust bank", gtb: "guaranty trust bank", gtco: "guaranty trust bank",
  uba: "united bank for africa", ecobank: "ecobank plc", opay: "opay",
  firstbank: "first bank of nigeria", "first bank": "first bank of nigeria",
  zenith: "zenith bank", access: "access bank", kuda: "kuda microfinance bank",
  moniepoint: "moniepoint microfinance bank", palmpay: "palmpay",
};

if (!API_KEY || !EMAIL) {
  console.error("Missing PAJ_API_KEY or PAJ_EMAIL in your .env file.");
  process.exit(1);
}

async function call(path: string, opts: { method?: string; body?: unknown; token?: string; apiKey?: boolean } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) headers["x-api-key"] = API_KEY!;
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

async function getSession(): Promise<string> {
  const file = ".paj-session.json";
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const deviceId: string = saved.deviceId ?? randomUUID();
  if (saved.token && saved.expiresAt && new Date(saved.expiresAt).getTime() > Date.now() + 60_000) {
    console.log(`Using saved PAJ session (expires ${saved.expiresAt}).`);
    return saved.token;
  }
  await call("/pub/initiate", { method: "POST", apiKey: true, body: { email: EMAIL } });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const otp = (await rl.question(`PAJ sent a code to ${EMAIL}. Type it here: `)).trim();
  rl.close();
  const v = await call("/pub/verify", {
    method: "POST",
    apiKey: true,
    body: { email: EMAIL, otp, device: { uuid: deviceId, device: "Desktop", os: "MacOS" } },
  });
  writeFileSync(file, JSON.stringify({ token: v.token, expiresAt: v.expiresAt, deviceId }, null, 2));
  console.log(`Logged in. Session expires ${v.expiresAt}.`);
  return v.token;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => norm(s).toUpperCase().split(" ").filter(Boolean).sort().join(" ");

// Strict bank finder: exact name, then alias, then a single clear partial match. Never guesses.
function findBank(banks: any[], typed: string) {
  const named = banks.filter((b) => typeof b.name === "string" && b.name.trim());
  const want = norm(ALIASES[norm(typed)] ?? typed);
  const exact = named.filter((b) => norm(b.name) === want);
  if (exact.length === 1) return exact[0];
  const partial = named.filter((b) => norm(b.name).split(" ").join(" ").includes(want));
  if (partial.length === 1) return partial[0];
  const shown = (exact.length ? exact : partial).map((b) => b.name);
  throw new Error(
    shown.length
      ? `"${typed}" matches several banks: ${shown.join(", ")}. Be more specific.`
      : `No bank called "${typed}" found.`,
  );
}

async function main() {
  const token = await getSession();

  console.log("\n1) Bank");
  const banks: any[] = await call("/pub/bank", { token });
  const bank = findBank(banks, TEST.bank);
  console.log(`Found: ${bank.name} (code ${bank.code}, id ${bank.id}). PAJ lists ${banks.length} banks.`);

  console.log("\n2) Account check");
  const acct = await call(
    `/pub/bank-account/confirm?bankId=${encodeURIComponent(bank.id)}&accountNumber=${TEST.accountNumber}`,
    { token },
  );
  console.log("Bank says this account belongs to:", acct.accountName);
  const nameOk = words(acct.accountName) === words(TEST.expectedName);
  console.log(nameOk ? "Name MATCHES what you typed." : `Name does NOT exactly match "${TEST.expectedName}".`);

  console.log("\n3) Rates");
  const offRamp = await call("/pub/rate/offRamp");
  console.log("Offramp rate:", offRamp);
  const value = await call(`/pub/rates/offramp-value?amount=1&mint=${USDC_MINT}&currency=NGN`, { token });
  console.log("1 USDC pays out:", value);
  const usdc = TEST.ngn / offRamp.rate;
  console.log(`\nEstimate: N${TEST.ngn.toLocaleString()} needs about ${usdc.toFixed(6)} USDC (before PAJ fees).`);
  console.log("\nDone. No money moved. Paste everything above back to Claude.");
}

main().catch((e) => {
  console.error("\nSTOPPED:", e.message);
  process.exit(1);
});
