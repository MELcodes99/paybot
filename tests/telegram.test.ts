// The Telegram bot end to end with fake Telegram, PayBox, PAJ and database. No network, no money.
process.env.ENCRYPTION_KEY = "11".repeat(32);
const { createPaybot } = await import("../lib/telegram.ts");
const { memoryStore } = await import("../lib/bot-store.ts");

const ME = 1001, STRANGER = 2002, GROUP = -5005;
const sent: { method: string; payload: any }[] = [];
const tasks: Promise<void>[] = [];
const calls = { createPayout: [] as any[], send: [] as any[], refreshSaves: 0 };
let sendResult: any = { status: "completed", explorer: "https://solscan.io/tx/TX" };
let payoutSeq = 0;

const store = memoryStore();
const bot = createPaybot("123:TEST", {
  store,
  botInfo: { id: 42, is_bot: true, first_name: "PayBot", username: "PayBotNaira_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false },
  background: (task) => { tasks.push(task()); },
  connect: {
    startDeviceLogin: async () => ({ clientId: "c", deviceCode: "d", userCode: "WXYZ-1234", url: "https://app.paybox.sh/connect?user_code=WXYZ-1234", intervalSec: 1, expiresAt: Date.now() + 60_000, resource: "r" }),
    finishDeviceLogin: async () => ({ clientId: "c", accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, resource: "r" }),
    startPairing: async () => ({ pairingId: "p", url: "https://app.paybox.sh/agent-key?pairing_id=p", code: ["🎧", "🌈", "🚂", "🧢", "🐬", "💡", "🛴", "🎍"], signingKey: "pbxk1.SECRETKEY" }),
    finishPairing: async (p: any) => p.signingKey,
  } as any,
  clientFor: (async (conn: any, save: any) => { calls.refreshSaves++; await save({ ...conn, accessToken: "at2" }); return { client: { id: "client-for-" + conn.signingKey }, conn: { ...conn, accessToken: "at2" } }; }) as any,
  solanaWallet: (async () => ({ credentialId: "sol", address: "3YWrKex5whNtK5QeXaPGDrBZwcAqMsgRigxwFgA3kZ8M" })) as any,
  balances: (async () => ({ usdc: 10, sol: 0.03 })) as any,
  createPayout: (async (a: any) => {
    calls.createPayout.push(a);
    if (a.expectedName && a.expectedName !== "Tunde Bakare") throw new Error(`The bank says Guaranty Trust Bank ${a.accountNumber} belongs to "TUNDE BAKARE", not "${a.expectedName}". Nothing was created. Ask the user to check the details.`);
    payoutSeq++;
    return { payoutId: String(payoutSeq).padStart(24, "a"), bank: { id: "gt", name: "Guaranty Trust Bank" }, accountNumber: a.accountNumber, accountName: "TUNDE BAKARE", ngn: a.ngn, usdc: 3.69, address: "PAJADDR", createdAt: new Date().toISOString() };
  }) as any,
  send: (async (a: any, ctx: any) => { calls.send.push({ a, client: ctx.client }); return sendResult; }) as any,
});
bot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload });
  return { ok: true, result: method === "sendMessage" ? { message_id: sent.length, date: 0, chat: { id: (payload as any).chat_id, type: "private" }, text: (payload as any).text } : true } as any;
});

let updateId = 0;
const msg = (from: number, text: string, chatId = from) => bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 0, chat: chatId < 0 ? { id: chatId, type: "group", title: "g" } : { id: chatId, type: "private", first_name: "x" }, from: { id: from, is_bot: false, first_name: "x" }, text, ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}) } } as any);
const tap = (from: number, data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: { id: String(updateId), from: { id: from, is_bot: false, first_name: "x" }, chat_instance: "ci", data, message: { message_id: 1, date: 0, chat: { id: from, type: "private", first_name: "x" }, text: "t" } } } as any);
const settle = async () => { while (tasks.length) await tasks.shift(); };
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const texts = () => sent.filter((s) => s.method === "sendMessage" || s.method === "editMessageText").map((s) => plain(s.payload.text as string));
const lastRaw = () => JSON.stringify(sent.filter((s) => s.method === "sendMessage").at(-1)?.payload ?? {});
const last = () => texts().at(-1) ?? "";
const lastMarkup = () => sent.filter((s) => s.method === "sendMessage").at(-1)?.payload.reply_markup;

let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra.replace(/\n/g, " | ").slice(0, 110) : ""}`); };

await msg(ME, "send 5000 to GTBank 0123456789 Tunde Bakare");
check("sending before connecting asks you to /connect", last().includes("/connect") && calls.createPayout.length === 0, last());

await msg(GROUP, "/connect", GROUP);
check("refuses to work in group chats", last().includes("private chat"), last());

await msg(ME, "/connect");
const loginMsg = sent.find((s) => s.method === "sendMessage" && String(s.payload.text).includes("WXYZ-1234"));
check("connect sends the PayBox link and login code", !!loginMsg && JSON.stringify(loginMsg.payload.reply_markup).includes("app.paybox.sh/connect"), loginMsg?.payload.text);
await settle();
check("then shows the 8 emoji to match", texts().some((t) => t.includes("🎧 🌈 🚂 🧢 🐬 💡 🛴 🎍")));
check("then confirms the connected wallet and balance", last().includes("Connected!") && last().includes("Wallet 3YWr...kZ8M") && last().includes("10 USDC"), last());
const sealed = store.users.get(ME) ?? "";
check("the stored connection is encrypted (no signing key in the database)", sealed.startsWith("v1.") && !sealed.includes("SECRETKEY") && !sealed.includes("rt"));
check("a renewed PayBox login is saved", (await store.getUser(ME))?.conn.accessToken === "at2");

await msg(ME, "/connect");
check("connecting twice is refused", last().includes("already connected"), last());

await msg(ME, "send 5000 to GTBank 0123456789 Someone Else");
check("a name the bank disagrees with stops before any buttons", last().includes("belongs to") && !last().includes("Ask the user") && store.payouts.size === 0, last());

await msg(ME, "send 5000 to GTBank 0123456789 Tunde Bakare");
const p1 = [...store.payouts.values()][0];
check("a send shows the bank-verified name and cost with Confirm/Cancel", last().includes("TUNDE BAKARE") && last().includes("N5,000 for 3.69 USDC") && JSON.stringify(lastMarkup()).includes(`c:${p1?.payoutId}`), last());
check("the parsed name is passed for the bank check", calls.createPayout.at(-1)?.expectedName === "Tunde Bakare");
check("the payout is recorded for this user only", p1?.telegramId === ME);

await tap(STRANGER, `c:${p1.payoutId}`);
await settle();
check("someone else tapping Confirm does nothing", calls.send.length === 0 && sent.at(-1)?.payload.text?.includes("isn't yours"));

await tap(ME, `c:${p1.payoutId}`);
await settle();
check("Confirm sends with this user's own PayBox client", calls.send.length === 1 && calls.send[0].client.id === "client-for-pbxk1.SECRETKEY" && calls.send[0].a.confirmedAccountName === "TUNDE BAKARE");
check("and reports Done with the transaction link", last().includes("Done! N5,000 paid to TUNDE BAKARE") && lastRaw().includes("solscan"), last());

store.payouts.set(p1.payoutId, { ...store.payouts.get(p1.payoutId)!, requestId: "req-1" });
await tap(ME, `x:${p1.payoutId}`);
check("Cancel after sending is refused", sent.at(-1)?.payload.text?.includes("can't be cancelled"));

await msg(ME, "/send 20k GTBank 0123456789 Tunde Bakare");
const p2 = [...store.payouts.values()].at(-1)!;
store.payouts.set(p2.payoutId, { ...p2, createdAt: new Date(Date.now() - 20 * 60_000).toISOString() });
const before = calls.send.length;
await tap(ME, `c:${p2.payoutId}`);
await settle();
check("an expired quote can't be confirmed", calls.send.length === before && last().includes("expired"), last());

await msg(ME, "pay Tunde Bakare 2,500 on GTBank 0123456789");
const p3 = [...store.payouts.values()].at(-1)!;
sendResult = { status: "needs_approval" };
await tap(ME, `c:${p3.payoutId}`);
await settle();
check("approval-required payouts get a Check button", last().includes("Approve this payment in the PayBox app") && JSON.stringify(lastMarkup()).includes(`r:${p3.payoutId}`), last());

await msg(ME, "/history");
check("history lists recent payouts", last().includes("N5,000 to TUNDE BAKARE"), last());

await msg(ME, "/disconnect");
check("disconnect removes the stored connection", !store.users.has(ME) && last().includes("Clients"));
process.exit(ok ? 0 : 1);
