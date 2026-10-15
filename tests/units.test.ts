// Small checks on the money math and name matching.
import { toBaseUnits } from "../lib/config.ts";
import { sameName } from "../lib/paj.ts";

let ok = true;
const check = (name: string, cond: boolean) => { ok &&= cond; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };

check("1.1 USDC = 1100000", toBaseUnits(1.1) === 1100000n);
check("'1.1' USDC = 1100000", toBaseUnits("1.1") === 1100000n);
check("0.000001 USDC = 1", toBaseUnits("0.000001") === 1n);
check("3.692244 USDC exact", toBaseUnits(3.692244) === 3692244n);
check("0.1 + 0.2 rounds cleanly", toBaseUnits(0.1 + 0.2) === 300000n);
check("rejects negative", throws(() => toBaseUnits("-1")));
check("rejects 7 decimals of value", throws(() => toBaseUnits("1.0000001")));
check("name: order and case don't matter", sameName("SOMTOCHUKWU MEL OKOYE", "Okoye Somtochukwu Mel"));
check("name: punctuation ignored", sameName("OKOYE, SOMTOCHUKWU-MEL", "okoye somtochukwu mel"));
check("name: different person fails", !sameName("SOMTOCHUKWU MEL OKOYE", "Somtochukwu Okoye"));
check("name: empty fails", !sameName("", ""));
process.exit(ok ? 0 : 1);
