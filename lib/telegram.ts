// PayBot on Telegram. Each user connects their own PayBox wallet once (/connect), then sends naira
// with one message. Every payout shows the bank-verified name and cost, and only moves money after
// the user taps Confirm. Long waits (PayBox login, key pairing, payouts) run in the background so
// Telegram gets its answer immediately.
import { Bot, InlineKeyboard, type Context } from "grammy";
import { createPayout, send, type PayoutStore } from "./payout.ts";
import { balances, solanaWallet, ACCOUNT_RENT_SOL, BASE_FEE_SOL } from "./paybox.ts";
import { clientFor, finishDeviceLogin, finishPairing, startDeviceLogin, startPairing, type Connection } from "./paybox-connect.ts";
import { parseSend } from "./parse-send.ts";
import type { BotPayout, BotStore, BotUser } from "./bot-store.ts";

const QUOTE_TTL_MS = 15 * 60_000;
const naira = (n: number) => `N${n.toLocaleString("en-NG")}`;

export type PaybotDeps = {
  store: BotStore;
  // Overridable for tests.
  connect?: { startDeviceLogin: typeof startDeviceLogin; finishDeviceLogin: typeof finishDeviceLogin; startPairing: typeof startPairing; finishPairing: typeof finishPairing };
  clientFor?: typeof clientFor;
  createPayout?: typeof createPayout;
  send?: typeof send;
  balances?: typeof balances;
  solanaWallet?: typeof solanaWallet;
  background?: (task: () => Promise<void>) => void;
  botInfo?: any;
};

const HELP = [
  "PayBot sends naira from your PayBox wallet to any Nigerian bank account.",
  "",
  "1. /connect  link your PayBox wallet (once)",
  "2. Send money in one message, for example:",
  "   send 5000 to GTBank 0123456789 Tunde Bakare",
  "   /send 20k Opay 8012345678 Ada Okafor",
  "",
  "You always see the bank-verified name and the cost first. Nothing moves until you tap Confirm.",
  "",
  "/wallet  your balance",
  "/history  your recent payouts",
  "/disconnect  remove your PayBox connection",
].join("\n");

export function createPaybot(token: string, deps: PaybotDeps) {
  const store = deps.store;
  const c = deps.connect ?? { startDeviceLogin, finishDeviceLogin, startPairing, finishPairing };
  const getClient = deps.clientFor ?? clientFor;
  const makePayout = deps.createPayout ?? createPayout;
  const doSend = deps.send ?? send;
  const getBalances = deps.balances ?? balances;
  const getWallet = deps.solanaWallet ?? solanaWallet;
  const background = deps.background ?? ((task) => { task().catch((e) => console.error("[paybot bot]", e)); });
  const bot = new Bot(token, deps.botInfo ? { botInfo: deps.botInfo } : undefined);

  // One operation at a time per user, so a login refresh is never used twice (PayBox revokes
  // access if an old refresh token is replayed) and a payout is never double-tapped into two sends.
  const locks = new Map<number, Promise<unknown>>();
  function locked<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(userId, next);
    return next.finally(() => { if (locks.get(userId) === next) locks.delete(userId); });
  }
  const connecting = new Set<number>();

  async function userClient(user: BotUser) {
    const { client, conn } = await getClient(user.conn, async (fresh: Connection) => {
      user.conn = fresh;
      await store.saveUser(user);
    });
    user.conn = conn;
    return client;
  }

  // A PayoutStore view of the bot's database, for the shared payout flow.
  const payoutStore: PayoutStore = {
    get: (id) => store.getPayout(id),
    save: (p) => store.savePayout(p as BotPayout),
  };

  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") {
      if (ctx.message?.text?.startsWith("/")) await ctx.reply("For your safety, PayBot only works in a private chat. Message me directly.");
      return;
    }
    await next();
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

  // ---------- Connect ----------

  bot.command("connect", async (ctx) => {
    const id = ctx.from!.id;
    const existing = await store.getUser(id);
    if (existing?.conn.signingKey) {
      return ctx.reply(`You're already connected (wallet ${short(existing.walletAddress)}). Use /disconnect first if you want to connect a different PayBox account.`);
    }
    if (connecting.has(id)) return ctx.reply("A connection is already in progress. Finish the steps I sent, or wait a few minutes and try again.");
    connecting.add(id);
    let login;
    try { login = await c.startDeviceLogin("PayBot Telegram"); }
    catch (e: any) { connecting.delete(id); return ctx.reply(`Couldn't reach PayBox: ${e.message}`); }
    await ctx.reply(
      `Step 1 of 2: open PayBox and approve.\n\nCode: ${login.userCode}\n\nSign in, check the code matches, and allow your Solana wallet. I'll continue automatically.`,
      { reply_markup: new InlineKeyboard().url("Open PayBox", login.url) },
    );
    background(async () => {
      try {
        const conn = await c.finishDeviceLogin(login);
        await store.saveUser({ telegramId: id, conn });
        const pairing = await c.startPairing(conn.accessToken);
        await ctx.reply(
          `Step 2 of 2: let PayBot sign for you.\n\nYour code:\n${pairing.code.join(" ")}\n\nOpen PayBox and pick these same 8 emoji. If they don't match exactly, stop and don't approve.`,
          { reply_markup: new InlineKeyboard().url("Open PayBox", pairing.url) },
        );
        conn.signingKey = await c.finishPairing(pairing);
        const user: BotUser = { telegramId: id, conn };
        await locked(id, async () => {
          const client = await userClient(user);
          const w = await getWallet(client);
          user.walletAddress = w.address;
          await store.saveUser(user);
          const b = await getBalances(client, w.address).catch(() => null);
          await ctx.reply(
            `Connected. Wallet ${short(w.address)}${b ? `: ${b.usdc} USDC, ${b.sol} SOL` : ""}.\n\nNow try:\nsend 1000 to Opay 8012345678 Ada Okafor`,
          );
        });
      } catch (e: any) {
        await ctx.reply(`Connection stopped: ${e.message}\nRun /connect to try again.`);
      } finally {
        connecting.delete(id);
      }
    });
  });

  bot.command("disconnect", async (ctx) => {
    await store.deleteUser(ctx.from!.id);
    await ctx.reply("Disconnected. PayBot no longer has your PayBox connection.\n\nTo be thorough, also remove \"PayBot Telegram\" from the Clients screen in the PayBox app.");
  });

  // ---------- Wallet and history ----------

  bot.command("wallet", async (ctx) => {
    const user = await store.getUser(ctx.from!.id);
    if (!user?.conn.signingKey) return ctx.reply("Not connected yet. Use /connect first.");
    await locked(user.telegramId, async () => {
      const client = await userClient(user);
      const w = await getWallet(client);
      const b = await getBalances(client, w.address);
      await ctx.reply(`Wallet ${short(w.address)}\n${b.usdc} USDC\n${b.sol} SOL (for network fees)`);
    });
  });

  bot.command("history", async (ctx) => {
    const list = await store.recentPayouts(ctx.from!.id, 5);
    if (!list.length) return ctx.reply("No payouts yet.");
    await ctx.reply(list.map((p) => `${naira(p.ngn)} to ${p.accountName} (${p.bank.name})\n  ${describe(p)}`).join("\n\n"));
  });

  // ---------- Send ----------

  async function handleSend(ctx: Context, text: string) {
    const parsed = parseSend(text);
    if ("error" in parsed) return ctx.reply(parsed.error);
    const user = await store.getUser(ctx.from!.id);
    if (!user?.conn.signingKey) return ctx.reply("Connect your PayBox wallet first with /connect. It takes about a minute.");

    await ctx.replyWithChatAction("typing");
    let p;
    try {
      p = await makePayout({ bank: parsed.bank, accountNumber: parsed.accountNumber, ngn: parsed.ngn, expectedName: parsed.name });
    } catch (e: any) {
      return ctx.reply(e.message.replace("Use list_banks to search.", "Check the bank name.").replace(/ Ask (the user to check the details|which one)\./, ""));
    }

    // Warn before asking for a yes if the wallet can't cover it.
    let warning = "";
    try {
      const client = await locked(user.telegramId, () => userClient(user));
      const b = await getBalances(client, user.walletAddress ?? (await getWallet(client)).address);
      if (b.usdc < p.usdc) warning = `\n\nHeads up: your wallet has ${b.usdc} USDC, which isn't enough. Top up before confirming.`;
      else if (b.sol < BASE_FEE_SOL * 2 + ACCOUNT_RENT_SOL) warning = `\n\nHeads up: your wallet has ${b.sol} SOL. Add about 0.003 SOL for network fees before confirming.`;
    } catch { /* balance check is advisory */ }

    const msg = await ctx.reply(
      `${p.accountName}\n${p.bank.name} ${p.accountNumber}\n\n${naira(p.ngn)} for ${p.usdc} USDC\n\nIs this the right person?${warning}`,
      { reply_markup: new InlineKeyboard().text("Confirm", `c:${p.payoutId}`).text("Cancel", `x:${p.payoutId}`) },
    );
    await store.savePayout({ ...p, telegramId: user.telegramId, chatId: ctx.chat!.id, messageId: msg.message_id });
  }

  bot.command("send", (ctx) => handleSend(ctx, ctx.message!.text));
  bot.on("message:text", async (ctx) => {
    const t = ctx.message.text.trim();
    if (t.startsWith("/")) return ctx.reply(HELP);
    if (/\d{3}/.test(t)) return handleSend(ctx, t);
    return ctx.reply(HELP);
  });

  // ---------- Buttons ----------

  bot.callbackQuery(/^(c|x|r):([a-f0-9]{24})$/i, async (ctx) => {
    const [, action, id] = ctx.match as RegExpMatchArray;
    const p = await store.getPayout(id);
    if (!p || p.telegramId !== ctx.from.id) return ctx.answerCallbackQuery({ text: "That payout isn't yours or no longer exists." });

    if (action === "x") {
      if (p.requestId) return ctx.answerCallbackQuery({ text: "Already sent; it can't be cancelled." });
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      return ctx.editMessageText(`Cancelled. Nothing was sent.\n\n${p.accountName}, ${naira(p.ngn)}`);
    }
    if (action === "c" && !p.requestId && Date.now() - new Date(p.createdAt).getTime() > QUOTE_TTL_MS) {
      await ctx.answerCallbackQuery({ text: "This quote expired" });
      return ctx.editMessageText(`This quote expired. Nothing was sent. Send the request again for a fresh rate.`);
    }
    await ctx.answerCallbackQuery({ text: p.requestId ? "Checking" : "Sending" });
    await ctx.editMessageText(`${p.requestId ? "Checking" : "Sending"} ${naira(p.ngn)} to ${p.accountName}...`);

    const user = await store.getUser(ctx.from.id);
    if (!user?.conn.signingKey) return ctx.reply("Your PayBox connection is gone. Use /connect, then send again.");
    background(() => locked(user.telegramId, async () => {
      try {
        const client = await userClient(user);
        const r: any = await doSend({ payoutId: p.payoutId, confirmedAccountName: p.accountName }, { client, store: payoutStore });
        if (r.status === "completed") {
          await ctx.reply(`Done. ${naira(p.ngn)} paid to ${p.accountName} (${p.bank.name} ${p.accountNumber}).${r.explorer ? `\n${r.explorer}` : ""}`);
        } else if (r.status === "needs_approval") {
          await ctx.reply("PayBox wants your approval. Approve this payment in the PayBox app, then tap Check.", {
            reply_markup: new InlineKeyboard().text("Check", `r:${p.payoutId}`),
          });
        } else if (r.status === "processing" || r.status === "sent_awaiting_payout") {
          await ctx.reply(`${r.say}\nDon't send again. Tap Check in a minute.`, { reply_markup: new InlineKeyboard().text("Check", `r:${p.payoutId}`) });
        } else {
          await ctx.reply(r.say ?? "The payment didn't go through. Nothing more will be sent for this request.");
        }
      } catch (e: any) {
        await ctx.reply(`Stopped: ${e.message}`);
      }
    }));
  });

  bot.catch((err) => console.error("[paybot bot]", err.error));
  return bot;
}

function short(a?: string) { return a ? `${a.slice(0, 4)}...${a.slice(-4)}` : "unknown"; }
function describe(p: BotPayout) {
  if (p.pajStatus === "COMPLETED") return "paid";
  if (p.requestId) return `sent, ${String(p.pajStatus ?? p.payboxStatus ?? "processing").toLowerCase()}`;
  return Date.now() - new Date(p.createdAt).getTime() > QUOTE_TTL_MS ? "not sent (expired)" : "waiting for your Confirm";
}
