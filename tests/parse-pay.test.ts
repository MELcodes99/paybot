// /pay message parsing. No network, no money.
import { looksLikePay, parsePay } from "../lib/parse-pay.ts";

let ok = true;
const check = (name: string, cond: boolean, extra = "") => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  ->  " + extra : ""}`); };
const j = (x: unknown) => JSON.stringify(x);

check("/pay @mel 10", j(parsePay("/pay @mel_o 10")) === j({ handle: "mel_o", usdc: 10 }), j(parsePay("/pay @mel_o 10")));
check("amount first", j(parsePay("/pay 2.5 @Mel_O")) === j({ handle: "mel_o", usdc: 2.5 }));
check("with usdc and a note", j(parsePay("/pay @ada_okafor 2.5 usdc for lunch")) === j({ handle: "ada_okafor", usdc: 2.5, note: "lunch" }));
check("dollar sign and free text", j(parsePay("pay @ada_okafor $5 thanks for the design!")) === j({ handle: "ada_okafor", usdc: 5, note: "thanks for the design" }));
check("5usdc stuck together", (parsePay("tip @ada_okafor 5usdc") as any).usdc === 5);
check("/pay@BotName form", (parsePay("/pay@PayBotNaira_bot @ada_okafor 1") as any).handle === "ada_okafor");
check("six decimals allowed", (parsePay("/pay @ada_okafor 0.123456") as any).usdc === 0.123456);
check("seven decimals refused", "error" in parsePay("/pay @ada_okafor 0.1234567"));
check("below the minimum refused", "error" in parsePay("/pay @ada_okafor 0.001"));
check("no handle asks who", (parsePay("/pay 5") as any).error?.startsWith("Who"));
check("no amount asks how much", (parsePay("/pay @ada_okafor") as any).error?.startsWith("How much"));
check("two different people refused", "error" in parsePay("/pay @ada_okafor @mel_o 5"));
check("naira points to /send", (parsePay("/pay @ada_okafor 5000 naira") as any).error?.includes("/send"));
check("too-short handle is not a handle", "error" in parsePay("/pay @ab 5"));
check("notes are capped", ((parsePay(`/pay @ada_okafor 1 ${"x".repeat(300)}`) as any).note ?? "").length === 100);
check("detects @handles in plain text", looksLikePay("pay @ada_okafor 5") && !looksLikePay("send 5000 to GTBank 0123456789 Ada") && !looksLikePay("email me at a@b.com"));
process.exit(ok ? 0 : 1);
