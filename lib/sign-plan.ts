// Signs a PayBox Solana transaction plan with the local agent key,
// the same way the PayBox SDK signs swap plans (signSwapRequest).
import nacl from "tweetnacl";

// The bytes Solana actually signs: the message, after the signature slots.
export function solanaMessageHex(base64Tx: string) {
  const raw = Buffer.from(base64Tx, "base64");
  let i = 0, count = 0, shift = 0;
  for (;;) {
    const b = raw[i++];
    count |= (b & 127) << shift;
    if ((b & 128) === 0) break;
    shift += 7;
  }
  if (count < 1) throw new Error("transaction has no signature slots");
  return raw.subarray(i + count * 64).toString("hex");
}

export function buildEnvelopes(plan: any, creds: { apiPubHex: string; apiPrivHex: string }) {
  const keyId = plan?.binding?.key_id;
  const derivationPath = plan?.binding?.derivation_path;
  if (!plan?.binding?.wallet_id || !keyId || !derivationPath) {
    throw new Error("PayBox plan has no complete key binding. Re-provision the wallet in the PayBox app.");
  }
  const keyPair = nacl.sign.keyPair.fromSeed(Buffer.from(creds.apiPrivHex.replace(/^0x/, ""), "hex"));
  return plan.txs.map((t: any) => {
    const body = new TextEncoder().encode(JSON.stringify({
      raw_signing_payload: solanaMessageHex(t.transaction).toLowerCase(),
      key_id: keyId,
      derivation_path: derivationPath,
      issued_at: new Date().toISOString(),
    }));
    return {
      api_pub: creds.apiPubHex,
      signed_body: Buffer.from(body).toString("hex"),
      agent_signature: Buffer.from(nacl.sign.detached(body, keyPair.secretKey)).toString("hex"),
    };
  });
}
