// Log in to PAJ once (emails you a code). The session is saved in .paj-session.json.
import { createInterface } from "node:readline/promises";
import { login } from "../lib/paj.ts";

const { expiresAt } = await login(async (email) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = await rl.question(`PAJ sent a code to ${email}. Type it here: `);
  rl.close();
  return code;
});
console.log(`Logged in to PAJ. Session valid until ${expiresAt}.`);
