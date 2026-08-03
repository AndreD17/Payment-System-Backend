// src/routes/public.routes.ts
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { stripe } from "../stripe/client.js";
import { cacheMiddleware } from "../middleware/cache.js";

const router = Router();

const getId = (x: any): string | null => {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x === "object" && typeof x.id === "string") return x.id;
  return null;
};

// 🔁 small helper to wait (for retry)
const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

router.get("/receipt/:sessionId", cacheMiddleware(15), async (req, res, next) => {
  try {
    const schema = z.object({ sessionId: z.string().min(10) });
    const parsed = schema.safeParse({ sessionId: req.params.sessionId });

    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const sessionId = parsed.data.sessionId;

    // 1️⃣ Checkout Session
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    const stripeSubId = getId((session as any).subscription);

    if (!stripeSubId) {
      return res.status(202).json({
        processing: true,
        message: "Subscription not ready yet. Retry shortly.",
      });
    }

    // 2️⃣ Subscription
    const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
      expand: ["latest_invoice"],
    });

    const latestInvoice = (stripeSub as any).latest_invoice;
    const stripeInvoiceId = getId(latestInvoice);

    if (!stripeInvoiceId) {
      return res.status(202).json({
        processing: true,
        message: "Invoice not ready yet. Retry shortly.",
      });
    }

    // 🔁 Fetch invoice
    const fetchInvoice = async () =>
      await stripe.invoices.retrieve(stripeInvoiceId, {
        expand: [
          "customer",
          "payment_intent",
          "payment_intent.latest_charge",
          "lines.data.price.product",
        ],
      });

    let inv: any = await fetchInvoice();

    // retry once
    if (!inv.payment_intent || inv.status !== "paid") {
      await wait(1500);
      inv = await fetchInvoice();
    }

    const invoiceStatus = inv?.status ?? null;

    if (invoiceStatus !== "paid") {
      return res.status(202).json({
        processing: true,
        message: "Payment not completed yet",
        invoiceStatus,
      });
    }

    // =========================
    // ✅ PAYMENT INTENT FIX
    // =========================
    let paymentIntentId: string | null = null;
    let chargeId: string | null = null;

    // CASE 1: Normal (works sometimes)
    if (inv.payment_intent) {
      paymentIntentId =
        typeof inv.payment_intent === "string"
          ? inv.payment_intent
          : inv.payment_intent.id;

      if (typeof inv.payment_intent !== "string") {
        chargeId =
          typeof inv.payment_intent.latest_charge === "string"
            ? inv.payment_intent.latest_charge
            : inv.payment_intent.latest_charge?.id ?? null;
      }
    }

    // CASE 2: Backfill (if payment_intent is missing)
    if (!paymentIntentId) {
      const charges = await stripe.charges.list({
        limit: 1,
        invoice: stripeInvoiceId,
      });

      const charge = charges.data[0];

      if (charge) {
        chargeId = charge.id;
        paymentIntentId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent?.id ?? null;
      }
    }

    
    let receiptUrl: string | null = null;

    if (chargeId) {
      const ch = await stripe.charges.retrieve(chargeId);
      receiptUrl = ch?.receipt_url ?? null;
    }

    // product info
    const firstLine = inv?.lines?.data?.[0];
    const productName = firstLine?.price?.product?.name ?? null;
    const interval = firstLine?.price?.recurring?.interval ?? null;

    const customerEmail = inv?.customer_email ?? inv?.customer?.email ?? null;

    const created = inv?.created ?? null;
    const amountPaid = inv?.amount_paid ?? null;
    const currency = inv?.currency ?? null;

    // 🧠 BACKFILL DB
    await pool.query(
      `
      UPDATE subscriptions
      SET stripe_subscription_id = COALESCE($1, stripe_subscription_id),
          stripe_invoice_id = COALESCE($2, stripe_invoice_id),
          stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
          stripe_charge_id = COALESCE($4, stripe_charge_id),
          updated_at = now()
      WHERE stripe_checkout_session_id = $5
      `,
      [stripeSubId, stripeInvoiceId, paymentIntentId, chargeId, sessionId]
    );

    return res.json({
      ok: true,
      sessionId,

      stripeSubscriptionId: stripeSubId,
      stripeInvoiceId,

      // ✅ GUARANTEED NOW
      paymentIntentId,
      chargeId,

      receiptUrl,
      hostedInvoiceUrl: inv?.hosted_invoice_url ?? null,
      invoicePdf: inv?.invoice_pdf ?? null,

      invoiceStatus,
      amountPaid,
      currency,
      created,

      customerEmail,
      productName,
      interval,
    });
  } catch (e) {
    next(e);
  }
});

export default router;