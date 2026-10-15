// The bot's Postgres code against a real (in-process) Postgres engine. No network.
import { PGlite } from "@electric-sql/pglite";
process.env.ENCRYPTION_KEY = "22".repeat(32);
const { sqlStore } = await import("../lib/bot-store.ts");

const db = new PGlite();
const sql = {
  async query(text: string, params?: unknown[]) {
    if (!params) { const rs = await db.exec(text); const r = rs.at(-1); return { rows: r?.rows ?? [], rowCount: r?.affectedRows ?? 0 }; }
    const r = await db.query(text, params as any[]);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? 0 };
  },
};
const store = await sqlStore(sql);
let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`); };

const conn = { clientId: "c", accessToken: "at", refreshToken: "rt-secret", resource: "r", signingKey: "pbxk1.TOPSECRET" };
await store.saveUser({ telegramId: 1001, conn, walletAddress: "3YWr" });
const raw = await sql.query("select sealed from bot_users where telegram_id = $1", [1001]);
check("connections are stored encrypted", raw.rows[0].sealed.startsWith("v1.") && !raw.rows[0].sealed.includes("TOPSECRET") && !raw.rows[0].sealed.includes("rt-secret"));
check("and read back intact", (await store.getUser(1001))?.conn.signingKey === "pbxk1.TOPSECRET");
await store.saveUser({ telegramId: 1001, conn: { ...conn, refreshToken: "rt-2" } });
check("saving again updates the same user", (await store.getUser(1001))?.conn.refreshToken === "rt-2");

const p = { payoutId: "a".repeat(24), telegramId: 1001, chatId: 1001, bank: { id: "gt", name: "GTB" }, accountNumber: "0123456789", accountName: "TUNDE", ngn: 5000, usdc: 3.69, address: "PAJ", createdAt: new Date().toISOString() };
await store.savePayout(p);
check("payouts round-trip", (await store.getPayout(p.payoutId))?.accountName === "TUNDE");
await store.savePayout({ ...p, requestId: "req-1" });
await store.savePayout({ ...p, requestId: "req-1", signedAt: "now" });
check("updates with the same PayBox request are allowed", (await store.getPayout(p.payoutId))?.signedAt === "now");
let refused = "";
try { await store.savePayout({ ...p, requestId: "req-2" }); } catch (e: any) { refused = e.message; }
check("the database refuses to replace a recorded PayBox request", refused.includes("Refusing") && (await store.getPayout(p.payoutId))?.requestId === "req-1", refused);
let cleared = "";
try { await store.savePayout({ ...p, requestId: undefined }); } catch (e: any) { cleared = e.message; }
check("or to erase it", cleared.includes("Refusing") && (await store.getPayout(p.payoutId))?.requestId === "req-1");
await store.savePayout({ ...p, payoutId: "b".repeat(24), createdAt: new Date(Date.now() + 1000).toISOString() });
await store.savePayout({ ...p, payoutId: "c".repeat(24), telegramId: 2002 });
const mine = await store.recentPayouts(1001, 5);
check("history only shows your own payouts", mine.length === 2 && mine.every((x) => x.telegramId === 1001));
await store.deleteUser(1001);
check("disconnect deletes the connection", !(await store.getUser(1001)));
process.exit(ok ? 0 : 1);
