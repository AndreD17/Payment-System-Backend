import { Router } from "express";
import { pool } from "../db/pool.js";
import { stripe } from "../stripe/client.js";

const router = Router();

const getId = (x: any): string | null => {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x === "object" && typeof x.id === "string") return x.id;
  return null;
};

router.get("/:id/payment-intent", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid subscription id" });

    const r = await pool.query("SELECT * FROM subscriptions WHERE id=$1", [id]);
    const sub = r.rows[0];

    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    if (!sub.stripe_subscription_id) {
      return res.status(400).json({ error: "No Stripe subscription id" });
    }

    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
      expand: [
        "latest_invoice",
        "latest_invoice.payment_intent",
        "latest_invoice.payment_intent.latest_charge",
        "latest_invoice.charge",
        "customer",
      ],
    });

    let inv: any = (stripeSub as any).latest_invoice || null;

    if (!inv) {
      const invoices = await stripe.invoices.list({
        subscription: sub.stripe_subscription_id,
        limit: 1,
      });

      const invLite = invoices.data[0];
      if (!invLite) return res.status(404).json({ error: "No invoices found" });

      inv = await stripe.invoices.retrieve(invLite.id, {
        expand: ["payment_intent", "payment_intent.latest_charge", "charge", "customer"],
      });
    }

    const stripeInvoiceId: string | null = inv?.id ?? null;
    const hostedInvoiceUrl = inv?.hosted_invoice_url ?? null;
    const invoicePdf = inv?.invoice_pdf ?? null;


    const invoiceStatus = inv?.status ?? null;
    const amountDue = typeof inv?.amount_due === "number" ? inv.amount_due : null;
    const amountPaid = typeof inv?.amount_paid === "number" ? inv.amount_paid : null;
    const currency = typeof inv?.currency === "string" ? inv.currency : null;
    const paid = typeof inv?.paid === "boolean" ? inv.paid : null;

    let paymentIntentId: string | null = getId(inv?.payment_intent);
    let chargeId: string | null = getId(inv?.charge);

    if (paymentIntentId && !chargeId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge"],
      });
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
        : amountPaid === 0 || amountDue === 0
        ? "zero_amount_or_trial_no_refund_needed"
        : invoiceStatus !== "paid"
        ? "invoice_not_paid_yet"
        : "no_refund_handle_found";

    return res.json({
      subscriptionId: id,
      stripeSubscriptionId: sub.stripe_subscription_id,
      stripeInvoiceId,
      paymentIntentId,
      chargeId,
      hostedInvoiceUrl,
      invoiceStatus,
      paid,
      amountDue,
      amountPaid,
      invoicePdf,
      currency,
      refundHint,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
