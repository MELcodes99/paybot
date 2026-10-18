// /pay end to end with two Telegram users and fake Telegram, PayBox and database. No network, no money.
process.env.ENCRYPTION_KEY = "33".repeat(32);
const { createPaybot } = await import("../lib/telegram.ts");
const { memoryStore } = await import("../lib/bot-store.ts");

const MEL = { id: 1001, username: "Mel_O", first_name: "Mel" };
const ADA = { id: 2002, username: "ada_okafor", first_name: "Ada", last_name: "Okafor" };
const STRANGER = { id: 3003, username: "stranger_x", first_name: "S" };
const WALLETS: Record<number, string> = { 1001: "3YWrKex5whNtK5QeXaPGDrBZwcAqMsgRigxwFgA3kZ8M", 2002: "7JqsrYeUEcCHKoJ5igv4J8dD9mMfE7Qd514gmv3co4LZ" };

const sent: { method: string; payload: any }[] = [];
const tasks: Promise<void>[] = [];
const transfers: any[] = [];
let transferResult: any = { status: "completed", explorer: "https://solscan.io/tx/TX" };
const profiles: Record<number, any> = { 1001: MEL, 2002: ADA };

const store = memoryStore();
const bot = createPaybot("123:TEST", {
  store,
  botInfo: { id: 42, is_bot: true, first_name: "PayBot", username: "PayBotNaira_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false },
  background: (task) => { tasks.push(task()); },
  connect: {
    startDeviceLogin: async () => ({ clientId: "c", deviceCode: "d", userCode: "WXYZ-1234", url: "https://app.paybox.sh/connect", intervalSec: 1, expiresAt: Date.now() + 60_000, resource: "r" }),
    finishDeviceLogin: async () => ({ clientId: "c", accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, resource: "r" }),
    startPairing: async () => ({ pairingId: "p", url: "https://app.paybox.sh/agent-key", code: ["🎧", "🌈", "🚂", "🧢", "🐬", "💡", "🛴", "🎍"], signingKey: "pbxk1.KEY" }),
    finishPairing: async (p: any) => p.signingKey,
  } as any,
  clientFor: (async (conn: any) => ({ client: { owner: conn.signingKey }, conn })) as any,
  // Each user's own wallet, decided by whose connection is asking.
  solanaWallet: (async (client: any) => ({ credentialId: "sol", address: client.wallet ?? WALLETS[currentConnector] })) as any,
  balances: (async () => ({ usdc: 10, sol: 0.03 })) as any,
  getChat: async (id: number) => { if (!profiles[id]) throw new Error("chat not found"); return profiles[id]; },
  sendTransfer: (async (t: any, ctx: any) => { transfers.push({ t, ctx }); if (transferResult.status === "completed") await ctx.store.save({ ...t, requestId: "req", payboxStatus: "success" }); return transferResult; }) as any,
});
let currentConnector = 0;
bot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload });
  return { ok: true, result: method === "sendMessage" ? { message_id: sent.length, date: 0, chat: { id: (payload as any).chat_id, type: "private" }, text: (payload as any).text } : true } as any;
});

let updateId = 0;
const msg = (from: any, text: string, chatId = from.id) => bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 0, chat: chatId < 0 ? { id: chatId, type: "group", title: "g" } : { id: chatId, type: "private", first_name: from.first_name }, from: { is_bot: false, ...from }, text, ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}) } } as any);
const tap = (from: any, data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: { id: String(updateId), from: { is_bot: false, ...from }, chat_instance: "ci", data, message: { message_id: 1, date: 0, chat: { id: from.id, type: "private", first_name: "x" }, text: "t" } } } as any);
const settle = async () => { while (tasks.length) await tasks.shift(); };
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const msgs = () => sent.filter((s) => s.method === "sendMessage" || s.method === "editMessageText");
const last = () => plain(msgs().at(-1)?.payload.text ?? "");
const lastTo = (chatId: number) => plain(msgs().filter((s) => s.payload.chat_id === chatId).at(-1)?.payload.text ?? "");
const lastMarkup = () => JSON.stringify(sent.filter((s) => s.method === "sendMessage").at(-1)?.payload.reply_markup ?? {});
const lastTransfer = () => [...store.transfers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;

let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra.replace(/\n/g, " | ").slice(0, 120) : ""}`); };

async function connect(u: any) { currentConnector = u.id; await msg(u, "/connect"); await settle(); }

await msg(MEL, "/pay @ada_okafor 5");
check("paying before connecting asks you to /connect", last().includes("/connect") && store.transfers.size === 0, last());

await connect(MEL);
check("connecting shows how friends can pay you", last().includes("Connected!") && last().includes("/pay @Mel_O 5"), last());
check("every reply is sent as formatted HTML", msgs().every((s) => s.payload.parse_mode === "HTML"));
check("connected users are findable by @username (any case)", (await store.findHandle("@MEL_O"))?.telegramId === MEL.id);

await msg(MEL, "/pay @ada_okafor 5");
check("paying someone who hasn't joined sends an invite, not money", last().includes("isn't on PayBot yet") && lastMarkup().includes("t.me/share/url") && transfers.length === 0, last());

await msg(STRANGER, "/start");
check("people who never connected are not listed", !(await store.findHandle("stranger_x")));

await connect(ADA);
await msg(MEL, "/pay @mel_o 1");
check("paying yourself is refused", last().includes("That's you") && store.transfers.size === 0, last());

await msg(MEL, "/pay @ada_okafor 2.5 for <b>lunch</b> & drinks");
const t1 = lastTransfer();
check("a /pay shows name, handle, amount, note and wallet with Confirm/Cancel",
  last().includes("Ada Okafor (@ada_okafor)") && last().includes("2.5 USDC") && last().includes("Note: <b>lunch</b> & drinks") && last().includes("7Jqs...o4LZ") && lastMarkup().includes(`pc:${t1.transferId}`), last());
check("user text is escaped, never parsed as formatting", (msgs().at(-1)!.payload.text as string).includes("&lt;b&gt;lunch&lt;/b&gt; &amp; drinks"));
check("the payment records both wallets from PayBox, not from the chat", t1.fromAddress === WALLETS[MEL.id] && t1.toAddress === WALLETS[ADA.id] && t1.usdc === 2.5);

await tap(STRANGER, `pc:${t1.transferId}`);
await tap(ADA, `pc:${t1.transferId}`);
await settle();
check("only the sender can confirm", transfers.length === 0 && sent.at(-1)?.payload.text?.includes("isn't yours"));

await tap(MEL, `pc:${t1.transferId}`);
await settle();
check("Confirm sends with the sender's own PayBox connection", transfers.length === 1 && transfers[0].ctx.client.owner === "pbxk1.KEY" && transfers[0].t.transferId === t1.transferId);
check("the sender gets a receipt with the Solscan link", lastTo(MEL.id).includes("Sent! 2.5 USDC to Ada Okafor (@ada_okafor)") && JSON.stringify(msgs().filter((s) => s.payload.chat_id === MEL.id).at(-1)?.payload).includes("solscan.io/tx/TX"), lastTo(MEL.id));
check("the recipient is told the money landed", lastTo(ADA.id).includes("You received 2.5 USDC!") && lastTo(ADA.id).includes("From: Mel (@mel_o)"), lastTo(ADA.id));
check("the recipient is only told once", !!(await store.getTransfer(t1.transferId))?.notifiedAt);

await tap(MEL, `px:${t1.transferId}`);
check("Cancel after sending is refused", sent.at(-1)?.payload.text?.includes("can't be cancelled"));

// Plain text and /send both reach /pay when there is an @handle.
await msg(MEL, "pay @ada_okafor 1");
check("plain 'pay @user 1' works without the slash", last().includes("Confirm payment") && lastTransfer().usdc === 1, last());
await msg(MEL, "/send @ada_okafor 3");
check("/send @user goes to /pay", last().includes("Confirm payment") && lastTransfer().usdc === 3, last());

// Recipient disconnects between the confirm screen and the tap.
await msg(MEL, "/pay @ada_okafor 4");
const t2 = lastTransfer();
await msg(ADA, "/disconnect");
await tap(MEL, `pc:${t2.transferId}`);
await settle();
check("if the recipient removes their wallet before Confirm, nothing is sent", transfers.length === 1 && last().includes("changed or removed"), last());
check("and they can no longer be found", !(await store.findHandle("ada_okafor")));
await connect(ADA);

// Expired confirmation.
await msg(MEL, "/pay @ada_okafor 1");
const t3 = lastTransfer();
store.transfers.set(t3.transferId, { ...t3, createdAt: new Date(Date.now() - 20 * 60_000).toISOString() });
await tap(MEL, `pc:${t3.transferId}`);
await settle();
check("an expired payment can't be confirmed", transfers.length === 1 && last().includes("expired"), last());

// Approval mode.
await msg(MEL, "/pay @ada_okafor 1");
const t4 = lastTransfer();
transferResult = { status: "needs_approval" };
await tap(MEL, `pc:${t4.transferId}`);
await settle();
check("approval-required payments get a Check button", last().includes("Approve this payment in the PayBox app") && lastMarkup().includes(`pr:${t4.transferId}`), last());

// Someone else takes over a handle: Ada changes hers, a new account now uses "ada_okafor".
profiles[ADA.id] = { ...ADA, username: "ada_new" };
await msg(MEL, "/pay @ada_okafor 1");
check("a handle that moved to someone else is refused", last().includes("no longer belongs") && !(await store.findHandle("ada_okafor")), last());
check("and the old owner is re-indexed under their new handle", (await store.findHandle("ada_new"))?.telegramId === ADA.id);

// Recipient blocked the bot.
delete profiles[ADA.id];
await msg(MEL, "/pay @ada_new 1");
check("if the recipient can't be reached, nothing is prepared", last().includes("couldn't reach") , last());
profiles[ADA.id] = { ...ADA, username: "ada_new" };

transferResult = { status: "not_sent", reason: "Your wallet has 1 USDC and this needs 9. Top up and try again. Nothing was sent." };
await msg(MEL, "/pay @ada_new 9");
await tap(MEL, `pc:${lastTransfer().transferId}`);
await settle();
check("a payment that can't go through says why", last().includes("Top up") , last());

await msg(MEL, "/history");
check("sender history lists sent payments with status", last().includes("↗️ 2.5 USDC to Ada Okafor (@ada_okafor)") && last().includes("✅ sent"), last());
await msg({ ...ADA, username: "ada_new" }, "/history");
check("recipient history lists only money that arrived", last().includes("↙️ 2.5 USDC from Mel (@mel_o)") && !last().includes("4 USDC"), last());

await msg(MEL, "/pay @ada_new 1", -5005);
check("/pay is refused in group chats", last().includes("private chat"), last());

check("no reply uses an em dash", msgs().every((s) => !String(s.payload.text).includes("—")));
process.exit(ok ? 0 : 1);
