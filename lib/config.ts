// Shared settings. Loads .env from the project folder, quietly
// (anything printed to the screen would break the Claude Code connection).
import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env"), quiet: true });

// Where the PAJ session and payout records live (tests point this at a temp folder).
const DATA = process.env.PAYBOT_DATA_DIR || ROOT;
export const FILES = {
  session: join(DATA, ".paj-session.json"),
  payouts: join(DATA, "payouts.json"),
};

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const num = (v?: string) => (v && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

export const settings = {
  // Optional business fee in USDC, collected by PAJ inside the same order. Off unless set.
  feeUsdc: num(process.env.PAYBOT_FEE_USDC),
  // Optional cap per payout in naira. Off unless set.
  maxNgn: num(process.env.PAYBOT_MAX_NGN),
  // Optional: which PayBox Solana wallet to use, if you have more than one.
  solCredential: process.env.PAYBOT_SOL_CREDENTIAL?.trim() || undefined,
};

// "1.1" -> 1100000n, exactly (no floating point rounding).
export function toBaseUnits(amount: number | string, decimals = 6): bigint {
  const s = typeof amount === "number" ? amount.toFixed(decimals) : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${amount}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error(`Too many decimals: ${amount}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}
