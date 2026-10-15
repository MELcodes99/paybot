import { PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { checkTransferPlan, ataOf, USDC_MINT_PK } from "../lib/transfer-check.ts";
const SENDER = "3YWrKex5whNtK5QeXaPGDrBZwcAqMsgRigxwFgA3kZ8M";
const PAJ = "7JqsrYeUEcCHKoJ5igv4J8dD9mMfE7Qd514gmv3co4LZ";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const s = new PublicKey(SENDER), r = new PublicKey(PAJ);
function tc(amount: bigint, dest = ataOf(r)) {
  const d = Buffer.alloc(10); d[0] = 12; d.writeBigUInt64LE(amount, 1); d[9] = 6;
  return new TransactionInstruction({ programId: TOKEN, data: d, keys: [
    { pubkey: ataOf(s), isSigner: false, isWritable: true }, { pubkey: USDC_MINT_PK, isSigner: false, isWritable: false },
    { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: s, isSigner: true, isWritable: false }] });
}
const createAta = new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [
  { pubkey: s, isSigner: true, isWritable: true }, { pubkey: ataOf(r), isSigner: false, isWritable: true },
  { pubkey: r, isSigner: false, isWritable: false }, { pubkey: USDC_MINT_PK, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false }] });
function plan(ixs: TransactionInstruction[], over: any = {}) {
  const msg = new TransactionMessage({ payerKey: s, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message();
  const tx = Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
  return { sender: SENDER, transfer: { recipient: PAJ, token: USDC_MINT_PK.toBase58(), amount: "1100000" }, txs: [{ vm: "solana", transaction: tx }], ...over };
}
const E = { sender: SENDER, recipient: PAJ, amountBaseUnits: 1100000n };
const cases: [string, any, boolean][] = [
  ["good: transfer only", plan([tc(1100000n)]), true],
  ["good: compute budget + create account + transfer", plan([ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }), createAta, tc(1100000n)]), true],
  ["bad: wrong amount", plan([tc(2000000n)]), false],
  ["bad: wrong destination", plan([tc(1100000n, ataOf(new PublicKey("4rHbgQUBPckbQBEkaLLQ7zoo2MrEmWtQCY9gSYZKmMf8")))]), false],
  ["bad: hidden SOL transfer", plan([tc(1100000n), SystemProgram.transfer({ fromPubkey: s, toPubkey: r, lamports: 1000 })]), false],
  ["bad: two transfers", plan([tc(1100000n), tc(1100000n)]), false],
  ["bad: huge priority fee", plan([ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }), tc(1100000n)]), false],
  ["bad: plan says other recipient", plan([tc(1100000n)], { transfer: { recipient: SENDER, token: USDC_MINT_PK.toBase58(), amount: "1100000" } }), false],
];
let ok = true;
for (const [name, p, want] of cases) {
  let passed: boolean, why = "";
  try { why = checkTransferPlan(p, E).join(" "); passed = true; } catch (e: any) { passed = false; why = e.message; }
  const good = passed === want; ok &&= good;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}  ->  ${why}`);
}
process.exit(ok ? 0 : 1);
