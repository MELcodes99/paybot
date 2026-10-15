// PayBot step 2b-2: read-only. Looks inside client.mcp and checks balances. Sends nothing.
import { PayboxClient } from "@paybox-sh/sdk";

const SOL_CRED = "d7a890b7-b326-4d36-9698-d44e67954820";
const SOL_ADDR = "3YWrKex5whNtK5QeXaPGDrBZwcAqMsgRigxwFgA3kZ8M";
const client: any = await (PayboxClient as any).fromConfig();
const show = (label: string, v: unknown) => console.log(`\n${label}:`, typeof v === "string" ? v : JSON.stringify(v, null, 2));

function members(o: any) {
  const s = new Set<string>();
  let p = o;
  while (p && p !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor") s.add(n);
    p = Object.getPrototypeOf(p);
  }
  return [...s].sort();
}
const src = (fn: any) => (typeof fn === "function" ? fn.toString().slice(0, 700) : "(not a function)");

show("Type of client.mcp", typeof client.mcp);
show("client.mcp members", members(client.mcp));
show("client.mcp source (if function)", src(client.mcp));

for (const name of ["request", "requestAfterSign", "signWithReconcile", "waitForRequest", "getPortfolio", "verifySolanaBalance"]) {
  show(`How ${name} works`, src(client[name]));
}

// Try listing PayBox's MCP tools, read-only.
for (const attempt of [
  () => client.mcp?.listTools?.(),
  () => client.mcp?.("tools/list", {}),
  () => client.mcp?.request?.("tools/list", {}),
]) {
  try {
    const r = await attempt();
    if (r) { show("MCP tools", (r.tools ?? r.result?.tools ?? r).map?.((t: any) => t.name) ?? r); break; }
  } catch (e: any) { console.log("\nTool list attempt failed:", e.message); }
}

// Balances.
for (const [label, arg] of [
  ["getPortfolio({credential_id})", { credential_id: SOL_CRED }],
  ["getPortfolio({credentialId})", { credentialId: SOL_CRED }],
  ["getPortfolio(id)", SOL_CRED],
] as const) {
  try { show(label, await client.getPortfolio(arg)); break; } catch (e: any) { console.log(`\n${label} failed:`, e.message); }
}
try { show("verifySolanaBalance", await client.verifySolanaBalance({ address: SOL_ADDR })); }
catch (e: any) { console.log("\nverifySolanaBalance failed:", e.message); }

console.log("\nDone. Nothing was sent. Paste everything above back to Claude.");
