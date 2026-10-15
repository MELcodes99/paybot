// Turns a chat message into { ngn, bank, accountNumber, name }.
// Shapes it understands:
//   /send 5000 GTBank 0123456789 Tunde Bakare
//   Send 5,000 naira to GTBank 0123456789, Tunde Bakare
//   send 20k to Opay 8012345678 Ada Okafor
//   pay Ada Okafor 20k on Opay 8012345678
//   N5,000 to Access 0123456789
// The bank's verified name is always shown before anything is paid, so a wrong guess here
// can never move money; it only produces a confirmation the user rejects.

export type SendRequest = { ngn: number; bank: string; accountNumber: string; name?: string };

const FILLER = new Set(["send", "pay", "transfer", "please", "pls", "abeg", "naira", "ngn", "n", "to", "on", "at", "in", "into", "for", "the", "my", "account", "acct", "acc", "number", "no", "of", "via"]);

function amountOf(token: string): number | null {
  const m = token.toLowerCase().replace(/^(₦|ngn|n)/, "").match(/^(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function parseSend(text: string): SendRequest | { error: string } {
  const help = 'Try: /send 5000 GTBank 0123456789 Tunde Bakare';
  const cleaned = text.replace(/^\/send(@\w+)?/i, " ").replace(/[,;:]+(\s|$)/g, " ").replace(/\s+/g, " ").trim();
  // Join an account number typed with spaces or dashes ("816 185 9340") into one token.
  const joined = cleaned.replace(/\b(\d{3,4})[\s-](\d{3,4})[\s-](\d{3,4})\b/g, (m, a, b, c) => ((a + b + c).length === 10 ? a + b + c : m));
  const tokens = joined.split(" ").filter(Boolean);

  const accIdx = tokens.findIndex((t) => /^\d{10}$/.test(t));
  if (accIdx < 0) return { error: `I need a 10-digit account number. ${help}` };
  const accountNumber = tokens[accIdx];

  const amtIdx = tokens.findIndex((t, i) => i !== accIdx && amountOf(t) !== null);
  if (amtIdx < 0) return { error: `How much naira? ${help}` };
  const ngn = amountOf(tokens[amtIdx])!;

  const words = (from: number, to: number) => tokens.slice(Math.max(from, 0), Math.max(to, 0)).filter((t, k) => {
    const i = from + k;
    return i !== amtIdx && i !== accIdx && !FILLER.has(t.toLowerCase()) && !/^₦$/.test(t);
  });

  // Bank: the words just before the account number, after the amount (or after "to/on/at").
  const bankStart = amtIdx < accIdx ? amtIdx + 1 : 0;
  let bankWords = words(bankStart, accIdx);
  // Name: words after the account number; otherwise words before the amount ("pay Ada Okafor 20k on Opay ...").
  let nameWords = words(accIdx + 1, tokens.length);
  if (!nameWords.length && amtIdx < accIdx) nameWords = words(0, amtIdx);
  if (!bankWords.length && amtIdx > accIdx) bankWords = words(0, accIdx);
  if (!bankWords.length) return { error: `Which bank? ${help}` };

  return { ngn, bank: bankWords.join(" "), accountNumber, ...(nameWords.length ? { name: nameWords.join(" ") } : {}) };
}
