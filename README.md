# Dispute Copilot

An AI copilot that reads every open PayPal dispute, decides whether to fight, settle or refund, and drafts the exact response, so a small shop owner can clear their dispute queue in minutes instead of an afternoon. Nothing reaches PayPal until the owner clicks **Approve**.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

## The problem

For a one-person shop, a PayPal dispute is a small legal case with a deadline. The owner has to read the claim, dig up tracking numbers, guess whether PayPal's seller protection applies, and write a statement in the right format before the response window closes. Many owners refund everything to make the problem go away, losing money on claims they would have won, or they miss deadlines and lose by default.

## What it does

1. **Pulls disputes from PayPal** (Disputes API, sandbox) with their transactions, items and message threads.
2. **Combines them with the shop's own records**: shipping and tracking (filled in automatically from the tracking the shop already added in PayPal), listing details, customer history, and the store policy. Buyer attachments are listed with each message and open through an authenticated proxy.
3. **Reviews each dispute with an LLM through OpenRouter**, which returns a structured decision through forced tool calling:
   - the recommended response (contest with evidence, offer a partial refund, refund in full, or ask the buyer for details)
   - estimated odds of winning and the risk level
   - an evidence checklist showing what the shop has and what is missing
   - fraud signals on unauthorised-transaction claims
   - a ready-to-send statement to PayPal and a message to the buyer
4. **Shows the whole queue in an AG Grid table**, sorted by deadline, with the copilot's call and odds per case.
5. **Sends the approved response back to PayPal**: `provide-evidence` (with tracking info), `make-offer`, `accept-claim` or `send-message`. Every send is recorded in an on-page audit trail.

The model is told never to invent facts. If tracking is missing, it says so, lowers the odds and recommends getting the evidence first. Output is validated server-side (offers capped at the disputed amount, unknown actions rejected) before it can reach PayPal.

## How PayPal and AI are used

| Piece | What it does |
| --- | --- |
| PayPal OAuth 2.0 client credentials | Server-side token with caching (`src/paypal.js`) |
| `GET /v1/customer/disputes` and `/{id}` | Load the queue and full case details |
| `POST …/provide-evidence` (multipart) | Contest with proof of fulfillment, including carrier and tracking number |
| `POST …/make-offer` | Partial refund offers |
| `POST …/accept-claim` | Full refund when the shop is at fault |
| `POST …/send-message` | Messages to the buyer |
| `GET /v1/shipping/trackers` | Auto-fills shipping records from tracking the shop already gave PayPal |
| Dispute document URLs | Buyer attachments, fetched server-side with the OAuth token (PayPal host only) |
| LLM via OpenRouter (any tool-calling model, default `openrouter/free`) | Per-dispute triage with a forced `submit_triage` tool and a strict JSON schema (`src/ai.js`). Output is repaired and validated; if the model is rate limited or returns bad output, the built-in rules engine takes over so the app never breaks. |
| AG Grid Community | Dispute queue with deadline sorting and AI columns |

## Run it

Requires Node.js 20 or newer.

```bash
git clone <this repo>
cd dispute-copilot
npm install
cp .env.example .env   # optional, see below
npm start
```

Open http://localhost:3000.

With no keys, it runs immediately with seven realistic sample disputes for a fictional coffee-gear shop and a built-in rules engine, so you can try every screen. With PayPal keys set, a switch in the header moves between your sandbox and the sample shop.

To use the real integrations, fill in `.env`:

- `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a **sandbox** app at developer.paypal.com. The server refuses to start against live PayPal.
- `OPENROUTER_API_KEY` from openrouter.ai/keys to have an LLM review disputes. Set `OPENROUTER_MODEL` to any tool-calling model; the default `openrouter/free` picks a free one.
- `AI_MAX_CALLS_PER_HOUR` (default 60) caps model calls so a public demo cannot run up a bill.

### Creating sandbox disputes to test with

1. In the PayPal Developer Dashboard, open **Testing Tools > Sandbox Accounts** and note a personal (buyer) and a business (seller) account.
2. Make a sandbox purchase from the buyer to the seller.
3. Log in to sandbox.paypal.com as the buyer, open the transaction and **Report a problem** to open a dispute.
4. Reload Dispute Copilot. The dispute appears in the queue.

## Tests

```bash
npm test
```

44 tests cover the PayPal client (token caching, multipart evidence, error handling), the triage engine (prompt contents, tool forcing, JSON fallback, one retry on a bad answer, timeout and rate-limit fallback, hourly budget, output repair, every rules-engine branch) and the API flows (validation, state changes, audit log, sample reset, attachment proxy, tracking auto-fill).

## Project layout

```
src/paypal.js     PayPal Disputes API client
src/ai.js         OpenRouter triage engine and the rules-engine fallback
src/normalize.js  PayPal dispute -> case shape
src/store.js      Sandbox or demo data, merchant records, triage cache, audit log
src/app.js        Express API and validation
public/           Single-page UI (vanilla JS + AG Grid)
test/             Vitest suites
```

## Tools used

- **OpenRouter** (LLM gateway) powers the dispute review inside the app.
- **Claude** (Anthropic) was used as the development assistant to write this project's code, tests and documentation.
- PayPal Developer sandbox, AG Grid Community, Express, Vitest.

## License

MIT
