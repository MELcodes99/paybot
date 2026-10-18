// Turns a chat message into { handle, usdc, note } for paying another Telegram user.
// Shapes it understands:
//   /pay @mel 10
//   /pay @mel 2.5 usdc for lunch
//   pay @ada_o $5 thanks for the design
//   tip @mel 1
//   /pay 10 @mel
// The recipient's name and wallet are always shown before anything is paid, so a wrong
// guess here can never move money; it only produces a confirmation the user rejects.

export type PayRequest = { handle: string; usdc: number; note?: string };

// Telegram usernames: 5 to 32 characters, letters, digits and underscores, starting with a letter.
const HANDLE = /^@([A-Za-z][A-Za-z0-9_]{4,31})$/;
const FILLER = new Set(["pay", "tip", "send", "give", "please", "pls", "abeg", "to", "usdc", "usd", "dollar", "dollars", "$"]);
export const MIN_USDC = 0.01;

function amountOf(token: string): number | null {
  const m = token.toLowerCase().replace(/^\$/, "").replace(/(usdc|usd)$/, "").match(/^(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [, raw] = m;
  if ((raw.split(".")[1] ?? "").length > 6) return null; // USDC has 6 decimals
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function looksLikePay(text: string): boolean {
  return /(^|\s)@[A-Za-z][A-Za-z0-9_]{4,31}\b/.test(text);
}

export function parsePay(text: string): PayRequest | { error: string } {
  const help = "Try: /pay @username 5";
  const cleaned = text.replace(/^\/(pay|tip)(@\w+)?/i, " ").replace(/[,;:!]+(\s|$)/g, " ").replace(/\s+/g, " ").trim();
  if (/(₦|\bnaira\b|\bngn\b)/i.test(cleaned)) {
    return { error: "/pay sends USDC to another PayBot user. To send naira to a bank account, use /send." };
  }
  const tokens = cleaned.split(" ").filter(Boolean);

  const handles = tokens.filter((t) => HANDLE.test(t));
  if (!handles.length) return { error: `Who should I pay? ${help}` };
  if (new Set(handles.map((h) => h.toLowerCase())).size > 1) return { error: "I can pay one person at a time. Send a separate /pay for each." };
  const handle = handles[0].slice(1).toLowerCase();

  const amtIdx = tokens.findIndex((t) => !HANDLE.test(t) && amountOf(t) !== null);
  if (amtIdx < 0) return { error: `How much USDC? ${help}` };
  const usdc = amountOf(tokens[amtIdx])!;
  if (usdc < MIN_USDC) return { error: `The smallest payment is ${MIN_USDC} USDC.` };

  // Note: whatever is left after the amount and handle, minus command words. "for" only starts it.
  const rest = tokens.filter((t, i) => i !== amtIdx && !HANDLE.test(t) && !FILLER.has(t.toLowerCase()));
  if (rest[0]?.toLowerCase() === "for") rest.shift();
  const note = rest.join(" ").slice(0, 100).trim();

  return { handle, usdc, ...(note ? { note } : {}) };
}
