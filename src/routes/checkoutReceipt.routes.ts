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

async function getReceiptForLocalSubscription(localSubId: number) {
  const r = await pool.query("SELECT * FROM subscriptions WHERE id=$1", [localSubId]);
  const sub = r.rows[0];

  if (!sub) return { status: 404, body: { error: "Subscription not found" } };
  if (!sub.stripe_subscription_id) {
    return { status: 400, body: { error: "No Stripe subscription id yet. Try again in a few seconds." } };
  }

  const invoices = await stripe.invoices.list({
    subscription: sub.stripe_subscription_id,
    limit: 1,
  });

  const invLite = invoices.data[0];
  if (!invLite) return { status: 404, body: { error: "No invoices found" } };

  const inv = await stripe.invoices.retrieve(invLite.id, {
    expand: ["payment_intent", "payment_intent.latest_charge", "charge", "customer", "subscription", "parent"],
  });

  const hostedInvoiceUrl = (inv as any)?.hosted_invoice_url ?? null;
  const stripeInvoiceId = inv.id;

  const amountDue = typeof (inv as any).amount_due === "number" ? (inv as any).amount_due : null;
  const amountPaid = typeof (inv as any).amount_paid === "number" ? (inv as any).amount_paid : null;
  const currency = typeof (inv as any).currency === "string" ? (inv as any).currency : null;
  const invoiceStatus = (inv as any)?.status ?? null;

  let paymentIntentId: string | null = getId((inv as any).payment_intent);

  let chargeId: string | null = getId((inv as any).charge);
  if (!chargeId && (inv as any).payment_intent) {
    chargeId = getId((inv as any).payment_intent?.latest_charge);
  }

  await pool.query(
    `UPDATE subscriptions
     SET stripe_invoice_id = COALESCE($1, stripe_invoice_id),
         stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
         stripe_charge_id = COALESCE($3, stripe_charge_id),
         updated_at = now()
     WHERE id = $4`,
    [stripeInvoiceId, paymentIntentId, chargeId, localSubId]
  );

  return {
    status: 200,
    body: {
      subscriptionId: localSubId,
      stripeSubscriptionId: sub.stripe_subscription_id,
      stripeInvoiceId,
      paymentIntentId,
      chargeId,
      hostedInvoiceUrl,
      invoiceStatus,
      amountDue,
      amountPaid,
      currency,
    },
  };
}

router.get("/receipt/by-session/:sessionId", async (req, res, next) => {
  try {
    const schema = z.object({ sessionId: z.string().min(5) });
    const parsed = schema.safeParse({ sessionId: req.params.sessionId });
    if (!parsed.success) return res.status(400).json({ error: "Invalid session id" });

    const sessionId = parsed.data.sessionId;

    const sRes = await pool.query(
      `SELECT id, stripe_subscription_id
       FROM subscriptions
       WHERE stripe_checkout_session_id = $1
       LIMIT 1`,
      [sessionId]
    );

    if (sRes.rows[0]?.id) {
      const out = await getReceiptForLocalSubscription(Number(sRes.rows[0].id));
      return res.status(out.status).json(out.body);
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    const stripeSubId = getId((session as any).subscription);

    const metaLocalSubIdRaw =
      (session as any)?.metadata?.subscriptionId ??
      (session as any)?.client_reference_id ??
      null;

    const metaLocalSubId = metaLocalSubIdRaw ? Number(metaLocalSubIdRaw) : 0;

    if (metaLocalSubId && Number.isFinite(metaLocalSubId)) {
      await pool.query(
        `UPDATE subscriptions
         SET stripe_checkout_session_id = COALESCE($1, stripe_checkout_session_id),
             stripe_subscription_id = COALESCE($2, stripe_subscription_id),
             updated_at = now()
         WHERE id = $3`,
        [sessionId, stripeSubId, metaLocalSubId]
      );

      const out = await getReceiptForLocalSubscription(metaLocalSubId);
      return res.status(out.status).json(out.body);
    }

    if (stripeSubId) {
      const r2 = await pool.query(
        `SELECT id FROM subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
        [stripeSubId]
      );
      if (r2.rows[0]?.id) {
        const out = await getReceiptForLocalSubscription(Number(r2.rows[0].id));
        return res.status(out.status).json(out.body);
      }
    }

    return res.status(404).json({
      error: "Could not map session to local subscription yet. Try again in a few seconds.",
      sessionId,
      stripeSubscriptionId: stripeSubId,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
