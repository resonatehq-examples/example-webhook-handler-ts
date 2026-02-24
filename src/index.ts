import express from "express";
import { Resonate } from "@resonatehq/sdk";
import { processPayment } from "./workflow";
import type { WebhookEvent } from "./handlers";

// ---------------------------------------------------------------------------
// Resonate setup
// ---------------------------------------------------------------------------

const resonate = new Resonate();
resonate.register(processPayment);

// ---------------------------------------------------------------------------
// Express webhook server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// POST /webhook — receives Stripe-style payment events.
// The event_id becomes the Resonate promise ID — the deduplication key.
// If the same event_id arrives twice (Stripe retry), the second call finds
// the existing promise and returns immediately. No double-processing.
app.post("/webhook", (req, res) => {
  const event = req.body as WebhookEvent;

  if (!event.event_id || !event.type) {
    res.status(400).json({ error: "Missing event_id or type" });
    return;
  }

  console.log(`\n[webhook]    Received ${event.event_id} (${event.type})`);

  // Fire and forget — Stripe needs a fast 200 OK (within 5 seconds).
  // Processing happens durably in the background.
  resonate
    .run(`webhook/${event.event_id}`, processPayment, event, simulateCrash)
    .catch(console.error);

  // Acknowledge receipt immediately
  res.status(200).json({ received: true });
});

// GET /status/:event_id — poll for processing result
app.get("/status/:event_id", async (req, res) => {
  try {
    const handle = await resonate.get(`webhook/${req.params["event_id"]}`);
    const done = await handle.done();

    if (!done) {
      res.json({ status: "processing" });
      return;
    }

    const result = await handle.result();
    res.json({ status: "done", result });
  } catch {
    res.status(404).json({ status: "not_found" });
  }
});

// ---------------------------------------------------------------------------
// Start server + run demo
// ---------------------------------------------------------------------------

const simulateCrash = process.argv.includes("--crash");

const PORT = 3000;
const server = app.listen(PORT);

// Wait for server to start
await new Promise((r) => setTimeout(r, 100));

const event: WebhookEvent = {
  event_id: `evt_${Date.now()}`,
  type: "payment_intent.succeeded",
  amount: 4999,
  currency: "usd",
  customer_id: "cus_alice",
};

if (simulateCrash) {
  // -------------------------------------------------------------------------
  // Crash demo: payment processor fails on attempt 1, Resonate retries.
  // validate() runs once. chargeCard() fails then succeeds.
  // sendReceipt() and updateLedger() only run after chargeCard() succeeds.
  // -------------------------------------------------------------------------
  console.log("=== Webhook Handler Demo ===");
  console.log(
    "Mode: CRASH (payment processor times out on first attempt, retries once)\n",
  );

  console.log(`--- Sending webhook ${event.event_id} ---`);
  await fetch(`http://localhost:${PORT}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  // Wait for retry to complete (~4 seconds with retry backoff)
  await new Promise((r) => setTimeout(r, 5000));

  const statusRes = await fetch(`http://localhost:${PORT}/status/${event.event_id}`);
  const status = (await statusRes.json()) as { status: string; result: unknown };

  console.log("\n=== Result ===");
  console.log(JSON.stringify(status.result, null, 2));
  console.log(
    "\nNotice: validate ran once. Charge failed → retried → succeeded.",
    "\nThe customer was charged exactly once.",
  );
} else {
  // -------------------------------------------------------------------------
  // Deduplication demo: same webhook arrives twice (Stripe retry scenario).
  // The payment runs once — the second webhook returns immediately from cache.
  // -------------------------------------------------------------------------
  console.log("=== Webhook Handler Demo ===");
  console.log(
    "Mode: DEDUPLICATION (same webhook sent twice, processed once)\n",
  );

  console.log(`--- First delivery of ${event.event_id} ---`);
  await fetch(`http://localhost:${PORT}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  // Wait for processing to complete
  await new Promise((r) => setTimeout(r, 700));

  console.log(
    `\n--- Stripe retries ${event.event_id} (simulating network timeout on first delivery) ---\n`,
  );

  await fetch(`http://localhost:${PORT}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  // No new logs should appear — the workflow is already done
  await new Promise((r) => setTimeout(r, 300));

  const statusRes = await fetch(`http://localhost:${PORT}/status/${event.event_id}`);
  const status = (await statusRes.json()) as { status: string; result: unknown };

  console.log("\n=== Result ===");
  console.log(JSON.stringify(status.result, null, 2));
  console.log(
    "\nNotice: validate/charge/receipt/ledger each logged exactly ONCE.",
    "\nThe retry returned the cached result — no duplicate charge.",
  );
}

server.close();
