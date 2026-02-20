// src/routes/subscriptionPaymentIntent.routes.ts
import { Router } from "express";
import { pool } from "../db/pool.js";
import { stripe } from "../stripe/client.js";
import { requireAuth } from "../middleware/auth.js";
import { requireSubscriptionOwnerOrAdmin } from "../middleware/ownership.js";

const router = Router();

const getId = (x: any): string | null => {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x === "object" && typeof x.id === "string") return x.id;
  return null;
};

function extractPiFromInvoicePayments(inv: any): string | null {
  const payments = inv?.payments?.data;
  if (!Array.isArray(payments)) return null;

  for (const p of payments) {
    const pay = p?.payment ?? p;
    const maybePi =
      (pay?.type === "payment_intent" ? pay?.payment_intent : null) ??
      pay?.payment_intent ??
      null;

    const piId = getId(maybePi);
    if (piId) return piId;
  }
  return null;
}

router.get("/:id/payment-intent", requireAuth, requireSubscriptionOwnerOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid subscription id" });
    }

    const r = await pool.query("SELECT * FROM subscriptions WHERE id=$1", [id]);
    const sub = r.rows[0];

    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    if (!sub.stripe_subscription_id) {
      return res.status(400).json({ error: "No Stripe subscription id" });
    }

    // 1) Latest invoice (lite)
    const invoices = await stripe.invoices.list({
      subscription: sub.stripe_subscription_id,
      limit: 1,
    });

    const invLite = invoices.data[0];
    if (!invLite) return res.status(404).json({ error: "No invoices found" });

    const inv = await stripe.invoices.retrieve(invLite.id, {
      expand: [
        "payment_intent",
        "payment_intent.latest_charge",
        "charge",
        "customer",
        "subscription",
        "parent",
        "parent.subscription_details",
        "payments",
        "payments.data.payment",
      ],
    });

    const hostedInvoiceUrl = (inv as any)?.hosted_invoice_url ?? null;
    const stripeInvoiceId = inv.id;

    const amountDue = typeof (inv as any).amount_due === "number" ? (inv as any).amount_due : null;
    const amountPaid = typeof (inv as any).amount_paid === "number" ? (inv as any).amount_paid : null;
    const paid = typeof (inv as any).paid === "boolean" ? (inv as any).paid : null;

    let paymentIntentId: string | null = getId((inv as any).payment_intent) || extractPiFromInvoicePayments(inv as any);


    let chargeId: string | null = getId((inv as any).charge);
    if (!chargeId && paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
      chargeId = getId((pi as any).latest_charge);
    }

    await pool.query(
      `UPDATE subscriptions
       SET stripe_invoice_id = COALESCE($1, stripe_invoice_id),
           stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
           stripe_charge_id = COALESCE($3, stripe_charge_id),
           updated_at = now()
       WHERE id = $4`,
      [stripeInvoiceId, paymentIntentId, chargeId, id]
    );

    const refundHint =
      paymentIntentId
        ? "refund_by_payment_intent"
        : chargeId
        ? "refund_by_charge"
        : amountDue === 0 || amountPaid === 0
        ? "no_refund_handle_zero_amount_or_trial"
        : "no_refund_handle_found";

    return res.json({
      subscriptionId: id,
      stripeSubscriptionId: sub.stripe_subscription_id,
      stripeInvoiceId,
      paymentIntentId,
      chargeId,
      hostedInvoiceUrl,
      paid,
      amountDue,
      amountPaid,
      refundHint,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
