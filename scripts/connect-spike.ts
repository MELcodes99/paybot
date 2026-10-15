// Telegram step 1 spike: connect a PayBox account the way the Telegram bot will, for one user.
// Moves NO money. Saves the connection to paybox-connection.spike.json (never committed),
// separate from this Mac's own PayBox setup.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/config.ts";
import { balances, solanaWallet } from "../lib/paybox.ts";
import { clientFor, finishDeviceLogin, finishPairing, startDeviceLogin, startPairing, type Connection } from "../lib/paybox-connect.ts";

const FILE = join(ROOT, "paybox-connection.spike.json");
const load = (): Connection | null => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : null);
const save = (c: Connection) => writeFileSync(FILE, JSON.stringify(c, null, 2), { mode: 0o600 });

let conn = load();

if (!conn) {
  console.log("1) PayBox login (this is what the bot will send in Telegram)\n");
  const d = await startDeviceLogin("PayBot Telegram (test)");
  console.log(`   Open: ${d.url}`);
  console.log(`   Code: ${d.userCode}`);
  console.log("   Sign in, allow your Solana wallet, then come back. Waiting...\n");
  conn = await finishDeviceLogin(d);
  save(conn);
  console.log("   Logged in.\n");
} else {
  console.log("1) Using the saved PayBox login.\n");
}

if (!conn.signingKey) {
  console.log("2) Pair a signing key for this connection\n");
  const p = await startPairing(conn.accessToken);
  console.log(`   Your code:  ${p.code.join("  ")}`);
  console.log(`   Open: ${p.url}`);
  console.log("   Pick the SAME 8 emoji in PayBox. Waiting...\n");
  conn.signingKey = await finishPairing(p);
  save(conn);
  console.log("   Key paired.\n");
} else {
  console.log("2) Using the saved signing key.\n");
}

console.log("3) Reading the wallet through this connection");
const { client } = await clientFor(conn, save);
const w = await solanaWallet(client);
const b = await balances(client, w.address);
console.log(`   Solana wallet ${w.address}: ${b.usdc} USDC, ${b.sol} SOL`);
console.log(`   Can sign: ${client.signingCreds() ? "yes" : "no"}`);
console.log("\nDone. Nothing was paid. Paste everything above back to Claude.");
