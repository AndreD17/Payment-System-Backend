// src/routes/public.routes.ts
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { stripe } from "../stripe/client.js";

const router = Router();

const getId = (x: any): string | null => {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x === "object" && typeof x.id === "string") return x.id;
  return null;
};

router.get("/receipt/:sessionId", async (req, res, next) => {
  try {
    const schema = z.object({ sessionId: z.string().min(10) });
    const parsed = schema.safeParse({ sessionId: req.params.sessionId });
    if (!parsed.success) return res.status(400).json({ error: "Invalid session id" });

    const sessionId = parsed.data.sessionId;

    // 1) Checkout Session
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "customer"],
    });

    const stripeSubId = getId((session as any).subscription);

    if (!stripeSubId) {
      return res.status(202).json({
        processing: true,
        message: "Subscription is still being finalized. Refresh in a few seconds.",
        sessionId,
      });
    }

    // 2) Subscription -> latest_invoice
    const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
      expand: ["latest_invoice"],
    });

    const periodEndUnix =
      typeof (stripeSub as any).current_period_end === "number" ? (stripeSub as any).current_period_end : null;

    const li: any = (stripeSub as any).latest_invoice;
    const stripeInvoiceId = getId(li);

    if (!stripeInvoiceId) {
      return res.status(202).json({
        processing: true,
        message: "Invoice not ready yet. Refresh in a few seconds.",
        sessionId,
        stripeSubscriptionId: stripeSubId,
      });
    }

    // 3) Invoice (expand for receipt info)
    const inv: any = await stripe.invoices.retrieve(stripeInvoiceId, {
      expand: [
        "customer",
        "payment_intent",
        "payment_intent.latest_charge",
        "charge",
        "lines.data.price.product",
      ],
    });

    const invoiceStatus = inv?.status ?? null;
    const hostedInvoiceUrl = inv?.hosted_invoice_url ?? null;
    const invoicePdf = inv?.invoice_pdf ?? null;
    const invoiceNumber = inv?.number ?? null;
    const created = typeof inv?.created === "number" ? inv.created : null;

    const amountPaid = typeof inv?.amount_paid === "number" ? inv.amount_paid : null;
    const amountDue = typeof inv?.amount_due === "number" ? inv.amount_due : null;
    const currency = typeof inv?.currency === "string" ? inv.currency : null;

    const paymentIntentId = getId(inv?.payment_intent);

    // charge fallback
    let chargeId = getId(inv?.charge);
    if (!chargeId && inv?.payment_intent) chargeId = getId(inv.payment_intent?.latest_charge);

    let receiptUrl: string | null = null;
    if (chargeId) {
      const ch: any = await stripe.charges.retrieve(chargeId);
      receiptUrl = ch?.receipt_url ?? null;
    }

    // product/plan info (from invoice line)
    const firstLine = inv?.lines?.data?.[0];
    const productName = firstLine?.price?.product?.name ?? null;
    const interval = firstLine?.price?.recurring?.interval ?? null;

    // customer info
    const customerEmail = inv?.customer_email ?? inv?.customer?.email ?? null;

    // local sub id (optional, for your DB)
    const local = await pool.query(
      `SELECT id FROM subscriptions WHERE stripe_checkout_session_id=$1 LIMIT 1`,
      [sessionId]
    );
    const localId = local.rows?.[0]?.id ? Number(local.rows[0].id) : null;

    // backfill DB (best effort)
    if (localId) {
      await pool.query(
        `UPDATE subscriptions
         SET stripe_subscription_id = COALESCE($1, stripe_subscription_id),
             stripe_invoice_id = COALESCE($2, stripe_invoice_id),
             stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
             stripe_charge_id = COALESCE($4, stripe_charge_id),
             current_period_end = COALESCE(to_timestamp($5), current_period_end),
             updated_at = now()
         WHERE id = $6`,
        [stripeSubId, stripeInvoiceId, paymentIntentId, chargeId, periodEndUnix, localId]
      );
    }

    return res.json({
      ok: true,
      sessionId,

      // local
      subscriptionId: localId,

      // stripe
      stripeSubscriptionId: stripeSubId,
      stripeInvoiceId,
      paymentIntentId,
      chargeId,

      // receipt
      invoiceStatus,
      hostedInvoiceUrl,
      invoicePdf,
      receiptUrl,
      invoiceNumber,
      created,

      // money
      amountPaid,
      amountDue,
      currency,

      // user-facing extras
      customerEmail,
      productName,
      interval,

      // time
      currentPeriodEnd: periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null,
    });
  } catch (e) {
    next(e);
  }
});

export default router;