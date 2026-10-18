// Paying Telegram users from any PayBox agent: /telegram/resolve and /telegram/notify. No network, no money.
process.env.PAYBOT_NO_LISTEN = "1";
process.env.ENCRYPTION_KEY = "44".repeat(32);
process.env.PUBLIC_URL = "https://paybot.example";
delete process.env.PAY_TO_SOL; delete process.env.PAY_TO_EVM;

const { app, useTelegramForTests } = await import("../server.ts");
const { memoryStore } = await import("../lib/bot-store.ts");
const { usdcReceived } = await import("../lib/tg-service.ts");

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ADA_WALLET = "7JqsrYeUEcCHKoJ5igv4J8dD9mMfE7Qd514gmv3co4LZ";
const SIG = "5".repeat(88);
const OTHER_SIG = "4".repeat(88);

let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra.slice(0, 140) : ""}`); };
const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const offline = await post("/telegram/resolve", { username: "ada_okafor" });
check("resolve says offline (not charged) when the bot isn't running", offline.status === 503);

const store = memoryStore();
const conn = { clientId: "c", accessToken: "a", refreshToken: "r", resource: "x", signingKey: "k" };
await store.saveUser({ telegramId: 2002, conn, walletAddress: ADA_WALLET });
await store.saveHandle(2002, "ada_okafor", "Ada Okafor");
await store.saveUser({ telegramId: 3003, conn }); // connection never finished: no wallet
await store.saveHandle(3003, "half_done", "Half");

const profiles: Record<number, any> = { 2002: { username: "Ada_Okafor", first_name: "Ada", last_name: "Okafor" }, 3003: { username: "half_done" } };
const dms: { id: number; html: string }[] = [];
const announced = new Set<string>();
const txs: Record<string, any> = {
  [SIG]: { meta: { err: null,
    preTokenBalances: [{ mint: USDC, owner: ADA_WALLET, uiTokenAmount: { amount: "1000000" } }],
    postTokenBalances: [{ mint: USDC, owner: ADA_WALLET, uiTokenAmount: { amount: "3500000" } }] } },
  [OTHER_SIG]: { meta: { err: null, preTokenBalances: [], postTokenBalances: [{ mint: USDC, owner: "SomeoneElse", uiTokenAmount: { amount: "9000000" } }] } },
};
useTelegramForTests({
  store, botUsername: "PayBotNaira_bot",
  getChat: async (id) => { if (!profiles[id]) throw new Error("blocked"); return profiles[id]; },
  sendMessage: async (id, html) => { dms.push({ id, html }); },
  getTransaction: async (sig) => txs[sig] ?? null,
  notified: { has: (s) => announced.has(s), add: (s) => { announced.add(s); } },
});

const r1 = await post("/telegram/resolve", { username: "@ADA_OKAFOR" });
const j1: any = await r1.json();
check("a connected user resolves to their PayBox wallet", r1.status === 200 && j1.found && j1.address === ADA_WALLET && j1.chain === "solana:mainnet" && j1.token === USDC, JSON.stringify(j1));
check("with a confirm text naming them", j1.confirm.includes("Ada Okafor (@ada_okafor)") && j1.confirm.includes("7Jqs...o4LZ"), j1.confirm);
check("and the exact PayBox and notify steps", j1.paybox.tool === "request_transfer" && j1.paybox.args.to === ADA_WALLET && j1.notify.url === "https://paybot.example/telegram/notify");

const r2 = await post("/telegram/resolve", { username: "nobody_here" });
const j2: any = await r2.json();
check("unknown users: 404, not charged, with an invite hint", r2.status === 404 && j2.charged === false && j2.reason.includes("t.me/PayBotNaira_bot"), j2.reason);
check("half-finished connections are not findable", (await post("/telegram/resolve", { username: "half_done" })).status === 404);
check("invalid usernames are rejected before any lookup", (await post("/telegram/resolve", { username: "a b" })).status === 400 && (await post("/telegram/resolve", {})).status === 400);

profiles[2002] = { username: "ada_new", first_name: "Ada" };
const r3 = await post("/telegram/resolve", { username: "ada_okafor" });
check("a handle that changed hands is refused", r3.status === 404 && ((await r3.json()) as any).reason.includes("no longer belongs"));
check("and the person is re-indexed under their new handle", (await store.findHandle("ada_new"))?.telegramId === 2002);
delete profiles[2002];
check("unreachable users are not resolved", (await post("/telegram/resolve", { username: "ada_new" })).status === 404);
profiles[2002] = { username: "ada_new", first_name: "Ada", last_name: "Okafor" };

// notify
const n0 = await post("/telegram/notify", { username: "ada_new", signature: "not-a-sig" });
check("notify needs a real signature", n0.status === 422 && dms.length === 0);
const n1 = await post("/telegram/notify", { username: "ada_new", signature: OTHER_SIG });
check("a transaction that didn't pay them is not announced", n1.status === 422 && dms.length === 0);
const n2 = await post("/telegram/notify", { username: "ada_new", signature: "3".repeat(88) });
check("an unconfirmed transaction is not announced", n2.status === 422 && dms.length === 0);
const n3 = await post("/telegram/notify", { username: "ada_new", signature: SIG, note: "lunch <3" });
const j3: any = await n3.json();
check("a real payment is announced with the on-chain amount", n3.status === 200 && j3.usdc === 2.5 && dms.length === 1 && dms[0].id === 2002, JSON.stringify(j3));
check("the message shows the amount, note (escaped) and Solscan link", dms[0].html.includes("You received 2.5 USDC!") && dms[0].html.includes("lunch &lt;3") && dms[0].html.includes(`solscan.io/tx/${SIG}`), dms[0].html);
const n4 = await post("/telegram/notify", { username: "ada_new", signature: SIG });
check("the same payment is never announced twice", n4.status === 422 && dms.length === 1);

check("failed transactions count as nothing received", usdcReceived({ meta: { err: { x: 1 }, preTokenBalances: [], postTokenBalances: [{ mint: USDC, owner: ADA_WALLET, uiTokenAmount: { amount: "5" } }] } }, ADA_WALLET) === 0);

const llms = await (await app.request("/llms.txt")).text();
const spec: any = await (await app.request("/openapi.json")).json();
check("agents can discover the Telegram flow", llms.includes("/telegram/resolve") && llms.includes("/telegram/notify") && !!spec.paths["/telegram/resolve"].post["x-payment-info"] && spec.info["x-guidance"].includes("Telegram"));
check("no em dashes in agent docs or messages", !llms.includes("—") && !dms[0].html.includes("—"));
process.exit(ok ? 0 : 1);
