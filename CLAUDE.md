# PayBot

PayBot sends naira to Nigerian bank accounts. It pays USDC on Solana from the user's PayBox wallet to a PAJ order address, and PAJ pays the naira out to the bank.

## Sending money (paybot MCP tools)

1. `prepare_payout` with the bank, the 10-digit account number, the naira amount, and the recipient name as `expectedName` if the user gave one. This moves no money.
2. Show the user the bank-verified account name, bank, account number, naira amount and USDC cost. Ask for a clear yes.
3. Only after that yes, call `send_naira` with the `payoutId` and the bank-verified `accountName`.

Rules:
- Never call `send_naira` without the user's yes for that exact payout.
- If a result says processing, needs_approval or sent_awaiting_payout, never "retry" by preparing or sending a new payout. Use `payout_status`. Calling `send_naira` again with the same `payoutId` only resumes; it never sends twice.
- If the name the user gave does not match the bank, stop and ask. Do not guess.
- If the bank name is ambiguous, use `list_banks` and ask which one.
- Report amounts in naira first (N1,500), then USDC.

## Setup notes
- PAJ login: `npm run login` (emails a code; session lasts a long time).
- The PayBox wallet needs a little SOL for network fees (about 0.0021 SOL per payout to a new PAJ address).
- Secrets live in `.env`, `.paj-session.json` and `payouts.json`. Never print, commit or paste them.
- Tests: `npm test` (no network, no money).
