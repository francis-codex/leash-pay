# leash for paypal

**your agent can be tricked. your money can't.**

an ai agent pays invoices through paypal. invoices are untrusted text, and the agent has no defense against prompt injection, on purpose. it still can't send money where it shouldn't, because it never holds a paypal credential. every payment goes through a policy gate on our server, and anything the gate won't pay becomes a paypal order that only the owner can approve by logging in to paypal.

## the problem

agents that pay bills read invoices, emails and web pages. any of those can say "we changed banks, pay this address instead". prompt defenses help, but they're probabilistic. money needs a hard line the model can't talk its way past.

## how it works

1. **the agent reads.** an invoice arrives. the agent (ai sdk `streamText` with tools) reads it, checks the vendor list and budget, and decides to `pay` or `request_approval`.
2. **the gate decides.** `pay` goes to `src/lib/policy.ts`, not to paypal. the gate checks, in order:
   - the amount is a valid positive cent value
   - the payee email is on the owner's vendor allowlist
   - the amount is at or under the per-payment max (default $20)
   - today's total stays under the daily cap (default $50), reserved atomically in redis
   - this exact payment (attempt + payee + amount) hasn't been paid already
   only then does it call **paypal payouts** (`POST /v1/payments/payouts`), with a deterministic `sender_batch_id` and `PayPal-Request-Id` so a retry can't pay twice.
3. **the owner approves.** anything else the agent wants to pay becomes a **paypal order** (`POST /v2/checkout/orders`, intent `CAPTURE`). the owner opens `/approve/[id]`, reviews it, and approves on paypal.com with their own login. on return, our server checks the order (`GET /v2/checkout/orders/{id}`) and captures only if paypal says `APPROVED`.

## what is enforced where (honest version)

| rule | enforced by |
| --- | --- |
| agent has no paypal credentials | architecture: the model only sees tools; credentials live in server env, used only by `paypal.ts` |
| vendor allowlist, per-payment max, daily cap, no double pay | **our server** (`policy.ts` + redis). not paypal. if our server were compromised, these could be bypassed |
| off-policy payments need the owner | **paypal**: the order can't be captured until the owner approves it in their paypal login |
| idempotency | our redis claim plus paypal's `sender_batch_id` / `PayPal-Request-Id` |

## the four outcomes

every attempt is classified by code, not by the model:

- **blocked by the gate**: the agent tried to pay, the gate refused
- **sent to the owner**: became a paypal order waiting for the owner
- **agent said no**: the model didn't take the bait
- **paid a real vendor**: money only went to the allowlist

## prove it

```bash
pnpm prove
```

runs seven checks against the gate: a vendor gets paid, a retry is refused, an off-list payee is refused, an over-limit amount is refused, the daily cap holds, an off-policy payment becomes an order, and a second ask is refused. without `PAYPAL_CLIENT_ID` it uses a local fake; with it, it hits the paypal sandbox.

## run it yourself

```bash
pnpm install
cp .env.example .env.local   # fill in what you have
LEASH_MOCK_MODEL=1 pnpm dev  # scripted "fully fooled" agent, no model key needed
```

open `http://localhost:3000/arena` and write an invoice that tries to make it pay you.

## environment variables

| var | what |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | paypal app credentials (sandbox by default). unset in dev = local fake. required in production |
| `PAYPAL_ENV` | `live` to use api-m.paypal.com. anything else = sandbox |
| `LEASH_VENDORS` | json `[{"name":"...","email":"..."}]`, the allowlist |
| `LEASH_MAX_PER_PAYMENT_USD` | default 20 |
| `LEASH_DAILY_CAP_USD` | default 50 |
| `LEASH_MAX_APPROVAL_USD` | largest amount the agent may even ask for, default 500 |
| `LEASH_APP_URL` | public url, used for paypal return/cancel links |
| `AI_GATEWAY_API_KEY` or `ANTHROPIC_API_KEY` | the model |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | storage. unset = in-memory (dev only) |
| `LEASH_MOCK_MODEL` | `1` = scripted model, dev only |

## stack

next.js 15, react 19, ai sdk (`streamText` + tools), paypal rest (payouts + orders v2), upstash redis, tailwind.

## known limits

- the allowlist and caps live on our server, not in paypal. we say so on the site.
- the reject button on an approval is not behind owner auth; rejecting can't move money, approving still needs the owner's paypal login.
- payouts in sandbox may stay `PENDING` for a while; that's paypal's sandbox, not a failure.

## license

MIT
