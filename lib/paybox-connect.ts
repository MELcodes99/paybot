// Connect a PayBox account for someone other than this computer's owner (e.g. a Telegram user):
// 1. device login (link + code, approved on their phone)  2. pair a signing key (8 matching emoji)
// 3. build a PayBox client from their saved connection, refreshing the login when it expires.
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { PayboxClient, mcpResource, refreshTokens } from "@paybox-sh/sdk";

export const PAYBOX_API = (process.env.PAYBOX_API_URL || "https://api.paybox.sh").replace(/\/$/, "");
export const PAYBOX_APP = (process.env.PAYBOX_APP_URL || "https://app.paybox.sh").replace(/\/$/, "");

export type Connection = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  resource: string;
  signingKey?: string; // "pbxk1." token for this user's paired key
};

async function getJson(url: string, init: RequestInit = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

let meta: any = null;
async function metadata() {
  if (!meta) {
    const r = await getJson(`${PAYBOX_API}/.well-known/oauth-authorization-server`);
    if (!r.ok) throw new Error(`PayBox metadata failed (${r.status})`);
    meta = r.body;
  }
  return meta;
}

// ---------- 1. Device login ----------

export type DeviceLogin = { clientId: string; deviceCode: string; userCode: string; url: string; intervalSec: number; expiresAt: number; resource: string };

export async function startDeviceLogin(clientName = "PayBot"): Promise<DeviceLogin> {
  const m = await metadata();
  if (!m.device_authorization_endpoint) throw new Error("PayBox does not offer device login right now.");
  const scope = "mcp offline_access";
  const reg = await getJson(m.registration_endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName, redirect_uris: ["http://127.0.0.1/device"], token_endpoint_auth_method: "none",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"], response_types: ["code"], scope,
    }),
  });
  if (!reg.ok) throw new Error(`PayBox client registration failed (${reg.status})`);
  const resource = mcpResource(PAYBOX_API);
  const da = await getJson(m.device_authorization_endpoint, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: reg.body.client_id, scope, resource }),
  });
  if (!da.ok) throw new Error(`PayBox device login failed (${da.status})`);
  return {
    clientId: reg.body.client_id, deviceCode: da.body.device_code, userCode: da.body.user_code,
    url: da.body.verification_uri_complete ?? da.body.verification_uri, intervalSec: da.body.interval > 0 ? da.body.interval : 5,
    expiresAt: Date.now() + (da.body.expires_in ?? 600) * 1000, resource,
  };
}

// Waits until the person approves on their phone. Throws if they decline or it expires.
export async function finishDeviceLogin(d: DeviceLogin, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Connection> {
  const m = await metadata();
  let interval = d.intervalSec;
  while (Date.now() < d.expiresAt) {
    await sleep(interval * 1000);
    const t = await getJson(m.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.deviceCode, client_id: d.clientId }),
    });
    if (t.ok) {
      return {
        clientId: d.clientId, accessToken: t.body.access_token, refreshToken: t.body.refresh_token,
        expiresAt: t.body.expires_in ? Date.now() + t.body.expires_in * 1000 : undefined, resource: d.resource,
      };
    }
    const code = t.body?.error ?? "";
    if (code === "authorization_pending") continue;
    if (code === "slow_down") { interval += 5; continue; }
    if (code === "access_denied") throw new Error("The PayBox login was declined.");
    if (code === "expired_token") break;
    throw new Error(`PayBox login failed: ${t.body?.error_description ?? code ?? t.status}`);
  }
  throw new Error("The PayBox login link expired. Start again.");
}

// ---------- 2. Pair a signing key ----------

const ALPHABET = [
  "🐶", "🐱", "🐭", "🐰", "🦊", "🐻", "🐼", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤",
  "🦆", "🦅", "🦉", "🦇", "🐗", "🐴", "🦄", "🐝", "🐛", "🦋", "🐌", "🐞", "🐜", "🐢", "🐍", "🦎",
  "🐙", "🦐", "🦀", "🐡", "🐠", "🐬", "🐳", "🦈", "🐆", "🦓", "🦍", "🐘", "🦏", "🐪", "🦒", "🐑",
  "🦌", "🦃", "🦚", "🌵", "🎄", "🌳", "🌴", "🌱", "🍀", "🎍", "🍁", "🍂", "🍃", "🌻", "🌹", "🌷",
  "🌸", "🌼", "🌾", "💐", "🍄", "🌰", "🌍", "🌙", "⭐", "🌈", "🔥", "💧", "🌊", "🌪", "🌩", "🍇",
  "🍉", "🍊", "🍋", "🍌", "🍍", "🍎", "🍐", "🍑", "🍒", "🍓", "🥝", "🥑", "🍆", "🥕", "🌽", "🥦",
  "🥒", "🥜", "🍞", "🥐", "🧀", "🍳", "🥞", "🍔", "🍟", "🍕", "🌭", "🌮", "🌯", "🍜", "🍠", "🍤",
  "🍥", "🍦", "🍨", "🍩", "🍪", "🎂", "🍰", "🍫", "🍬", "🍭", "🍮", "🍯", "🍼", "🥛", "☕", "🍵",
  "🍶", "🍾", "🍷", "🍸", "🍹", "🍺", "🥃", "⚽", "🏀", "🏈", "⚾", "🎾", "🎱", "🏓", "🏸", "🥅",
  "🏒", "🏹", "🎣", "🥊", "🎿", "🛷", "🎯", "🎮", "🎲", "🎸", "🎺", "🥁", "🎹", "🎤", "🎧", "📻",
  "🎬", "🎨", "🎪", "🚀", "🛸", "🚁", "🚂", "🚄", "🚌", "🚑", "🚓", "🚕", "🚗", "🚚", "🚜", "🚲",
  "⛵", "🛶", "🚤", "🗿", "🗽", "🎡", "🎢", "🎠", "⛲", "🏰", "🏟", "🎭", "🎁", "🧭", "⌚", "📱",
  "💻", "📷", "📺", "📞", "📠", "🔋", "🔌", "💡", "🔦", "🕯", "🗑", "💸", "💰", "💳", "💎", "🔧",
  "🔨", "🔩", "🔫", "💣", "🔪", "🔮", "📿", "🔬", "📔", "📚", "🌞", "⛄", "☔", "🌋", "🥌", "🏠",
  "🏥", "🏭", "🔑", "🔒", "⏰", "⌛", "📅", "📌", "📎", "📏", "🎈", "🎃", "👑", "👓", "🎩", "👟",
  "👢", "👜", "🎒", "🧲", "🧪", "🧬", "🧸", "🧦", "🧢", "🏆", "🛴", "🪐", "🎳", "🚦", "🧯", "🧹",
];
export const agentCode = (publicKey: Uint8Array) => [...createHash("sha256").update(publicKey).digest().subarray(0, 8)].map((b) => ALPHABET[b]);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64url = (s: string) => Buffer.from(s).toString("base64url");

export type Pairing = { pairingId: string; url: string; code: string[]; signingKey: string };

export async function startPairing(accessToken: string): Promise<Pairing> {
  const tok = await getJson(`${PAYBOX_API}/api/agent-pairings/token`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  if (!tok.ok) throw new Error(`PayBox key pairing failed (${tok.status})`);
  const seed = nacl.randomBytes(32);
  const pair = nacl.sign.keyPair.fromSeed(seed);
  const started = await getJson(`${PAYBOX_API}/iframe/pairing`, {
    method: "POST", headers: { authorization: `Bearer ${tok.body.pairing_token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ api_pub_hex: hex(pair.publicKey) }),
  });
  if (!started.ok) throw new Error(`PayBox key pairing failed (${started.status})`);
  return {
    pairingId: started.body.pairing_id,
    url: `${PAYBOX_APP}/agent-key?client_id=${tok.body.client_id}&pairing_id=${started.body.pairing_id}`,
    code: agentCode(pair.publicKey),
    signingKey: "pbxk1." + b64url(JSON.stringify({ p: hex(pair.publicKey), s: hex(seed) })),
  };
}

// Waits until the person picks the matching emoji in PayBox. Returns the signing key only on success.
export async function finishPairing(p: Pairing, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 10 * 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    const r = await getJson(`${PAYBOX_API}/iframe/pairing/${p.pairingId}`, { headers: { accept: "application/json" } });
    if (!r.ok) continue;
    if (r.body.status === "completed") return p.signingKey;
    if (r.body.status === "cancelled") throw new Error("The key pairing was declined in PayBox.");
    if (r.body.status === "expired") throw new Error("The key pairing expired. Start again.");
  }
  throw new Error("Timed out waiting for the emoji to be picked in PayBox.");
}

// ---------- 3. A PayBox client for this connection ----------

// Refreshes the login if it is about to expire. PayBox rotates refresh tokens on every use, so the new
// connection MUST be saved before anything else happens (replaying an old refresh token revokes access).
export async function clientFor(conn: Connection, save: (c: Connection) => Promise<void> | void) {
  let c = conn;
  if (c.expiresAt && Date.now() > c.expiresAt - 60_000) {
    const fresh = await refreshTokens(PAYBOX_API, { clientId: c.clientId, accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt, resource: c.resource } as any);
    c = { ...c, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? c.refreshToken, expiresAt: fresh.expiresAt };
    await save(c);
  }
  const client: any = new (PayboxClient as any)({ baseUrl: PAYBOX_API, token: c.accessToken, signingKey: c.signingKey });
  return { client, conn: c };
}
