// The PayBot flow: quote, prepare (no money moves), send (money moves), status.
import { USDC_MINT, settings, toBaseUnits } from "./config.ts";
import {
  confirmAccount, createOfframp, findBank, getOfframpRate, getTransaction,
  listBanks, loadSession, sameName, saveAccount, searchBanks,
} from "./paj.ts";
import {
  ACCOUNT_RENT_SOL, BASE_FEE_SOL, balances, hasUsdcAccount, paybox,
  requestTransfer, signPendingTransfer, solanaWallet,
} from "./paybox.ts";
import { getPayout, savePayout, type Payout } from "./store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const naira = (n: number) => `N${n.toLocaleString("en-NG")}`;
const PAYBOX_WAIT_MS = 120_000;
const PAJ_WAIT_MS = 90_000;

export async function banks(search?: string) {
  const token = loadSession();
  const list = search ? await searchBanks(token, search) : await listBanks(token);
  return { count: list.length, banks: list.slice(0, 30).map((b) => ({ name: b.name, code: b.code })) };
}

export async function quote(a: { ngn?: number; usdc?: number }) {
  const { rate } = await getOfframpRate();
  if (a.ngn) return { rate, ngn: a.ngn, usdcEstimate: +(a.ngn / rate).toFixed(6), note: "Estimate. The exact USDC is fixed by prepare_payout." };
  if (a.usdc) return { rate, usdc: a.usdc, ngnEstimate: Math.floor(a.usdc * rate), note: "Estimate before PAJ fees." };
  return { rate, note: "Naira per 1 USDC on payout." };
}

export async function wallet() {
  const client = await paybox();
  const w = await solanaWallet(client);
  return { ...w, ...(await balances(client, w.address)) };
}

// Step 1. Verifies the account with the bank and creates a PAJ order. Moves no money.
export async function prepare(a: { bank: string; accountNumber: string; ngn: number; expectedName?: string }) {
  const accountNumber = a.accountNumber.replace(/\D/g, "");
  if (!Number.isInteger(a.ngn) || a.ngn <= 0) throw new Error("Naira amount must be a whole number above 0.");
  if (settings.maxNgn && a.ngn > settings.maxNgn) throw new Error(`${naira(a.ngn)} is above your PAYBOT_MAX_NGN cap of ${naira(settings.maxNgn)}.`);
  const token = loadSession();
  const bank = await findBank(token, a.bank);
  const acct = await confirmAccount(token, bank.id, accountNumber);
  if (!acct?.accountName) throw new Error("The bank did not return an account name. Nothing was created.");
  if (a.expectedName && !sameName(acct.accountName, a.expectedName)) {
    throw new Error(`The bank says ${bank.name} ${accountNumber} belongs to "${acct.accountName}", not "${a.expectedName}". Nothing was created. Ask the user to check the details.`);
  }
  await saveAccount(token, bank.id, accountNumber);
  const order = await createOfframp(token, { bankId: bank.id, accountNumber, ngn: a.ngn, feeUsdc: settings.feeUsdc });
  if (order.chain && order.chain !== "SOLANA") throw new Error("PAJ returned a non-Solana order.");
  if (order.mint !== USDC_MINT) throw new Error("PAJ returned a non-USDC order.");
  if (Number(order.fiatAmount) !== a.ngn) throw new Error(`PAJ order is for ${order.fiatAmount}, not ${a.ngn}.`);
  if (!order.address || !(Number(order.amount) > 0)) throw new Error("PAJ order is missing an address or amount.");
  const p: Payout = {
    payoutId: order.id, bank: { id: bank.id, name: bank.name }, accountNumber, accountName: acct.accountName,
    ngn: a.ngn, usdc: Number(order.amount), rate: order.rate, fee: order.fee, address: order.address,
    createdAt: new Date().toISOString(),
  };
  savePayout(p);
  return {
    payoutId: p.payoutId,
    accountName: p.accountName,
    bank: p.bank.name,
    accountNumber,
    ngn: p.ngn,
    usdc: p.usdc,
    rate: p.rate,
    say: `${p.accountName}, ${p.bank.name} ${accountNumber}. ${naira(p.ngn)} costs ${p.usdc} USDC. Send it?`,
    nextStep: "Show this to the user exactly and wait for an explicit yes. Only then call send_naira with this payoutId and the accountName above.",
  };
}

// Step 2. Moves real money. Safe to call again with the same payoutId: it resumes, never re-sends.
export async function send(a: { payoutId: string; confirmedAccountName: string }) {
  const p = getPayout(a.payoutId);
  if (!p) throw new Error("Unknown payoutId. Call prepare_payout first.");
  if (!sameName(a.confirmedAccountName, p.accountName)) {
    throw new Error(`Confirmed name "${a.confirmedAccountName}" does not match the bank-verified name "${p.accountName}". Not sending.`);
  }
  const client = await paybox();
  const w = await solanaWallet(client);
  const token = loadSession();

  if (!p.requestId) {
    // Fresh send: re-check everything before asking PayBox to build the transfer.
    const acct = await confirmAccount(token, p.bank.id, p.accountNumber);
    if (!sameName(acct.accountName, p.accountName)) throw new Error(`The bank now returns "${acct.accountName}". Not sending.`);
    const order = await getTransaction(token, p.payoutId);
    if (order.status !== "INIT") throw new Error(`PAJ order is ${order.status}, not waiting for payment. Prepare a new payout.`);
    if (order.address !== p.address || Number(order.amount) !== p.usdc || Number(order.fiatAmount) !== p.ngn || order.mint !== USDC_MINT) {
      throw new Error("PAJ order details changed since it was prepared. Not sending. Prepare a new payout.");
    }
    const bal = await balances(client, w.address);
    if (bal.usdc < p.usdc) throw new Error(`Wallet ${w.address} has ${bal.usdc} USDC, needs ${p.usdc}. Nothing was sent.`);
    const needSol = BASE_FEE_SOL * 2 + ((await hasUsdcAccount(p.address)) ? 0 : ACCOUNT_RENT_SOL);
    if (bal.sol < needSol) throw new Error(`Wallet ${w.address} has ${bal.sol} SOL; this payout needs about ${needSol} SOL for network fees. Add SOL and try again. Nothing was sent.`);

    const res = await requestTransfer(client, { credentialId: w.credentialId, to: p.address, baseUnits: toBaseUnits(p.usdc) });
    if (!res?.request_id) {
      return { status: "not_sent", moneyMoved: false, say: `PayBox could not prepare the transfer: ${res?.message ?? "no reason given"}. No funds were moved.` };
    }
    p.requestId = res.request_id; p.requestedAt = new Date().toISOString(); p.payboxStatus = res.status;
    savePayout(p);
  }
  return finish(client, token, w.address, p);
}

async function finish(client: any, token: string, sender: string, p: Payout) {
  let req = await client.getRequest(p.requestId);
  if (req.status === "pending_approval") {
    p.payboxStatus = req.status; savePayout(p);
    return { status: "needs_approval", payoutId: p.payoutId, say: "PayBox wants your approval for this transfer. Approve it in the PayBox app, then call send_naira again with the same payoutId." };
  }
  // Sign if PayBox is waiting. A request is a single transfer, so signing it again is only allowed
  // when an earlier signature clearly never landed (still waiting 2+ minutes later), as the SDK does.
  const staleSignature = p.signedAt && Date.now() - new Date(p.signedAt).getTime() > 120_000;
  if (req.status === "pending_signature" && (!p.signedAt || staleSignature)) {
    await signPendingTransfer(client, p.requestId!, { sender, recipient: p.address, amountBaseUnits: toBaseUnits(p.usdc) }, () => {
      p.signedAt = new Date().toISOString(); savePayout(p);
    });
  }
  const final = await client.waitForRequest(p.requestId, { intervalMs: 3000, timeoutMs: PAYBOX_WAIT_MS });
  p.payboxStatus = final.status;
  p.txHash = final.output?.value?.tx_hash ?? p.txHash;
  savePayout(p);
  if (final.status === "denied" || final.status === "error") {
    return { status: "failed", payoutId: p.payoutId, payboxStatus: final.status, error: final.error ?? null,
      say: `PayBox reports the transfer ${final.status}. Do not resend. Check payout_status.` };
  }
  if (final.status !== "success") {
    return { status: "processing", payoutId: p.payoutId, payboxStatus: final.status,
      say: "The transfer is still processing on PayBox. Do not send again. Check payout_status in a minute." };
  }
  // On-chain done. Watch PAJ: only COMPLETED means the naira was paid. ERROR can be temporary.
  const deadline = Date.now() + PAJ_WAIT_MS;
  let o: any;
  for (;;) {
    o = await getTransaction(token, p.payoutId);
    p.pajStatus = o.status; savePayout(p);
    if (o.status === "COMPLETED" || Date.now() > deadline) break;
    await sleep(5000);
  }
  const done = o.status === "COMPLETED";
  return {
    status: done ? "completed" : "sent_awaiting_payout",
    payoutId: p.payoutId, accountName: p.accountName, bank: p.bank.name, accountNumber: p.accountNumber,
    ngn: p.ngn, usdc: p.usdc, txHash: p.txHash, explorer: p.txHash ? `https://solscan.io/tx/${p.txHash}` : undefined,
    pajStatus: o.status,
    say: done
      ? `Done. ${naira(p.ngn)} paid to ${p.accountName} (${p.bank.name} ${p.accountNumber}) for ${p.usdc} USDC.`
      : `${p.usdc} USDC was delivered on Solana; PAJ shows ${o.status} for the naira payout. Do not send again. Check payout_status shortly.`,
  };
}

export async function status(payoutId: string) {
  const p = getPayout(payoutId);
  if (!p) throw new Error("Unknown payoutId.");
  const token = loadSession();
  const o = await getTransaction(token, payoutId);
  p.pajStatus = o.status;
  if (p.requestId) {
    const client = await paybox();
    const r = await client.getRequest(p.requestId);
    p.payboxStatus = r.status;
    p.txHash = r.output?.value?.tx_hash ?? p.txHash;
  }
  savePayout(p);
  const hint = !p.requestId
    ? "Prepared but not sent."
    : p.payboxStatus === "pending_signature" && !p.signedAt
      ? "Waiting for signature. Calling send_naira again with this payoutId will finish it without sending twice."
      : p.pajStatus === "COMPLETED" ? "Naira paid." : "Do not send again; wait and check later.";
  return { payoutId, accountName: p.accountName, bank: p.bank.name, ngn: p.ngn, usdc: p.usdc,
    payboxStatus: p.payboxStatus ?? null, pajStatus: p.pajStatus, txHash: p.txHash ?? null, hint };
}
