// Telegram's webhook reaches the bot through Hono, and only with Telegram's secret header. No network.
import { Hono } from "hono";
import { webhookCallback } from "grammy";
process.env.ENCRYPTION_KEY = "33".repeat(32);
const { createPaybot } = await import("../lib/telegram.ts");
const { memoryStore } = await import("../lib/bot-store.ts");

const replies: string[] = [];
const bot = createPaybot("123:TEST", { store: memoryStore(), botInfo: { id: 42, is_bot: true, first_name: "PayBot", username: "PayBotNaira_bot" } });
bot.api.config.use(async (_p, method, payload: any) => { if (method === "sendMessage") replies.push(payload.text); return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } } as any; });
const app = new Hono();
app.post("/telegram/s3cret", webhookCallback(bot, "hono", { secretToken: "s3cret" }));
const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 7, type: "private", first_name: "x" }, from: { id: 7, is_bot: false, first_name: "x" }, text: "/help", entities: [{ type: "bot_command", offset: 0, length: 5 }] } };

let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`); };
const bad = await app.request("/telegram/s3cret", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" }, body: JSON.stringify(update) });
check("updates without Telegram's secret are rejected", bad.status === 401 && replies.length === 0, String(bad.status));
const good = await app.request("/telegram/s3cret", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret" }, body: JSON.stringify(update) });
check("Telegram's updates reach the bot and it answers", good.status === 200 && replies[0]?.includes("Welcome to PayBot") && replies[0]?.includes("/pay @username 5"), String(good.status));
process.exit(ok ? 0 : 1);
