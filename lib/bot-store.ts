// Where the Telegram bot keeps users and payouts. Postgres in production (DATABASE_URL),
// an in-memory version for tests. PayBox connections are always stored encrypted.
import pg from "pg";
import type { Connection } from "./paybox-connect.ts";
import type { Payout } from "./store.ts";
import type { Transfer } from "./p2p.ts";
import { open, seal } from "./secretbox.ts";

export type BotUser = { telegramId: number; conn: Connection; walletAddress?: string };
export type BotPayout = Payout & { telegramId: number; chatId: number; messageId?: number };

export interface BotStore {
  getUser(telegramId: number): Promise<BotUser | undefined>;
  saveUser(u: BotUser): Promise<void>;
  deleteUser(telegramId: number): Promise<void>;
  getPayout(id: string): Promise<BotPayout | undefined>;
  savePayout(p: BotPayout): Promise<void>;
  recentPayouts(telegramId: number, limit: number): Promise<BotPayout[]>;
  // @username -> Telegram id, for /pay. Only connected users are listed. Usernames are stored
  // lowercase without the @; a username moves to whoever was seen with it last.
  saveHandle(telegramId: number, username: string | undefined, name?: string): Promise<void>;
  findHandle(username: string): Promise<{ telegramId: number; name?: string } | undefined>;
  getTransfer(id: string): Promise<Transfer | undefined>;
  saveTransfer(t: Transfer): Promise<void>;
  recentTransfers(telegramId: number, limit: number): Promise<Transfer[]>; // sent or received
}

const REPLACE_REFUSED = "Refusing to replace a recorded PayBox request.";

export function memoryStore(): BotStore & { users: Map<number, string>; payouts: Map<string, BotPayout>; handles: Map<number, { username?: string; name?: string }>; transfers: Map<string, Transfer> } {
  const users = new Map<number, string>(); // sealed, like the database
  const payouts = new Map<string, BotPayout>();
  const handles = new Map<number, { username?: string; name?: string }>();
  const transfers = new Map<string, Transfer>();
  return {
    users, payouts, handles, transfers,
    async getUser(id) { const s = users.get(id); return s ? open<BotUser>(s) : undefined; },
    async saveUser(u) { users.set(u.telegramId, seal(u)); },
    async deleteUser(id) { users.delete(id); handles.delete(id); },
    async getPayout(id) { const p = payouts.get(id); return p ? structuredClone(p) : undefined; },
    async savePayout(p) {
      const before = payouts.get(p.payoutId);
      if (before?.requestId && p.requestId !== before.requestId) throw new Error(REPLACE_REFUSED);
      payouts.set(p.payoutId, structuredClone({ ...p, updatedAt: new Date().toISOString() }));
    },
    async recentPayouts(id, limit) {
      return [...payouts.values()].filter((p) => p.telegramId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
    async saveHandle(id, username, name) {
      const u = username?.toLowerCase();
      if (u) for (const [other, h] of handles) if (other !== id && h.username === u) handles.set(other, { ...h, username: undefined });
      handles.set(id, { username: u, name });
    },
    async findHandle(username) {
      const u = username.replace(/^@/, "").toLowerCase();
      for (const [id, h] of handles) if (h.username === u) return { telegramId: id, name: h.name };
      return undefined;
    },
    async getTransfer(id) { const t = transfers.get(id); return t ? structuredClone(t) : undefined; },
    async saveTransfer(t) {
      const before = transfers.get(t.transferId);
      if (before?.requestId && t.requestId !== before.requestId) throw new Error(REPLACE_REFUSED);
      transfers.set(t.transferId, structuredClone({ ...t, updatedAt: new Date().toISOString() }));
    },
    async recentTransfers(id, limit) {
      return [...transfers.values()].filter((t) => (t.fromId === id || t.toId === id) && (t.fromId === id || t.payboxStatus === "success"))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
  };
}

// Anything that runs SQL like node-postgres (the real Pool, or an in-process Postgres in tests).
export type Sql = { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };

export async function postgresStore(url: string): Promise<BotStore> {
  return sqlStore(new pg.Pool({ connectionString: url, max: 5 }));
}

export async function sqlStore(pool: Sql): Promise<BotStore> {
  await pool.query(`
    create table if not exists bot_users (
      telegram_id bigint primary key,
      sealed text not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists bot_payouts (
      payout_id text primary key,
      telegram_id bigint not null,
      request_id text,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists bot_payouts_user on bot_payouts (telegram_id, created_at desc);
    create table if not exists bot_handles (
      telegram_id bigint primary key,
      username text,
      name text,
      updated_at timestamptz not null default now()
    );
    create unique index if not exists bot_handles_username on bot_handles (username);
    create table if not exists bot_transfers (
      transfer_id text primary key,
      from_id bigint not null,
      to_id bigint not null,
      request_id text,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists bot_transfers_from on bot_transfers (from_id, created_at desc);
    create index if not exists bot_transfers_to on bot_transfers (to_id, created_at desc);
  `);
  return {
    async getUser(id) {
      const r = await pool.query("select sealed from bot_users where telegram_id = $1", [id]);
      return r.rows[0] ? open<BotUser>(r.rows[0].sealed) : undefined;
    },
    async saveUser(u) {
      await pool.query(
        `insert into bot_users (telegram_id, sealed) values ($1, $2)
         on conflict (telegram_id) do update set sealed = excluded.sealed, updated_at = now()`,
        [u.telegramId, seal(u)],
      );
    },
    async deleteUser(id) {
      await pool.query("delete from bot_users where telegram_id = $1", [id]);
      await pool.query("delete from bot_handles where telegram_id = $1", [id]);
    },
    async getPayout(id) {
      const r = await pool.query("select data from bot_payouts where payout_id = $1", [id]);
      return r.rows[0]?.data;
    },
    async savePayout(p) {
      // Never overwrite a payout whose PayBox request is already recorded with a different one.
      const r = await pool.query(
        `insert into bot_payouts (payout_id, telegram_id, request_id, data) values ($1, $2, $3, $4)
         on conflict (payout_id) do update set request_id = excluded.request_id, data = excluded.data, updated_at = now()
         where bot_payouts.request_id is null or bot_payouts.request_id = excluded.request_id`,
        [p.payoutId, p.telegramId, p.requestId ?? null, { ...p, updatedAt: new Date().toISOString() }],
      );
      if (r.rowCount === 0) throw new Error(REPLACE_REFUSED);
    },
    async recentPayouts(id, limit) {
      const r = await pool.query("select data from bot_payouts where telegram_id = $1 order by created_at desc limit $2", [id, limit]);
      return r.rows.map((row) => row.data);
    },
    async saveHandle(id, username, name) {
      const u = username?.toLowerCase() ?? null;
      // Telegram usernames are unique at any moment, so whoever was seen with one last owns it.
      if (u) await pool.query("update bot_handles set username = null, updated_at = now() where username = $1 and telegram_id <> $2", [u, id]);
      await pool.query(
        `insert into bot_handles (telegram_id, username, name) values ($1, $2, $3)
         on conflict (telegram_id) do update set username = excluded.username, name = excluded.name, updated_at = now()`,
        [id, u, name ?? null],
      );
    },
    async findHandle(username) {
      const r = await pool.query("select telegram_id, name from bot_handles where username = $1", [username.replace(/^@/, "").toLowerCase()]);
      return r.rows[0] ? { telegramId: Number(r.rows[0].telegram_id), name: r.rows[0].name ?? undefined } : undefined;
    },
    async getTransfer(id) {
      const r = await pool.query("select data from bot_transfers where transfer_id = $1", [id]);
      return r.rows[0]?.data;
    },
    async saveTransfer(t) {
      const r = await pool.query(
        `insert into bot_transfers (transfer_id, from_id, to_id, request_id, data) values ($1, $2, $3, $4, $5)
         on conflict (transfer_id) do update set request_id = excluded.request_id, data = excluded.data, updated_at = now()
         where bot_transfers.request_id is null or bot_transfers.request_id = excluded.request_id`,
        [t.transferId, t.fromId, t.toId, t.requestId ?? null, { ...t, updatedAt: new Date().toISOString() }],
      );
      if (r.rowCount === 0) throw new Error(REPLACE_REFUSED);
    },
    async recentTransfers(id, limit) {
      // Everything you sent, and only completed payments you received.
      const r = await pool.query(
        `select data from bot_transfers
         where from_id = $1 or (to_id = $1 and data->>'payboxStatus' = 'success')
         order by created_at desc limit $2`,
        [id, limit],
      );
      return r.rows.map((row) => row.data);
    },
  };
}
