// Checks a PayBox Solana transfer plan BEFORE we sign it.
// It only passes a transaction that pays exactly the expected USDC amount
// from our wallet to the PAJ deposit address, with nothing else inside.
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

export const USDC_MINT_PK = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const COMPUTE_PROGRAM = new PublicKey("ComputeBudget111111111111111111111111111111");
const MAX_FEE_LAMPORTS = 1_000_000; // 0.001 SOL ceiling on priority fees

export function ataOf(owner: PublicKey, mint = USDC_MINT_PK) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

const u64 = (b: Uint8Array, at: number) => Buffer.from(b).readBigUInt64LE(at);
const u32 = (b: Uint8Array, at: number) => Buffer.from(b).readUInt32LE(at);

export type Expect = { sender: string; recipient: string; amountBaseUnits: bigint };

export function checkTransferPlan(plan: any, expect: Expect): string[] {
  const notes: string[] = [];
  const fail = (m: string) => { throw new Error(`Transfer check failed: ${m}`); };

  if (plan?.sender !== expect.sender) fail(`plan sender is ${plan?.sender}`);
  if (plan?.transfer?.recipient !== expect.recipient) fail(`plan recipient is ${plan?.transfer?.recipient}`);
  if (plan?.transfer?.token !== USDC_MINT_PK.toBase58()) fail("plan token is not USDC");
  if (String(plan?.transfer?.amount) !== expect.amountBaseUnits.toString()) fail(`plan amount is ${plan?.transfer?.amount}`);
  if (!Array.isArray(plan?.txs) || plan.txs.length !== 1) fail("plan must contain exactly one transaction");
  const t = plan.txs[0];
  if (t.vm !== "solana" || typeof t.transaction !== "string") fail("transaction is not a Solana transaction");

  const tx = VersionedTransaction.deserialize(Buffer.from(t.transaction, "base64"));
  const msg = tx.message;
  if ((msg as any).addressTableLookups?.length) fail("transaction uses lookup tables; refusing to sign what we cannot fully read");
  const keys = msg.staticAccountKeys;
  const sender = new PublicKey(expect.sender);
  const recipient = new PublicKey(expect.recipient);
  if (!keys[0].equals(sender)) fail(`fee payer is ${keys[0].toBase58()}, not your wallet`);
  if (msg.header.numRequiredSignatures !== 1) fail("transaction needs more than one signer");

  const srcAta = ataOf(sender);
  const dstAta = ataOf(recipient);
  let transfers = 0, unitLimit = 200_000, microLamports = 0n;

  for (const ix of msg.compiledInstructions) {
    const pid = keys[ix.programIdIndex];
    const acc = ix.accountKeyIndexes.map((i) => keys[i]);
    const d = ix.data;
    if (pid.equals(COMPUTE_PROGRAM)) {
      if (d[0] === 2) unitLimit = u32(d, 1);
      else if (d[0] === 3) microLamports = u64(d, 1);
      else fail("unexpected compute-budget instruction");
    } else if (pid.equals(ATA_PROGRAM)) {
      if (!acc[0].equals(sender) || !acc[1].equals(dstAta) || !acc[2].equals(recipient) || !acc[3].equals(USDC_MINT_PK)) {
        fail("account-creation instruction is not for the PAJ address's USDC account");
      }
      notes.push("Creates the PAJ address's USDC account (one-time rent, paid in SOL).");
    } else if (pid.equals(TOKEN_PROGRAM)) {
      transfers++;
      if (d[0] === 12) { // TransferChecked: source, mint, destination, authority
        if (!acc[1].equals(USDC_MINT_PK) || d[9] !== 6) fail("token is not USDC");
        if (!acc[0].equals(srcAta) || !acc[2].equals(dstAta) || !acc[3].equals(sender)) fail("wrong source, destination or owner");
      } else if (d[0] === 3) { // Transfer: source, destination, authority
        if (!acc[0].equals(srcAta) || !acc[1].equals(dstAta) || !acc[2].equals(sender)) fail("wrong source, destination or owner");
      } else fail(`unexpected token instruction ${d[0]}`);
      if (u64(d, 1) !== expect.amountBaseUnits) fail(`token amount is ${u64(d, 1)}, expected ${expect.amountBaseUnits}`);
    } else {
      fail(`unexpected program ${pid.toBase58()}`);
    }
  }
  if (transfers !== 1) fail(`expected exactly one token transfer, found ${transfers}`);
  const priority = (BigInt(unitLimit) * microLamports) / 1_000_000n;
  if (priority > BigInt(MAX_FEE_LAMPORTS)) fail(`priority fee too high (${priority} lamports)`);
  notes.push(`Network fee about ${(5000 + Number(priority)) / 1e9} SOL.`);
  return notes;
}
