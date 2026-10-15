// PayBox side: wallet lookup, balances, the transfer request, checked local signing.
import { PayboxClient } from "@paybox-sh/sdk";
import { SOLANA_RPC, USDC_MINT, settings } from "./config.ts";
import { checkTransferPlan, type Expect } from "./transfer-check.ts";
import { buildEnvelopes } from "./sign-plan.ts";

export const BASE_FEE_SOL = 0.000005;
export const ACCOUNT_RENT_SOL = 0.00204; // creating a USDC account for a new address

let clientPromise: Promise<any> | null = null;
export function usePayboxClientForTests(client: any) { clientPromise = Promise.resolve(client); }
export function paybox(): Promise<any> {
  // fromConfig() returns the client directly (not a promise); wrapping it also turns setup errors into a rejection.
  clientPromise ??= Promise.resolve().then(() => {
    const c: any = (PayboxClient as any).fromConfig();
    if (!c.signingCreds()) throw new Error("No local PayBox signing key. Run: npx @paybox-sh/sdk connect");
    return c;
  });
  clientPromise!.catch(() => { clientPromise = null; });
  return clientPromise!;
}

export async function solanaWallet(client: any): Promise<{ credentialId: string; address: string }> {
  const { credentials } = await client.listCredentials();
  const sol = (credentials ?? [])
    .map((c: any) => c.credential)
    .filter((c: any) => c.credential_type === "wallet" && !c.disabled_at && c.metadata?.chains?.includes("solana"));
  const pick = settings.solCredential ? sol.filter((c: any) => c.id === settings.solCredential) : sol;
  if (pick.length !== 1) {
    throw new Error(pick.length
      ? `You have ${pick.length} PayBox Solana wallets. Set PAYBOT_SOL_CREDENTIAL in .env to one of: ${pick.map((c: any) => `${c.id} (${c.name})`).join(", ")}`
      : "No granted PayBox Solana wallet found.");
  }
  return { credentialId: pick[0].id, address: pick[0].metadata.address };
}

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(SOLANA_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`Solana RPC ${method}: ${j.error.message}`);
  return j.result;
}

export async function balances(client: any, address: string) {
  const pf = await client.getPortfolio({ address });
  const usdc = Number(pf.items?.find((i: any) => i.tokenAddress === USDC_MINT)?.balance ?? 0) / 1e6;
  const sol = Number((await rpc("getBalance", [address]))?.value ?? 0) / 1e9;
  return { usdc, sol };
}

export async function hasUsdcAccount(owner: string) {
  const r = await rpc("getTokenAccountsByOwner", [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
  return (r?.value?.length ?? 0) > 0;
}

export function toolJson(res: any) {
  if (res?.structuredContent) return res.structuredContent;
  const text = res?.content?.find((c: any) => c.type === "text")?.text;
  try { return JSON.parse(text); } catch { return { status: "error", message: text ?? "PayBox returned no content" }; }
}

// Ask PayBox to build the transfer. Call ONCE per payout; never to retry.
export async function requestTransfer(client: any, a: { credentialId: string; to: string; baseUnits: bigint }) {
  return toolJson(await client.mcp.callTool("request_transfer", {
    credential_id: a.credentialId, chain: "solana:mainnet", to: a.to,
    amount: a.baseUnits.toString(), token: USDC_MINT,
    value_cents: Number((a.baseUnits + 9_999n) / 10_000n),
  }, "in-process"));
}

// Fetch the transaction PayBox wants signed, check it, refresh it, check again, sign once.
export async function signPendingTransfer(client: any, requestId: string, expect: Expect, beforeSubmit: () => void | Promise<void>) {
  const reopened = toolJson(await client.mcp.callTool("reopen_signing_window", { request_id: requestId }, "in-process"));
  if (reopened?.request_id !== requestId) throw new Error("PayBox returned a different request. Not signing.");
  if (reopened.status !== "pending_signature") return { signed: false, status: reopened.status, notes: [] as string[] };
  let plan = reopened.plan;
  const notes = checkTransferPlan(plan, expect);
  try {
    const fresh = await client.poster(`/agent/requests/${requestId}/refresh`, {});
    if (fresh?.plan) { plan = fresh.plan; checkTransferPlan(plan, expect); }
  } catch { /* refresh not offered for this plan; the checked plan is used */ }
  const now = await client.getRequest(requestId);
  if (now.status !== "pending_signature") return { signed: false, status: now.status, notes };
  const envelopes = buildEnvelopes(plan, client.signingCreds());
  await beforeSubmit();
  await client.poster(`/agent/requests/${requestId}/envelopes`, { envelopes });
  return { signed: true, status: "submitted", notes };
}
