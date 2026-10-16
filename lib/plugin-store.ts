// Payouts prepared through the PayBox plugin. The plugin runs in a fresh sandbox on every call,
// so the server keeps the bank-verified details that send_payout and payout_status need.
import pg from "pg";
import type { Sql } from "./bot-store.ts";

export type PluginPayout = {
  payoutId: string;
  accountName: string;
  bank: string;
  accountNumber: string;
  ngn: number;
  usdc: number;
  address: string;
  createdAt: string;
};

export interface PluginStore {
  save(p: PluginPayout): Promise<void>;
  get(payoutId: string): Promise<PluginPayout | undefined>;
}

export function memoryPluginStore(): PluginStore {
  const m = new Map<string, PluginPayout>();
  return {
    async save(p) { m.set(p.payoutId, structuredClone(p)); },
    async get(id) { const p = m.get(id); return p ? structuredClone(p) : undefined; },
  };
}

export async function sqlPluginStore(pool: Sql): Promise<PluginStore> {
  await pool.query(`
    create table if not exists plugin_payouts (
      payout_id text primary key,
      data jsonb not null,
      created_at timestamptz not null default now()
    );
  `);
  return {
    async save(p) {
      await pool.query("insert into plugin_payouts (payout_id, data) values ($1, $2) on conflict (payout_id) do nothing", [p.payoutId, p]);
    },
    async get(id) {
      const r = await pool.query("select data from plugin_payouts where payout_id = $1", [id]);
      return r.rows[0]?.data;
    },
  };
}

export async function postgresPluginStore(url: string): Promise<PluginStore> {
  return sqlPluginStore(new pg.Pool({ connectionString: url, max: 3 }));
}
