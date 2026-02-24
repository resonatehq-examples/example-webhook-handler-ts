# Webhook Handler

Exactly-once webhook processing with automatic deduplication. Models a Stripe-style payment webhook receiver: validate → charge → receipt → ledger. If the webhook is retried (network timeout, slow ACK), the payment is not processed twice — Resonate deduplicates via the event ID.

## What This Demonstrates

- **Idempotent webhook processing**: same event_id → same result, never executed twice
- **Exactly-once side effects**: payment charged once, receipt sent once, ledger updated once
- **Durable crash recovery**: if the process dies after charging but before sending the receipt, it resumes from the charge checkpoint — not from scratch
- **HTTP webhook pattern**: Express endpoint returns 200 immediately; processing is asynchronous

## How It Works

The `event_id` from Stripe's webhook payload becomes the Resonate promise ID:

```typescript
resonate.run(`webhook/${event.event_id}`, processPayment, event, simulateCrash)
```

If Stripe retries the same `event_id`, `resonate.run()` finds the existing promise and returns it immediately — without re-executing. No database deduplication table required. No Redis lock. The durability guarantee comes for free.

## Prerequisites

- [Bun](https://bun.sh) v1.0+

No external services required. Resonate runs in embedded mode.

## Setup

```bash
git clone https://github.com/resonatehq-examples/example-webhook-handler-ts
cd example-webhook-handler-ts
bun install
```

## Run It

**Deduplication mode** — same webhook delivered twice, processed once:
```bash
bun start
```

```
=== Webhook Handler Demo ===
Mode: DEDUPLICATION (same webhook sent twice, processed once)

--- First delivery of evt_1771882806897 ---

[webhook]    Received evt_1771882806897 (payment_intent.succeeded)
  [validate]  Checking signature for evt_1771882806897...
  [validate]  evt_1771882806897 OK — payment_intent.succeeded, $49.99 USD
  [charge]    Authorizing $49.99 for cus_alice (attempt 1)...
  [charge]    Charge ch_vvjywpy5 captured
  [receipt]   Emailing receipt to cus_alice for ch_vvjywpy5...
  [receipt]   Receipt sent
  [ledger]    Recording ch_vvjywpy5 in accounting ledger...
  [ledger]    Transaction recorded

--- Stripe retries evt_1771882806897 (simulating network timeout on first delivery) ---

[webhook]    Received evt_1771882806897 (payment_intent.succeeded)

=== Result ===
{
  "event_id": "evt_1771882806897",
  "charge_id": "ch_vvjywpy5",
  "status": "captured",
  "amount": 4999,
  "processedAt": "2026-02-23T21:40:07.329Z"
}

Notice: validate/charge/receipt/ledger each logged exactly ONCE.
The retry returned the cached result — no duplicate charge.
```

**Crash mode** — payment processor fails on first attempt, retries:
```bash
bun start:crash
```

```
Mode: CRASH (payment processor times out on first attempt, retries once)

  [validate]  Checking signature for evt_...
  [validate]  evt_... OK — payment_intent.succeeded, $49.99 USD
  [charge]    Authorizing $49.99 for cus_alice (attempt 1)...
Runtime. Function 'chargeCard' failed with 'Error: Payment processor timeout' (retrying in 2 secs)
  [charge]    Authorizing $49.99 for cus_alice (attempt 2)...
  [charge]    Charge ch_k0d09pgw captured
  [receipt]   Emailing receipt to cus_alice for ch_k0d09pgw...
  [receipt]   Receipt sent
  [ledger]    Recording ch_k0d09pgw in accounting ledger...
  [ledger]    Transaction recorded
```

## What to Observe

1. **Deduplication**: validate/charge/receipt/ledger each log exactly once, even though the webhook arrives twice. The second delivery doesn't trigger any reprocessing.
2. **The cached result**: the second webhook returns the same `charge_id` from the first run — not a new charge.
3. **Crash recovery**: in crash mode, validate runs once. Charge fails then succeeds. The customer is charged exactly once — the retry was at the function level, not the workflow level.
4. **No dedup table needed**: no database, no Redis, no distributed lock. The promise ID is the deduplication key.

## The Code

The entire workflow is 20 lines in [`src/workflow.ts`](src/workflow.ts):

```typescript
export function* processPayment(ctx: Context, event: WebhookEvent) {
  yield* ctx.run(validateEvent, event);
  const chargeId = yield* ctx.run(chargeCard, event, simulateCrash);
  yield* ctx.run(sendReceipt, event, chargeId);
  const result = yield* ctx.run(updateLedger, event, chargeId);
  return result;
}
```

The deduplication is in the entry point, one line:

```typescript
resonate.run(`webhook/${event.event_id}`, processPayment, event, false)
```

That's it. If `event_id` already exists in the promise store, `resonate.run()` returns the cached result. If not, it creates a new execution.

## File Structure

```
example-webhook-handler-ts/
├── src/
│   ├── index.ts      Entry point — Express server + demo runner
│   ├── workflow.ts   Payment workflow — 4 durable steps
│   └── handlers.ts   Step implementations — validate, charge, receipt, ledger
├── package.json
└── tsconfig.json
```

**Lines of code**: ~200 total, ~20 lines of workflow logic.

## Comparison

Restate's webhook callbacks example ([github](https://github.com/restatedev/examples/tree/main/typescript/patterns-use-cases/src/webhookcallbacks)) uses virtual objects with `objectSendClient` for routing and state management (~50 LOC for the pattern layer alone). DBOS calls this "exactly-once transactions" and requires their decorator pattern and schema registration.

Resonate's approach: the promise ID is the deduplication key. No additional infrastructure. The same mechanism that provides durability provides idempotency.

| | Resonate | Restate | DBOS |
|---|---|---|---|
| Dedup mechanism | Promise ID | Virtual object key | Transaction decorator |
| Extra infrastructure | None | Restate server | DBOS server + Postgres |
| Workflow code | 20 LOC | ~50 LOC | ~40 LOC |
| Setup | `bun install && bun start` | Docker Compose | DBOS CLI + schema migration |

## Learn More

- [Resonate documentation](https://docs.resonatehq.io)
- [Restate webhook callbacks](https://github.com/restatedev/examples/tree/main/typescript/patterns-use-cases/src/webhookcallbacks)
- [Stripe webhook best practices](https://stripe.com/docs/webhooks/best-practices)
