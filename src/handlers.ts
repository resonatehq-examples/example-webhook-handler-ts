import type { Context } from "@resonatehq/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookEvent {
  event_id: string;
  type: "payment_intent.succeeded" | "payment_intent.failed";
  amount: number; // in cents
  currency: string;
  customer_id: string;
}

export interface PaymentResult {
  event_id: string;
  charge_id: string;
  status: "captured";
  amount: number;
  processedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Track charge attempts per event_id — Resonate retries functions in the same
// process, so on attempt 2 this counter is 2 and the simulated crash is skipped.
const chargeAttempts = new Map<string, number>();

// ---------------------------------------------------------------------------
// Step 1: Validate event structure and signature
// ---------------------------------------------------------------------------

export async function validateEvent(_ctx: Context, event: WebhookEvent): Promise<void> {
  console.log(`  [validate]  Checking signature for ${event.event_id}...`);
  await sleep(50);
  // In production: verify Stripe-Signature HMAC against your webhook secret
  console.log(
    `  [validate]  ${event.event_id} OK — ${event.type}, $${(event.amount / 100).toFixed(2)} ${event.currency.toUpperCase()}`,
  );
}

// ---------------------------------------------------------------------------
// Step 2: Charge the card (idempotent — checkpoint prevents double charge)
// ---------------------------------------------------------------------------

export async function chargeCard(
  _ctx: Context,
  event: WebhookEvent,
  simulateCrash: boolean,
): Promise<string> {
  const attempt = (chargeAttempts.get(event.event_id) ?? 0) + 1;
  chargeAttempts.set(event.event_id, attempt);

  console.log(
    `  [charge]    Authorizing $${(event.amount / 100).toFixed(2)} for ${event.customer_id} (attempt ${attempt})...`,
  );
  await sleep(200);

  if (simulateCrash && attempt === 1) {
    // Simulate payment processor timeout on first attempt.
    // Resonate retries this step. The validate step is NOT re-run.
    throw new Error("Payment processor timeout — will retry");
  }

  const chargeId = `ch_${Math.random().toString(36).slice(2, 10)}`;
  console.log(`  [charge]    Charge ${chargeId} captured`);
  return chargeId;
}

// ---------------------------------------------------------------------------
// Step 3: Send receipt to customer
// ---------------------------------------------------------------------------

export async function sendReceipt(
  _ctx: Context,
  event: WebhookEvent,
  chargeId: string,
): Promise<void> {
  console.log(`  [receipt]   Emailing receipt to ${event.customer_id} for ${chargeId}...`);
  await sleep(80);
  console.log(`  [receipt]   Receipt sent`);
}

// ---------------------------------------------------------------------------
// Step 4: Record transaction in accounting ledger
// ---------------------------------------------------------------------------

export async function updateLedger(
  _ctx: Context,
  event: WebhookEvent,
  chargeId: string,
): Promise<PaymentResult> {
  console.log(`  [ledger]    Recording ${chargeId} in accounting ledger...`);
  await sleep(60);
  const result: PaymentResult = {
    event_id: event.event_id,
    charge_id: chargeId,
    status: "captured",
    amount: event.amount,
    processedAt: new Date().toISOString(),
  };
  console.log(`  [ledger]    Transaction recorded`);
  return result;
}
