// PayBot step 2b-1: read-only look at the PayBox SDK and your wallets. Sends nothing.
import * as sdk from "@paybox-sh/sdk";

console.log("SDK exports:", Object.keys(sdk));
const PayboxClient: any = (sdk as any).PayboxClient ?? (sdk as any).default?.PayboxClient;
if (!PayboxClient) throw new Error("PayboxClient not found in SDK exports.");

const client: any = await PayboxClient.fromConfig();

const methods = new Set<string>();
let p = client;
while (p && p !== Object.prototype) {
  for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor") methods.add(n);
  p = Object.getPrototypeOf(p);
}
console.log("\nClient methods and fields:", [...methods].sort());

const look = (label: string, v: unknown) => console.log(`\n${label}:`, JSON.stringify(v, null, 2));

try { look("Credentials", await client.listCredentials()); } catch (e: any) { console.log("\nlistCredentials failed:", e.message); }
try { look("Portfolio", await client.getPortfolio()); } catch (e: any) { console.log("\ngetPortfolio failed:", e.message); }

for (const name of ["callTool", "mcp", "listTools"]) {
  if (typeof client[name] === "function" || client[name]) console.log(`\nFound "${name}" on the client.`);
}
try {
  const tools = client.listTools ? await client.listTools() : client.mcp?.listTools ? await client.mcp.listTools() : null;
  if (tools) look("MCP tools", (tools.tools ?? tools).map((t: any) => t.name ?? t));
} catch (e: any) { console.log("\nlistTools failed:", e.message); }

console.log("\nDone. Nothing was sent. Paste everything above back to Claude.");
