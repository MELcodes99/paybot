// Loads the REAL PayBox SDK client the way the server does, from an empty config. No network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "paybot-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
delete process.env.PAYBOX_SIGNING_KEY;
delete process.env.PAYBOX_API_KEY;

const { paybox } = await import("../lib/paybox.ts");
let message = "";
try { await paybox(); } catch (e: any) { message = e.message; }
const ok = message.includes("signing key") && !message.includes("is not a function");
console.log(`${ok ? "PASS" : "FAIL"}  real SDK client loads; missing key gives a clear message  ->  ${message}`);
process.exit(ok ? 0 : 1);
