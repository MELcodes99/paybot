// PayBot step 2a: create ONE real PAJ order for N1,500. Does NOT send any USDC.
import { createInterface } from "node:readline/promises";
import { getSession, findBank, confirmAccount, saveAccount, createOfframp, getTransaction, sameName } from "./lib/paj.ts";

const TEST = { bank: "Opay", accountNumber: "8161859340", expectedName: "Somtochukwu Mel Okoye", ngn: 1500 };

const token = await getSession();
const bank = await findBank(token, TEST.bank);
const acct = await confirmAccount(token, bank.id, TEST.accountNumber);
if (!sameName(acct.accountName, TEST.expectedName)) {
  throw new Error(`Stopped: bank says "${acct.accountName}", you typed "${TEST.expectedName}".`);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  `\nCreate a PAJ order: N${TEST.ngn.toLocaleString()} to ${acct.accountName}, ${bank.name} ${TEST.accountNumber}?\n` +
  `(No USDC is sent in this step.) Type yes to continue: `,
);
rl.close();
if (answer.trim().toLowerCase() !== "yes") { console.log("Cancelled."); process.exit(0); }

console.log("\nSaving bank account with PAJ...");
console.log(await saveAccount(token, bank.id, TEST.accountNumber));

console.log("\nCreating order...");
const order = await createOfframp(token, { bankId: bank.id, accountNumber: TEST.accountNumber, ngn: TEST.ngn });
console.log(order);

console.log("\nOrder status right after creating it:");
console.log(await getTransaction(token, order.id));
console.log("\nDone. No USDC sent. Paste everything above back to Claude.");
