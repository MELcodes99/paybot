// Per-user PayBox connection (device login, key pairing, refresh) against a fake PayBox. No network.
import nacl from "tweetnacl";
import { credsFromToken } from "@paybox-sh/sdk";

const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code, headers: { "content-type": "application/json" } });
let tokenPolls = 0, pairPolls = 0, refreshes = 0, registeredPub = "";
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const p = url.pathname;
  const form = init.body instanceof URLSearchParams ? init.body : typeof init.body === "string" && !init.body.startsWith("{") ? new URLSearchParams(init.body) : null;
  if (p === "/.well-known/oauth-authorization-server") return json({ registration_endpoint: "https://api.paybox.sh/oauth/register", device_authorization_endpoint: "https://api.paybox.sh/oauth/device", token_endpoint: "https://api.paybox.sh/oauth/token" });
  if (p === "/oauth/register") return json({ client_id: "client-1" });
  if (p === "/oauth/device") return json({ device_code: "dev-1", user_code: "ABCD-EFGH", verification_uri_complete: "https://app.paybox.sh/device?code=ABCD-EFGH", interval: 1, expires_in: 600 });
  if (p === "/oauth/token" && form?.get("grant_type")?.includes("device_code")) {
    tokenPolls++;
    if (tokenPolls === 1) return json({ error: "authorization_pending" }, 400);
    if (tokenPolls === 2) return json({ error: "slow_down" }, 400);
    return json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
  }
  if (p === "/oauth/token" && form?.get("grant_type") === "refresh_token") {
    refreshes++;
    if (form.get("refresh_token") !== "rt-1") return json({ error: "invalid_grant" }, 400);
    return json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
  }
  if (p === "/api/agent-pairings/token") return init.headers?.authorization === "Bearer at-1" ? json({ pairing_token: "pt-1", client_id: "client-1" }) : json({}, 401);
  if (p === "/iframe/pairing" && init.method === "POST") { registeredPub = JSON.parse(init.body).api_pub_hex; return json({ pairing_id: "pair-1" }); }
  if (p === "/iframe/pairing/pair-1") { pairPolls++; return json({ status: pairPolls < 2 ? "pending" : "completed" }); }
  return json({ error: "unmocked " + p }, 404);
}) as any;

const { startDeviceLogin, finishDeviceLogin, startPairing, finishPairing, clientFor, agentCode } = await import("../lib/paybox-connect.ts");
const fast = async () => {};
let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`); };

const d = await startDeviceLogin("PayBot Telegram");
check("device login gives a link and a code to send the user", d.url.includes("ABCD-EFGH") && d.userCode === "ABCD-EFGH");
const conn = await finishDeviceLogin(d, fast);
check("login waits through pending and slow_down, then returns tokens", conn.accessToken === "at-1" && conn.refreshToken === "rt-1" && tokenPolls === 3);

const pairing = await startPairing(conn.accessToken);
check("pairing shows 8 emoji and a PayBox link", pairing.code.length === 8 && pairing.url.includes("pairing_id=pair-1"), pairing.code.join(" "));
const key = await finishPairing(pairing, fast);
const creds = credsFromToken(key);
check("paired key is a valid PayBox signing key", creds.apiPubHex === registeredPub && creds.apiPrivHex.length === 64);
check("the 8 emoji are derived from the registered key (same as PayBox shows)", agentCode(Buffer.from(registeredPub, "hex")).join("") === pairing.code.join(""));
const kp = nacl.sign.keyPair.fromSeed(Buffer.from(creds.apiPrivHex, "hex"));
check("private and public halves belong together", Buffer.from(kp.publicKey).toString("hex") === creds.apiPubHex);

const saved: any[] = [];
const expired = { ...conn, signingKey: key, expiresAt: Date.now() - 1000 };
const { client, conn: c2 } = await clientFor(expired, (c) => { saved.push(c); });
check("expired login is refreshed with the current refresh token", refreshes === 1 && c2.accessToken === "at-2" && c2.refreshToken === "rt-2");
check("rotated refresh token is saved before use", saved.length === 1 && saved[0].refreshToken === "rt-2");
check("client signs with this user's key", client.signingCreds()?.apiPubHex === creds.apiPubHex);
const again = await clientFor(c2, (c) => { saved.push(c); });
check("a fresh login is not refreshed again", refreshes === 1 && saved.length === 1 && again.conn.accessToken === "at-2");
process.exit(ok ? 0 : 1);
