// PayBot on Telegram. Each user connects their own PayBox wallet once (/connect), then:
//   /send  sends naira to any Nigerian bank account (via PAJ)
//   /pay   sends USDC to another PayBot user by their @username, wallet to wallet
// Every payment shows who gets it and what it costs first, and only moves money after the user
// taps Confirm. Long waits (PayBox login, key pairing, payouts) run in the background so Telegram
// gets its answer immediately.
import { Bot, InlineKeyboard, type Context } from "grammy";
import { createPayout, send, type PayoutStore } from "./payout.ts";
import { balances, solanaWallet, ACCOUNT_RENT_SOL, BASE_FEE_SOL } from "./paybox.ts";
import { clientFor, finishDeviceLogin, finishPairing, startDeviceLogin, startPairing, type Connection } from "./paybox-connect.ts";
import { parseSend } from "./parse-send.ts";
import { looksLikePay, parsePay } from "./parse-pay.ts";
import { newTransferId, sendTransfer, type Transfer, type TransferStore } from "./p2p.ts";
import type { BotPayout, BotStore, BotUser } from "./bot-store.ts";

const QUOTE_TTL_MS = 15 * 60_000;
const naira = (n: number) => `N${n.toLocaleString("en-NG")}`;
const usd = (n: number) => `${+n.toFixed(6)} USDC`;
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

export type PaybotDeps = {
  store: BotStore;
  // Overridable for tests.
  connect?: { startDeviceLogin: typeof startDeviceLogin; finishDeviceLogin: typeof finishDeviceLogin; startPairing: typeof startPairing; finishPairing: typeof finishPairing };
  clientFor?: typeof clientFor;
  createPayout?: typeof createPayout;
  send?: typeof send;
  sendTransfer?: typeof sendTransfer;
  balances?: typeof balances;
  solanaWallet?: typeof solanaWallet;
  // Looks up a user's current Telegram profile (default: Telegram's getChat).
  getChat?: (telegramId: number) => Promise<{ username?: string; first_name?: string; last_name?: string }>;
  background?: (task: () => Promise<void>) => void;
  botInfo?: any;
};

const HELP = [
  "👋 <b>Welcome to PayBot</b>",
  "Send money from your PayBox wallet, right here in Telegram.",
  "",
  "🔗 /connect  link your PayBox wallet (once)",
  "",
  "🏦 <b>Send naira to any Nigerian bank</b>",
  "send 5000 to GTBank 0123456789 Tunde Bakare",
  "/send 20k Opay 8012345678 Ada Okafor",
  "",
  "💸 <b>Pay anyone on PayBot in USDC</b>",
  "/pay @username 5",
  "/pay @username 2.5 for lunch",
  "",
  "🛡️ You always see who you're paying and the cost first. Nothing moves until you tap Confirm.",
  "",
  "👛 /wallet  your balance",
  "📜 /history  your recent activity",
  "🔌 /disconnect  remove your PayBox connection",
].join("\n");

export function createPaybot(token: string, deps: PaybotDeps) {
  const store = deps.store;
  const c = deps.connect ?? { startDeviceLogin, finishDeviceLogin, startPairing, finishPairing };
  const getClient = deps.clientFor ?? clientFor;
  const makePayout = deps.createPayout ?? createPayout;
  const doSend = deps.send ?? send;
  const doTransfer = deps.sendTransfer ?? sendTransfer;
  const getBalances = deps.balances ?? balances;
  const getWallet = deps.solanaWallet ?? solanaWallet;
  const background = deps.background ?? ((task) => { task().catch((e) => console.error("[paybot bot]", e)); });
  const bot = new Bot(token, deps.botInfo ? { botInfo: deps.botInfo } : undefined);
  const getChat = deps.getChat ?? ((id: number) => bot.api.getChat(id) as Promise<any>);

  const say = (ctx: Context, text: string, extra: Record<string, unknown> = {}) => ctx.reply(text, { ...HTML, ...extra });
  const edit = (ctx: Context, text: string) => ctx.editMessageText(text, HTML);

  // One operation at a time per user, so a login refresh is never used twice (PayBox revokes
  // access if an old refresh token is replayed) and a payment is never double-tapped into two sends.
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

  // Views of the bot's database for the shared payout and transfer flows.
  const payoutStore: PayoutStore = {
    get: (id) => store.getPayout(id),
    save: (p) => store.savePayout(p as BotPayout),
  };
  const transferStore: TransferStore = {
    get: (id) => store.getTransfer(id),
    save: (t) => store.saveTransfer(t),
  };

  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") {
      if (ctx.message?.text?.startsWith("/")) await say(ctx, "🔒 For your safety, PayBot only works in a private chat. Message me directly.");
      return;
    }
    await next();
  });

  // Keep the @username index current, so /pay always finds people by the handle they use today.
  // Only connected users are listed. Checked once per change, not on every message.
  const seenProfile = new Map<number, string>();
  const nameOf = (u: { first_name?: string; last_name?: string }) => [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || undefined;
  async function rememberHandle(id: number, profile: { username?: string; first_name?: string; last_name?: string }) {
    await store.saveHandle(id, profile.username, nameOf(profile));
    seenProfile.set(id, `${profile.username ?? ""}|${nameOf(profile) ?? ""}`);
  }
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from && !from.is_bot) {
      const key = `${from.username ?? ""}|${nameOf(from) ?? ""}`;
      if (seenProfile.get(from.id) !== key) {
        try {
          const u = await store.getUser(from.id);
          if (u?.walletAddress) await rememberHandle(from.id, from);
          else seenProfile.set(from.id, key);
        } catch (e) { console.error("[paybot bot] handle update", e); }
      }
    }
    await next();
  });

  bot.command(["start", "help"], (ctx) => say(ctx, HELP));

  // ---------- Connect ----------

  bot.command("connect", async (ctx) => {
    const id = ctx.from!.id;
    const existing = await store.getUser(id);
    if (existing?.conn.signingKey) {
      return say(ctx, `✅ You're already connected (wallet <code>${short(existing.walletAddress)}</code>).\n\nUse /disconnect first if you want to connect a different PayBox account.`);
    }
    if (connecting.has(id)) return say(ctx, "⏳ A connection is already in progress. Finish the steps I sent, or wait a few minutes and try again.");
    connecting.add(id);
    let login;
    try { login = await c.startDeviceLogin("PayBot Telegram"); }
    catch (e: any) { connecting.delete(id); return say(ctx, `⚠️ Couldn't reach PayBox: ${esc(e.message)}`); }
    await say(ctx,
      `🔗 <b>Step 1 of 2: open PayBox and approve</b>\n\n🔢 Code: <code>${esc(login.userCode)}</code>\n\nSign in, check the code matches, and allow your Solana wallet. I'll continue automatically.`,
      { reply_markup: new InlineKeyboard().url("🔓 Open PayBox", login.url) },
    );
    background(async () => {
      try {
        const conn = await c.finishDeviceLogin(login);
        await store.saveUser({ telegramId: id, conn });
        const pairing = await c.startPairing(conn.accessToken);
        await say(ctx,
          `🔑 <b>Step 2 of 2: let PayBot sign for you</b>\n\nYour code:\n${pairing.code.join(" ")}\n\nOpen PayBox and pick these same 8 emoji. ⚠️ If they don't match exactly, stop and don't approve.`,
          { reply_markup: new InlineKeyboard().url("🔓 Open PayBox", pairing.url) },
        );
        conn.signingKey = await c.finishPairing(pairing);
        const user: BotUser = { telegramId: id, conn };
        await locked(id, async () => {
          const client = await userClient(user);
          const w = await getWallet(client);
          user.walletAddress = w.address;
          await store.saveUser(user);
          await rememberHandle(id, ctx.from!);
          const b = await getBalances(client, w.address).catch(() => null);
          await say(ctx, [
            `🎉 <b>Connected!</b>`,
            `👛 Wallet <code>${short(w.address)}</code>${b ? `\n💵 ${b.usdc} USDC\n⛽ ${b.sol} SOL` : ""}`,
            ``,
            `Now try:`,
            `🏦 send 1000 to Opay 8012345678 Ada Okafor`,
            `💸 /pay @username 1`,
            ``,
            receiveHint(ctx.from!.username),
          ].join("\n"));
        });
      } catch (e: any) {
        await say(ctx, `⚠️ Connection stopped: ${esc(e.message)}\n\nRun /connect to try again.`);
      } finally {
        connecting.delete(id);
      }
    });
  });

  bot.command("disconnect", async (ctx) => {
    await store.deleteUser(ctx.from!.id);
    seenProfile.delete(ctx.from!.id);
    await say(ctx, "🔌 <b>Disconnected.</b> PayBot no longer has your PayBox connection, and people can't /pay you here anymore.\n\nTo be thorough, also remove \"PayBot Telegram\" from the Clients screen in the PayBox app.");
  });

  // ---------- Wallet and history ----------

  bot.command("wallet", async (ctx) => {
    const user = await store.getUser(ctx.from!.id);
    if (!user?.conn.signingKey) return say(ctx, "🔗 Not connected yet. Use /connect first.");
    await locked(user.telegramId, async () => {
      const client = await userClient(user);
      const w = await getWallet(client);
      const b = await getBalances(client, w.address);
      await say(ctx, `👛 <b>Your wallet</b> <code>${short(w.address)}</code>\n\n💵 ${b.usdc} USDC\n⛽ ${b.sol} SOL (for network fees)\n\n${receiveHint(ctx.from!.username)}`);
    });
  });

  bot.command("history", async (ctx) => {
    const id = ctx.from!.id;
    const [payouts, transfers] = await Promise.all([store.recentPayouts(id, 5), store.recentTransfers(id, 8)]);
    if (!payouts.length && !transfers.length) return say(ctx, "📭 Nothing yet. Try /pay or /send.");
    const lines = ["📜 <b>Recent activity</b>"];
    if (payouts.length) {
      lines.push("", "🏦 <b>Naira payouts</b>");
      for (const p of payouts) lines.push(`${naira(p.ngn)} to ${esc(p.accountName)} (${esc(p.bank.name)})\n   ${describePayout(p)}`);
    }
    if (transfers.length) {
      lines.push("", "💸 <b>USDC payments</b>");
      for (const t of transfers) {
        lines.push(t.fromId === id
          ? `↗️ ${usd(t.usdc)} to ${who(t.toHandle, t.toName)}${t.note ? ` (${esc(t.note)})` : ""}\n   ${describeTransfer(t)}`
          : `↙️ ${usd(t.usdc)} from ${who(t.fromHandle, t.fromName)}${t.note ? ` (${esc(t.note)})` : ""}\n   ✅ received`);
      }
    }
    await say(ctx, lines.join("\n"));
  });

  // ---------- Send naira ----------

  async function handleSend(ctx: Context, text: string) {
    const parsed = parseSend(text);
    if ("error" in parsed) return say(ctx, `🤔 ${esc(parsed.error)}`);
    const user = await store.getUser(ctx.from!.id);
    if (!user?.conn.signingKey) return say(ctx, "🔗 Connect your PayBox wallet first with /connect. It takes about a minute.");

    await ctx.replyWithChatAction("typing");
    let p;
    try {
      p = await makePayout({ bank: parsed.bank, accountNumber: parsed.accountNumber, ngn: parsed.ngn, expectedName: parsed.name });
    } catch (e: any) {
      return say(ctx, `⚠️ ${esc(e.message.replace("Use list_banks to search.", "Check the bank name.").replace(/ Ask (the user to check the details|which one)\./, ""))}`);
    }

    // Warn before asking for a yes if the wallet can't cover it.
    let warning = "";
    try {
      const client = await locked(user.telegramId, () => userClient(user));
      const b = await getBalances(client, user.walletAddress ?? (await getWallet(client)).address);
      if (b.usdc < p.usdc) warning = `\n\n⚠️ Heads up: your wallet has ${b.usdc} USDC, which isn't enough. Top up before confirming.`;
      else if (b.sol < BASE_FEE_SOL * 2 + ACCOUNT_RENT_SOL) warning = `\n\n⛽ Heads up: your wallet has ${b.sol} SOL. Add about 0.003 SOL for network fees before confirming.`;
    } catch { /* balance check is advisory */ }

    const msg = await say(ctx,
      `🏦 <b>Confirm payout</b>\n\n👤 <b>${esc(p.accountName)}</b>\n🏛️ ${esc(p.bank.name)} <code>${esc(p.accountNumber)}</code>\n💵 <b>${naira(p.ngn)}</b> for ${p.usdc} USDC\n\nIs this the right person?${warning}`,
      { reply_markup: new InlineKeyboard().text("✅ Confirm", `c:${p.payoutId}`).text("❌ Cancel", `x:${p.payoutId}`) },
    );
    await store.savePayout({ ...p, telegramId: user.telegramId, chatId: ctx.chat!.id, messageId: msg.message_id });
  }

  // ---------- Pay another PayBot user (USDC) ----------

  async function handlePay(ctx: Context, text: string) {
    const parsed = parsePay(text);
    if ("error" in parsed) return say(ctx, `🤔 ${esc(parsed.error)}`);
    const sender = await store.getUser(ctx.from!.id);
    if (!sender?.conn.signingKey || !sender.walletAddress) return say(ctx, "🔗 Connect your PayBox wallet first with /connect. It takes about a minute.");

    const rec = await store.findHandle(parsed.handle);
    if (rec?.telegramId === sender.telegramId) return say(ctx, "😅 That's you! Pick someone else to pay.");
    const recUser = rec ? await store.getUser(rec.telegramId) : undefined;
    if (!rec || !recUser?.walletAddress) return inviteReply(ctx, parsed.handle);

    // Make sure the handle still belongs to this person right now (usernames can change hands).
    let profile;
    try { profile = await getChat(rec.telegramId); }
    catch { return say(ctx, `⚠️ I couldn't reach @${esc(parsed.handle)} on Telegram. They may have blocked PayBot. Nothing was sent.`); }
    if (profile.username?.toLowerCase() !== parsed.handle) {
      await rememberHandle(rec.telegramId, profile);
      return say(ctx, `⚠️ @${esc(parsed.handle)} no longer belongs to the PayBot user I knew by that name, so I stopped. Nothing was sent.\n\nAsk them for their current @username.`);
    }
    if (recUser.walletAddress === sender.walletAddress) return say(ctx, "😅 That's your own wallet. Nothing to send.");

    const t: Transfer = {
      transferId: newTransferId(), fromId: sender.telegramId, toId: rec.telegramId,
      toHandle: parsed.handle, toName: nameOf(profile), fromHandle: ctx.from!.username?.toLowerCase(), fromName: nameOf(ctx.from!),
      fromAddress: sender.walletAddress, toAddress: recUser.walletAddress,
      usdc: parsed.usdc, note: parsed.note, chatId: ctx.chat!.id, createdAt: new Date().toISOString(),
    };

    let warning = "";
    try {
      const client = await locked(sender.telegramId, () => userClient(sender));
      const b = await getBalances(client, sender.walletAddress);
      if (b.usdc < t.usdc) warning = `\n\n⚠️ Heads up: your wallet has ${b.usdc} USDC, which isn't enough. Top up before confirming.`;
      else if (b.sol < BASE_FEE_SOL * 2 + ACCOUNT_RENT_SOL) warning = `\n\n⛽ Heads up: your wallet has ${b.sol} SOL. Add about 0.003 SOL for network fees before confirming.`;
    } catch { /* balance check is advisory */ }

    const msg = await say(ctx, [
      `💸 <b>Confirm payment</b>`,
      ``,
      `👤 To: <b>${esc(t.toName ?? "@" + t.toHandle)}</b> (@${esc(t.toHandle)})`,
      `💵 Amount: <b>${usd(t.usdc)}</b>`,
      ...(t.note ? [`📝 Note: ${esc(t.note)}`] : []),
      `👛 Their PayBox wallet: <code>${short(t.toAddress)}</code>`,
      ``,
      `Only tap Confirm if this is the right person.${warning}`,
    ].join("\n"), { reply_markup: new InlineKeyboard().text("✅ Confirm", `pc:${t.transferId}`).text("❌ Cancel", `px:${t.transferId}`) });
    t.messageId = msg.message_id;
    await store.saveTransfer(t);
  }

  function inviteReply(ctx: Context, handle: string) {
    const botLink = `https://t.me/${ctx.me.username}`;
    const share = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent("Join PayBot and connect your PayBox wallet so I can send you USDC right here on Telegram 💸")}`;
    return say(ctx,
      `🤷 @${esc(handle)} isn't on PayBot yet, so there's no wallet to pay. Nothing was sent.\n\n📨 Send them an invite. Once they /connect their PayBox wallet, run your /pay again.`,
      { reply_markup: new InlineKeyboard().url("📨 Invite them", share) },
    );
  }

  bot.command("pay", (ctx) => handlePay(ctx, ctx.message!.text));
  bot.command("tip", (ctx) => handlePay(ctx, ctx.message!.text));
  bot.command("send", (ctx) => (looksLikePay(ctx.message!.text) ? handlePay(ctx, ctx.message!.text) : handleSend(ctx, ctx.message!.text)));
  bot.on("message:text", async (ctx) => {
    const t = ctx.message.text.trim();
    if (t.startsWith("/")) return say(ctx, HELP);
    if (looksLikePay(t)) return handlePay(ctx, t);
    if (/\d{3}/.test(t)) return handleSend(ctx, t);
    return say(ctx, HELP);
  });

  // ---------- Buttons: naira payouts ----------

  bot.callbackQuery(/^(c|x|r):([a-f0-9]{24})$/i, async (ctx) => {
    const [, action, id] = ctx.match as RegExpMatchArray;
    const p = await store.getPayout(id);
    if (!p || p.telegramId !== ctx.from.id) return ctx.answerCallbackQuery({ text: "That payout isn't yours or no longer exists." });

    if (action === "x") {
      if (p.requestId) return ctx.answerCallbackQuery({ text: "Already sent; it can't be cancelled." });
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      return edit(ctx, `❌ <b>Cancelled.</b> Nothing was sent.\n\n${esc(p.accountName)}, ${naira(p.ngn)}`);
    }
    if (action === "c" && !p.requestId && Date.now() - new Date(p.createdAt).getTime() > QUOTE_TTL_MS) {
      await ctx.answerCallbackQuery({ text: "This quote expired" });
      return edit(ctx, `⌛ This quote expired. Nothing was sent.\n\nSend the request again for a fresh rate.`);
    }
    await ctx.answerCallbackQuery({ text: p.requestId ? "Checking" : "Sending" });
    await edit(ctx, `⏳ ${p.requestId ? "Checking" : "Sending"} ${naira(p.ngn)} to ${esc(p.accountName)}...`);

    const user = await store.getUser(ctx.from.id);
    if (!user?.conn.signingKey) return say(ctx, "🔗 Your PayBox connection is gone. Use /connect, then send again.");
    background(() => locked(user.telegramId, async () => {
      try {
        const client = await userClient(user);
        const r: any = await doSend({ payoutId: p.payoutId, confirmedAccountName: p.accountName }, { client, store: payoutStore });
        if (r.status === "completed") {
          await say(ctx, `✅ <b>Done!</b> ${naira(p.ngn)} paid to ${esc(p.accountName)} (${esc(p.bank.name)} ${esc(p.accountNumber)}).${r.explorer ? `\n\n🔗 <a href="${esc(r.explorer)}">View on Solscan</a>` : ""}`);
        } else if (r.status === "needs_approval") {
          await say(ctx, "🔐 PayBox wants your approval. Approve this payment in the PayBox app, then tap Check.", {
            reply_markup: new InlineKeyboard().text("🔄 Check", `r:${p.payoutId}`),
          });
        } else if (r.status === "processing" || r.status === "sent_awaiting_payout") {
          await say(ctx, `⏳ ${esc(r.say)}\n\nDon't send again. Tap Check in a minute.`, { reply_markup: new InlineKeyboard().text("🔄 Check", `r:${p.payoutId}`) });
        } else {
          await say(ctx, `⚠️ ${esc(r.say ?? "The payment didn't go through. Nothing more will be sent for this request.")}`);
        }
      } catch (e: any) {
        await say(ctx, `⚠️ Stopped: ${esc(e.message)}`);
      }
    }));
  });

  // ---------- Buttons: USDC payments ----------

  bot.callbackQuery(/^(pc|px|pr):([a-f0-9]{24})$/i, async (ctx) => {
    const [, action, id] = ctx.match as RegExpMatchArray;
    const t = await store.getTransfer(id);
    if (!t || t.fromId !== ctx.from.id) return ctx.answerCallbackQuery({ text: "That payment isn't yours or no longer exists." });
    const to = who(t.toHandle, t.toName);

    if (action === "px") {
      if (t.requestId) return ctx.answerCallbackQuery({ text: "Already sent; it can't be cancelled." });
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      return edit(ctx, `❌ <b>Cancelled.</b> Nothing was sent.\n\n${usd(t.usdc)} to ${to}`);
    }
    if (!t.requestId) {
      if (Date.now() - new Date(t.createdAt).getTime() > QUOTE_TTL_MS) {
        await ctx.answerCallbackQuery({ text: "This payment expired" });
        return edit(ctx, `⌛ This payment expired. Nothing was sent.\n\nSend the /pay again.`);
      }
      // The recipient may have disconnected or switched wallets since this was prepared.
      const recUser = await store.getUser(t.toId);
      if (recUser?.walletAddress !== t.toAddress) {
        await ctx.answerCallbackQuery({ text: "Recipient changed" });
        return edit(ctx, `⚠️ ${to} changed or removed their PayBox wallet since you started this payment. Nothing was sent.\n\nSend the /pay again.`);
      }
    }
    await ctx.answerCallbackQuery({ text: t.requestId ? "Checking" : "Sending" });
    await edit(ctx, `⏳ ${t.requestId ? "Checking" : "Sending"} ${usd(t.usdc)} to ${to}...`);

    const user = await store.getUser(ctx.from.id);
    if (!user?.conn.signingKey) return say(ctx, "🔗 Your PayBox connection is gone. Use /connect, then pay again.");
    background(() => locked(user.telegramId, async () => {
      try {
        const client = await userClient(user);
        const fresh = (await store.getTransfer(t.transferId)) ?? t;
        const r = await doTransfer(fresh, { client, store: transferStore });
        if (r.status === "completed") {
          await say(ctx, `✅ <b>Sent!</b> ${usd(fresh.usdc)} to ${to}.${fresh.note ? `\n📝 ${esc(fresh.note)}` : ""}${r.explorer ? `\n\n🔗 <a href="${esc(r.explorer)}">View on Solscan</a>` : ""}`);
          await notifyRecipient(fresh, r.explorer);
        } else if (r.status === "needs_approval") {
          await say(ctx, "🔐 PayBox wants your approval. Approve this payment in the PayBox app, then tap Check.", {
            reply_markup: new InlineKeyboard().text("🔄 Check", `pr:${t.transferId}`),
          });
        } else if (r.status === "processing") {
          await say(ctx, "⏳ Still processing on PayBox. Don't send again. Tap Check in a minute.", { reply_markup: new InlineKeyboard().text("🔄 Check", `pr:${t.transferId}`) });
        } else {
          await say(ctx, `⚠️ ${esc(r.reason)}`);
        }
      } catch (e: any) {
        await say(ctx, `⚠️ Stopped: ${esc(e.message)}`);
      }
    }));
  });

  async function notifyRecipient(t: Transfer, explorer?: string) {
    const latest = (await store.getTransfer(t.transferId)) ?? t;
    if (latest.notifiedAt) return;
    try {
      await bot.api.sendMessage(t.toId, [
        `💰 <b>You received ${usd(t.usdc)}!</b>`,
        ``,
        `👤 From: ${who(t.fromHandle, t.fromName)}`,
        ...(t.note ? [`📝 ${esc(t.note)}`] : []),
        `👛 Landed in your PayBox wallet <code>${short(t.toAddress)}</code>`,
        ...(explorer ? [``, `🔗 <a href="${esc(explorer)}">View on Solscan</a>`] : []),
      ].join("\n"), HTML);
      await store.saveTransfer({ ...latest, notifiedAt: new Date().toISOString() });
    } catch (e) { console.error("[paybot bot] notify recipient", e); }
  }

  bot.catch((err) => console.error("[paybot bot]", err.error));
  return bot;
}

function short(a?: string) { return a ? `${a.slice(0, 4)}...${a.slice(-4)}` : "unknown"; }
function who(handle?: string, name?: string) {
  if (handle && name) return `${esc(name)} (@${esc(handle)})`;
  if (handle) return `@${esc(handle)}`;
  return esc(name ?? "a PayBot user");
}
function receiveHint(username?: string) {
  return username
    ? `🙌 Friends can pay you with <code>/pay @${esc(username)} 5</code>`
    : `💡 Set a Telegram username (Settings, then Username) so friends can /pay you.`;
}
function describePayout(p: BotPayout) {
  if (p.pajStatus === "COMPLETED") return "✅ paid";
  if (p.requestId) return `⏳ sent, ${String(p.pajStatus ?? p.payboxStatus ?? "processing").toLowerCase()}`;
  return Date.now() - new Date(p.createdAt).getTime() > QUOTE_TTL_MS ? "⌛ not sent (expired)" : "🕐 waiting for your Confirm";
}
function describeTransfer(t: Transfer) {
  if (t.payboxStatus === "success") return "✅ sent";
  if (t.payboxStatus === "pending_approval") return "🔐 waiting for your approval in PayBox";
  if (t.payboxStatus === "denied" || t.payboxStatus === "error") return "⚠️ failed, nothing sent";
  if (t.requestId) return "⏳ processing";
  return Date.now() - new Date(t.createdAt).getTime() > QUOTE_TTL_MS ? "⌛ not sent (expired)" : "🕐 waiting for your Confirm";
}
