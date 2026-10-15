// Starts the PayBot MCP server like Claude Code does and lists its tools. No network, no money.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "npx", args: ["tsx", new URL("../mcp.ts", import.meta.url).pathname], stderr: "ignore" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const want = ["list_banks", "payout_status", "prepare_payout", "quote", "send_naira", "wallet_status"];
const ok = JSON.stringify(names) === JSON.stringify(want);
console.log(`${ok ? "PASS" : "FAIL"}  MCP server exposes: ${names.join(", ")}`);
const instructions = client.getInstructions() ?? "";
const ok2 = instructions.includes("explicit yes");
console.log(`${ok2 ? "PASS" : "FAIL"}  server instructions tell the agent to get an explicit yes`);
const bad = await client.callTool({ name: "send_naira", arguments: { payoutId: "nope", confirmedAccountName: "x" } });
const ok3 = bad.isError === true && JSON.stringify(bad.content).includes("Unknown payoutId");
console.log(`${ok3 ? "PASS" : "FAIL"}  send_naira refuses an unknown payout`);
await client.close();
process.exit(ok && ok2 && ok3 ? 0 : 1);
