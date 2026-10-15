// PayBot step 2b-3: read-only. Lists PayBox tools, shows signing code, checks balances. Sends nothing.
import { PayboxClient } from "@paybox-sh/sdk";

const SOL_ADDR = "3YWrKex5whNtK5QeXaPGDrBZwcAqMsgRigxwFgA3kZ8M";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const client: any = await (PayboxClient as any).fromConfig();
const show = (label: string, v: unknown) => console.log(`\n=== ${label} ===\n` + (typeof v === "string" ? v : JSON.stringify(v, null, 2)));
const src = (fn: any, n = 1500) => (typeof fn === "function" ? fn.toString().slice(0, n) : "(not a function)");

show("mcp.callTool code", src(client.mcp.callTool));
show("mcp.rpc code", src(client.mcp.rpc, 800));
show("requestWalletSign code", src(client.requestWalletSign));
show("completeWalletSignRequest code", src(client.completeWalletSignRequest));
show("resumeRequest code", src(client.resumeRequest));

try {
  const r = await client.mcp.rpc("tools/list", {});
  const tools: any[] = r.tools ?? r.result?.tools ?? [];
  show("PayBox tool names", tools.map((t) => t.name));
  const t = tools.find((x) => x.name === "request_transfer");
  show("request_transfer description", t?.description ?? "(not found)");
  show("request_transfer inputs", t?.inputSchema ?? t?.input_schema ?? "(not found)");
} catch (e: any) { console.log("\ntools/list failed:", e.message); }

try { show("Portfolio (Solana wallet)", await client.getPortfolio({ address: SOL_ADDR })); }
catch (e: any) { console.log("\ngetPortfolio failed:", e.message); }
try { show("USDC balance check", await client.verifySolanaBalance({ address: SOL_ADDR, tokenMint: USDC_MINT })); }
catch (e: any) { console.log("\nverifySolanaBalance failed:", e.message); }

console.log("\nDone. Nothing was sent. Paste everything above back to Claude.");
