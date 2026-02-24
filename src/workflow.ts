import type { Context } from "@resonatehq/sdk";
import {
  validateEvent,
  chargeCard,
  sendReceipt,
  updateLedger,
  type WebhookEvent,
  type PaymentResult,
} from "./handlers";

// ---------------------------------------------------------------------------
// Webhook Payment Workflow
// ---------------------------------------------------------------------------
// Processes a Stripe-style payment webhook exactly once.
//
// The promise ID is `webhook/${event.event_id}` — the natural deduplication key.
//
// When Stripe retries a webhook (network timeout, slow ACK, 5xx response),
// the same event_id arrives again. Resonate detects the promise already exists
// and returns the cached result immediately — without re-executing.
//
// Without this: customer charged twice.
// With Resonate: charge runs once, period.
//
// The crash recovery story is equally important: if the process dies after
// chargeCard() succeeds but before updateLedger() runs, Resonate resumes
// from the chargeCard checkpoint — no second charge.

export function* processPayment(
  ctx: Context,
  event: WebhookEvent,
  simulateCrash: boolean,
): Generator<any, PaymentResult, any> {
  // Step 1: Validate signature and event structure
  yield* ctx.run(validateEvent, event);

  // Step 2: Charge the card — checkpointed.
  // If this crashes and retries, we call the payment processor exactly once.
  // If a duplicate webhook arrives with the same event_id, this step is
  // returned from cache — the processor is never called again.
  const chargeId = yield* ctx.run(chargeCard, event, simulateCrash);

  // Step 3: Send receipt
  yield* ctx.run(sendReceipt, event, chargeId);

  // Step 4: Update accounting ledger
  const result = yield* ctx.run(updateLedger, event, chargeId);

  return result;
}
