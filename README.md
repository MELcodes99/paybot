# PayBot

**Send naira to any Nigerian bank account from an agent wallet.**
USDC on Solana in. Naira in a real Nigerian bank account out, in seconds. The bank confirms who owns the account before anyone pays.

- Live service: **https://paybot-562g.onrender.com**
- Agent contract: [`/openapi.json`](https://paybot-562g.onrender.com/openapi.json) and [`/llms.txt`](https://paybot-562g.onrender.com/llms.txt)
- Built for the [PayBox](https://paybox.sh) marketplace on x402. Payouts by [PAJ Cash](https://paj.cash).

---

## Contents

1. [What PayBot is](#what-paybot-is)
2. [The problem it fixes](#the-problem-it-fixes)
3. [How it works](#how-it-works)
4. [Proven with real money](#proven-with-real-money)
5. [For agents: quick start](#for-agents-quick-start)
6. [API reference](#api-reference)
7. [Safety model](#safety-model)
8. [Costs](#costs)
9. [Use PayBot inside Claude Code](#use-paybot-inside-claude-code)
10. [Run your own PayBot](#run-your-own-paybot)
11. [Project layout](#project-layout)
12. [Tests](#tests)
13. [Limits and roadmap](#limits-and-roadmap)

---

## What PayBot is

PayBot is a payment service that lets an AI agent pay a person in Nigeria in naira, straight into their bank account, using the USDC the agent already holds.

You tell your agent something like:

> Send 5,000 naira to my GTBank account 0123456789, Tunde Bakare.

and PayBot handles the rest: it finds the bank, asks the bank who owns that account, works out exactly how much USDC is needed at the live rate, waits for you to confirm the name, and then the naira lands in the account, usually within seconds.

PayBot comes in two forms, built on the same core:

| Form | Who it is for | How it is used |
|---|---|---|
| **Hosted x402 service** | Any agent with a PayBox wallet (or any x402 client) | Call `POST /prepare`, pay $0.01, then pay the USDC with the agent's own wallet |
| **Claude Code tools** | Someone running Claude Code on their own computer with a PayBox wallet | Type a plain-English request in Claude Code; PayBot does the whole flow |

PayBot is **non-custodial**. It never holds anyone's keys and never holds anyone's money. The agent pays the USDC directly to a payout address created by PAJ for that one payment.

## The problem it fixes

Agents are getting wallets. PayBox gives agents USDC on Solana and Base, with spending rules set by their owner, and a marketplace of services they can discover and pay for over x402. But the people those agents work for, and the people they need to pay, often live in their bank accounts, not on-chain.

For Nigeria in particular:

- **There was no naira payout service in the PayBox catalog.** Searching the catalog for naira or Nigerian bank payouts returned only exchange-rate feeds and payout services for other countries. An agent could tell you the dollar to naira rate, but could not actually pay anyone in naira.
- **Getting USDC into a Nigerian bank account is manual.** Today it usually means a P2P trade or an exchange account, copying addresses by hand, and waiting.
- **Wrong-recipient mistakes are permanent.** On-chain payments cannot be reversed. A mistyped account number is a lost payment.
- **Agents cannot check who they are paying.** An agent sees an account number, not a person. Without a name check, it has no way to know it is about to pay the wrong person.

PayBot fixes all four:

- It is a **naira payout service any PayBox agent can find and pay**, with a contract written for agents to follow.
- It turns a payout into **one request and one transfer**, with no exchange account and no manual steps.
- It returns the **bank-verified account name before any money moves**, and refuses outright if the name does not match the name the user gave.
- It gives the agent **exact payment instructions** (address, amount in base units, token, chain), and checks the actual Solana transaction before signing when used from Claude Code.

## How it works

Agent (PayBox wallet) PayBot (this service) PAJ Cash Bank

POST /prepare ----------> find bank, verify account ------> name check
pays $0.01 (x402) create payout order ------> one-off Solana
deposit address
<---------- verified name, exact USDC,
address, status link
Show the person the verified name and cost. Wait for “yes”.
request_transfer -------------------------------------------> USDC arrives
(agent’s own wallet, Solana USDC, exact amount) converts at
live rate ------> naira paid
Poll status link ----------> PAJ order status
<---------- PROCESSING ... COMPLETED

1. **Prepare.** The agent sends the bank name, the 10-digit account number, the naira amount and (ideally) the recipient's name. PayBot finds the bank among 900+ Nigerian banks and fintechs, asks the bank who owns the account, and creates a payout order with PAJ. It returns the bank-verified name, the exact USDC to pay, the Solana address to pay it to, and a private status link. This step costs $0.01, paid over x402.
2. **Confirm.** The agent shows the person the verified name, bank, account number, naira amount and USDC cost, and waits for an explicit yes.
3. **Pay.** The agent pays the USDC from its own wallet with PayBox `request_transfer`. PayBot is not involved in this step and never sees the agent's keys.
4. **Done.** PAJ converts the USDC at the locked rate and pays the naira to the bank account. The status link moves to `COMPLETED`, usually within seconds.

## Proven with real money

These payouts were made on Solana mainnet into a real Opay account while building PayBot:

| Path | Amount | USDC | Result |
|---|---|---|---|
| First spike: PAJ order paid from a PayBox wallet, signed on a Mac | N1,500 | 1.10 | Credited 3 seconds after Solana confirmation |
| Claude Code: one plain-English request, confirmed by the user | N1,500 | 1.10 | `COMPLETED`, credited |
| Live hosted service: an agent paid $0.01 to `/prepare`, then paid the USDC itself | N2,000 | 1.47 | `PROCESSING` to `COMPLETED` in 7 seconds, credited |

The recipient sees the payout on their bank statement with a remark ending in **"PayBot payout"**.

## For agents: quick start

### With PayBox

**Step 1: prepare the payout ($0.01).**

```json
use_service {
  "credential_id": "<your wallet credential_id>",
  "url": "https://paybot-562g.onrender.com/prepare",
  "method": "POST",
  "body": {
    "bank": "GTBank",
    "accountNumber": "0123456789",
    "ngn": 5000,
    "expectedName": "Tunde Bakare"
  }
}
```

The $0.01 can be paid in USDC on Solana or on Base. If the account is invalid or the bank's name does not match `expectedName`, PayBot answers with an error and **you are not charged**.

**Step 2: show the person the `confirm` text and wait for a yes.**

TUNDE BAKARE, Guaranty Trust Bank 0123456789. N5,000 costs 3.69 USDC. Send it?


**Step 3: pay exactly what PayBot returned, once.**

```json
request_transfer {
  "credential_id": "<your Solana wallet credential_id>",
  "chain": "solana:mainnet",
  "to": "<pay.to from step 1>",
  "amount": "<pay.amount from step 1>",
  "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
}
```

Poll PayBox `get_request` with the same `request_id` until it is final. Never call `request_transfer` again for the same payout.

**Step 4: poll `statusUrl` until `status` is `COMPLETED`.**

`ERROR` can appear briefly while PAJ retries. Keep polling. Never pay again.

### With any x402 client

`POST /prepare` is a standard x402 v2 endpoint. An unpaid request returns `402 Payment Required` with a `PAYMENT-REQUIRED` header offering:

| Network | Asset | Amount | Pays to |
|---|---|---|---|
| Solana mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | USDC | 0.01 | PayBot's Solana wallet |
| Base `eip155:8453` | USDC | 0.01 | PayBot's Base wallet |

Retry with a valid `PAYMENT-SIGNATURE` header to receive the payout details. Settlement goes through the PayAI facilitator. The payout itself (step 3) must be a Solana USDC transfer, because PAJ's payout addresses are on Solana.

### Agent rules (also in `/llms.txt`)

- Never pay without the person's yes to the bank-verified name.
- Pay exactly `pay.amount` to `pay.to`. Nothing else, nowhere else.
- One payment per `payoutId`.
- Pay within 15 minutes of preparing. If it has been longer, prepare again.
- The paying Solana wallet needs a little SOL for network fees (see [Costs](#costs)).

## API reference

Base URL: `https://paybot-562g.onrender.com`

### `POST /prepare` (paid, $0.01 over x402)

Verifies the account with the bank and creates a payout. No money moves until the agent pays `pay.to`.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `bank` | string | yes | Bank name as the person said it: `GTBank`, `Opay`, `Access`, `Kuda`, `Moniepoint`, `UBA`, `First Bank`... |
| `accountNumber` | string | yes | 10-digit NUBAN account number |
| `ngn` | integer | yes | Naira the recipient should receive |
| `expectedName` | string | no, recommended | The name the person gave. If the bank says otherwise, nothing is created and you are not charged. Word order, case and punctuation are ignored. |

**Response `200`**

```json
{
  "payoutId": "6ad0d2fb372552a19a9ff36c",
  "status": "awaiting_payment",
  "recipient": { "accountName": "TUNDE BAKARE", "bank": "Guaranty Trust Bank", "accountNumber": "0123456789" },
  "ngn": 5000,
  "usdc": 3.69,
  "rate": 1354.19,
  "pay": {
    "chain": "solana:mainnet",
    "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "to": "<PAJ deposit address for this payout>",
    "amount": "3690000",
    "amountUsdc": 3.69,
    "decimals": 6
  },
  "paybox": {
    "tool": "request_transfer",
    "args": { "credential_id": "<your Solana wallet credential_id>", "chain": "solana:mainnet", "to": "<same as pay.to>", "amount": "3690000", "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
  },
  "confirm": "TUNDE BAKARE, Guaranty Trust Bank 0123456789. N5,000 costs 3.69 USDC. Send it?",
  "rules": ["..."],
  "statusUrl": "https://paybot-562g.onrender.com/status/6ad0d2fb372552a19a9ff36c?token=..."
}
```

**Errors** (never charged, because x402 cancels payment on any error response)

| Status | Meaning |
|---|---|
| `400` | The request body is invalid. The response includes an example body. |
| `422` | Understood but cannot be paid out: unknown or ambiguous bank, account not found, or name mismatch. The `error` field says which. |

### `GET /status/{payoutId}?token=...` (free)

Use the full `statusUrl` from `/prepare`. The token keeps each payout private to whoever prepared it.

```json
{ "payoutId": "6ad0...", "status": "COMPLETED", "done": true, "ngn": 5000, "usdc": 3.69, "txSignature": "...", "note": "Naira paid." }
```

| `status` | Meaning |
|---|---|
| `INIT` | Waiting for the USDC payment |
| `PAID` / `PROCESSING` | USDC received, naira payout under way |
| `ERROR` | A temporary payout problem. PAJ retries. Keep polling, never pay again. |
| `COMPLETED` | Naira paid into the account |

### `GET /banks?search=opay` (free)

Search the Nigerian banks PayBot can pay into. Use it when a bank name is ambiguous.

### `GET /quote?ngn=5000` (free)

Live payout rate and an estimate of the USDC needed. The exact amount is fixed by `/prepare`.

### Discovery

| Path | What it is |
|---|---|
| `/openapi.json` | OpenAPI 3.1 contract with `info.x-guidance` (the full agent flow) and `x-payment-info` (price). This is what the PayBox catalog reads. |
| `/llms.txt` | The same flow in plain text for any LLM agent |
| `/health` | Liveness and which payment networks are on |
| `/` | Landing page |

The `402` response also carries the x402 **bazaar discovery extension**, describing the request and response shape for catalogs that index x402 services.

## Safety model

Every rule below exists because money sent on-chain cannot be taken back.

**Before anything is created**
- The bank is matched strictly. If a name like "Access" could mean several banks, PayBot refuses and lists them instead of guessing.
- The account name comes from the bank itself, not from the person typing.
- If `expectedName` is given and the bank disagrees, PayBot stops. No order, no charge.

**Before any money moves**
- The person sees the bank-verified name and the exact cost, and must say yes.
- Each payout gets its own PAJ order with a fixed amount and a one-off address, so every payment can be tracked to `COMPLETED`.

**When PayBot signs (Claude Code version)**
Before the local key signs anything, PayBot decodes the actual Solana transaction PayBox built and refuses it unless:
- the fee payer and signer is the person's own wallet, and it needs no other signer,
- it contains **exactly one** token transfer, of USDC, for **exactly** the order amount,
- from the person's USDC account to the PAJ address's USDC account,
- with no other programs inside (only compute budget and, if needed, creating the PAJ address's USDC account),
- and the priority fee is under 0.001 SOL.

It is tested against tampered transactions: wrong amount, wrong recipient, a hidden extra SOL transfer, a double transfer and an inflated fee are all refused.

**Never paying twice**
- Each payout records its PayBox request the moment it is made. Asking again resumes that request; it never creates a second transfer.
- A dropped connection mid-signature does not lead to a second payment.
- PAJ's status can briefly show `ERROR` before `COMPLETED`. PayBot treats only `COMPLETED` as done and an `ERROR` as "keep watching", never "send again".

**Never holding funds**
- In the hosted service, agents pay the PAJ address from their own wallet. PayBot only ever receives its $0.01 fee.
- Secrets (PAJ session, status secret) live only in environment variables, never in the repository.

## Costs

| Item | Cost | Paid by |
|---|---|---|
| `POST /prepare` | $0.01 in USDC (Solana or Base) | The agent, over x402 |
| Naira conversion | PAJ's live payout rate (about 1 USDC to N1,354 at the time of writing) | Built into the USDC amount |
| Solana network fee | About 0.000005 SOL per transfer | The paying wallet |
| One-time USDC account for a new PAJ address | About 0.002 SOL | The paying wallet, when the address is new |

So the paying Solana wallet should hold about **0.0021 SOL** per payout in addition to the USDC. Without SOL, PayBox refuses to build the transfer and nothing moves.

## Use PayBot inside Claude Code

The Claude Code version runs on your own computer, uses your own PayBox wallet and signing key, and adds the local transaction check before signing.

**You need:** Node.js 20+, a PayBox account with a Solana wallet holding USDC and a little SOL, the PayBox SDK logged in with a local signing key (`npx @paybox-sh/sdk login`, then `connect`), and a PAJ Cash API key.

```bash
git clone https://github.com/MELcodes99/paybot.git
cd paybot
npm install
cp .env.example .env          # then put your PAJ_API_KEY and PAJ_EMAIL in .env
npm run login                 # PAJ emails you a code; the session lasts a long time
npm test                      # no network, no money
claude mcp add --scope user paybot -- "$(pwd)/node_modules/.bin/tsx" "$(pwd)/mcp.ts"
```

Then open Claude Code and ask:

> send 1,500 naira to my Opay 8012345678, Ada Okafor

**Tools Claude Code gets**

| Tool | What it does | Moves money? |
|---|---|---|
| `wallet_status` | Your PayBox Solana wallet and its USDC and SOL | No |
| `list_banks` | Search Nigerian banks | No |
| `quote` | Live rate and USDC estimate | No |
| `prepare_payout` | Bank-verified name and exact USDC, creates the PAJ order | No |
| `send_naira` | Pays the prepared payout after your yes, checks and signs the transaction, waits for `COMPLETED` | **Yes** |
| `payout_status` | Status of a payout | No |

`CLAUDE.md` in this repository tells Claude Code the rules: verified name first, explicit yes, never retry by sending again.

**Optional settings in `.env`**

| Variable | Effect |
|---|---|
| `PAYBOT_MAX_NGN` | Refuse any single payout above this many naira |
| `PAYBOT_FEE_USDC` | A business fee in USDC, collected by PAJ inside the same order |
| `PAYBOT_SOL_CREDENTIAL` | Which PayBox Solana wallet to use, if you have more than one |
| `SOLANA_RPC_URL` | Your own Solana RPC for balance checks |

### Try the full agent flow against the live service

`scripts/agent-demo.ts` behaves exactly like an outside PayBox agent: it pays $0.01 to the live `/prepare`, shows you the verified name and cost, waits for your yes, pays the USDC with `request_transfer` (through the same transaction check), then watches the status link.

```bash
npm run agent -- Opay 8012345678 2000 "Ada Okafor"
```

## Run your own PayBot

The hosted service is a single Node process (`npm start`). On [Render](https://render.com) (free tier works):

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variables:**

| Variable | Value |
|---|---|
| `PUBLIC_URL` | Your public https address, for example `https://your-paybot.onrender.com` |
| `PAJ_SESSION_TOKEN` | The `token` from `.paj-session.json` after `npm run login` |
| `STATUS_SECRET` | Any long random string (`openssl rand -hex 32`) |
| `PAY_TO_SOL` | Your Solana wallet that receives the $0.01 fees |
| `PAY_TO_EVM` | Your Base wallet that receives the $0.01 fees |
| `PRICE` | Optional, defaults to `$0.01` |
| `FACILITATOR_URL` | Optional, defaults to `https://facilitator.payai.network` |

If neither `PAY_TO_SOL` nor `PAY_TO_EVM` is set, `/prepare` runs free (development mode). Free Render services sleep when idle; a ping to `/health` every 10 minutes (for example with cron-job.org) keeps it awake.

## Project layout

server.ts Hosted x402 service (Hono): /prepare, /status, /banks, /quote, docs
mcp.ts Claude Code server (MCP over stdio): the six tools above
lib/
config.ts Settings, .env loading, exact USDC base-unit math
paj.ts PAJ Cash client: session, banks, name check, orders, status
paybox.ts PayBox side: wallet, balances, request_transfer, checked signing
transfer-check.ts Decodes and checks a Solana transaction before signing
sign-plan.ts Signs a PayBox transaction plan with the local agent key
payout.ts The payout flow: prepare, send, status
store.ts Local payout record that prevents double sends (payouts.json)
site.ts OpenAPI contract, llms.txt and landing page
scripts/
login.ts PAJ login (emailed code)
agent-demo.ts Outside-agent demo against the live service
tests/ 53 checks, no network, no money
CLAUDE.md Rules for Claude Code when using PayBot


## Tests

```bash
npm test
```

53 checks, all offline, no money:

- **Money math:** exact USDC base units, no floating point drift.
- **Name matching:** word order, case and punctuation ignored; different people refused.
- **Transaction check:** honest transfers pass; wrong amount, wrong recipient, hidden SOL transfer, double transfer and inflated fee are refused.
- **Full payout flow** against a simulated PAJ, PayBox and Solana: name mismatch, low SOL, a dropped connection mid-signature (no second transfer), PAJ's temporary `ERROR` before `COMPLETED`, and repeat calls after completion.
- **Hosted service:** every endpoint, status-link privacy, and the x402 paywall (correct `402`, both networks, discovery info, public https address, and PAJ never touched before payment).
- **Claude Code server:** starts like Claude Code launches it, exposes the six tools, refuses unknown payouts.

## Limits and roadmap

**Today**
- Naira (NGN) payouts only, into Nigerian bank and fintech accounts.
- The payout leg is Solana USDC only, because PAJ's payout addresses are on Solana. The $0.01 fee can be paid on Solana or Base.
- Payouts run on the operator's PAJ business account.
- Listing in the public x402 catalogs (Coinbase Bazaar, pay.sh) normally requires 10 or more different paying wallets within 30 days. Until then, agents can use PayBot directly by URL.

**Next**
- A **Telegram bot** front end: connect your own PayBox wallet once, then `/send 20000 GTBank 0123456789` with Confirm and Cancel buttons.
- More PAJ currencies (Ghana cedi, Kenyan shilling, Tanzanian shilling, South African rand).
- Saved recipients and per-day limits for the hosted service.

---

Built by **Jedi Labs** ([@MELcodes99](https://github.com/MELcodes99)) on [PayBox](https://paybox.sh), [PAJ Cash](https://paj.cash) and [x402](https://x402.org). Episode 2 of *What's in the Box*.

PayBot moves real money. Test with small amounts first. Nothing here is financial advice.
