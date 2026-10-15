// How chat messages turn into payouts. No network.
import { parseSend } from "../lib/parse-send.ts";

let ok = true;
const check = (input: string, want: any) => {
  const got = parseSend(input);
  const pass = JSON.stringify(got) === JSON.stringify(want) || (want?.error === true && "error" in got);
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"}  ${JSON.stringify(input)}  ->  ${JSON.stringify(got)}`);
};

check("/send 5000 GTBank 0123456789 Tunde Bakare", { ngn: 5000, bank: "GTBank", accountNumber: "0123456789", name: "Tunde Bakare" });
check("Send 5,000 naira to GTBank 0123456789, Tunde Bakare", { ngn: 5000, bank: "GTBank", accountNumber: "0123456789", name: "Tunde Bakare" });
check("send 20k to Opay 8012345678 Ada Okafor", { ngn: 20000, bank: "Opay", accountNumber: "8012345678", name: "Ada Okafor" });
check("pay Ada Okafor 20k on Opay 8012345678", { ngn: 20000, bank: "Opay", accountNumber: "8012345678", name: "Ada Okafor" });
check("N5,000 to Access Bank 0123456789", { ngn: 5000, bank: "Access Bank", accountNumber: "0123456789" });
check("₦1500 First Bank 3012345678", { ngn: 1500, bank: "First Bank", accountNumber: "3012345678" });
check("send 1000 to moniepoint 816 185 9340 Somtochukwu Mel Okoye", { ngn: 1000, bank: "moniepoint", accountNumber: "8161859340", name: "Somtochukwu Mel Okoye" });
check("/send@PayBotNaira_bot 2500 kuda 2012345678", { ngn: 2500, bank: "kuda", accountNumber: "2012345678" });
check("send 5000 to GTBank", { error: true });
check("send GTBank 0123456789", { error: true });
check("send 5000 0123456789", { error: true });
process.exit(ok ? 0 : 1);
