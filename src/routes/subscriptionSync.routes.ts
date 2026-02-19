// src/routes/subscriptionSync.routes.ts
import { Router, Request, Response } from "express";
import { stripe } from "../stripe/client.js";
import { pool } from "../db/pool.js";

const router = Router();

const getId = (x: any): string | null => {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x === "object" && typeof x.id === "string") return x.id;
  return null;
};

const mapStripeSubStatus = (s: any) => {
  if (s === "active" || s === "trialing") return "ACTIVE";
  if (s === "past_due" || s === "unpaid") return "PAST_DUE";
  if (s === "canceled") return "CANCELED";
  return "INCOMPLETE";
};

router.get("/:id/sync", async (req: Request, res: Response) => {
  const subId = Number(req.params.id);

  const r = await pool.query("SELECT * FROM subscriptions WHERE id=$1", [subId]);
  const localSub = r.rows[0];

  if (!localSub) return res.status(404).json({ error: "Subscription not found" });
  if (!localSub.stripe_subscription_id) {
    return res.status(400).json({ error: "No Stripe subscription id" });
  }

  const stripeSub = await stripe.subscriptions.retrieve(localSub.stripe_subscription_id, {
    expand: [
      "latest_invoice",
      "latest_invoice.payment_intent",
      "latest_invoice.payment_intent.latest_charge",
      "latest_invoice.charge",
    ],
  });

  const newStatus = mapStripeSubStatus((stripeSub as any).status);

  const periodEnd =
    typeof (stripeSub as any).current_period_end === "number"
      ? (stripeSub as any).current_period_end
      : Math.floor(Date.now() / 1000);

  const li: any = (stripeSub as any).latest_invoice;

  const stripeInvoiceId = getId(li);
  const paymentIntentId = getId(li?.payment_intent);

  let chargeId = getId(li?.charge);
  if (!chargeId && li?.payment_intent) {
    chargeId = getId(li.payment_intent?.latest_charge);
  }

  await pool.query(
    `UPDATE subscriptions
     SET status=$1,
         current_period_end=to_timestamp($2),
         stripe_invoice_id = COALESCE($3, stripe_invoice_id),
         stripe_payment_intent_id = COALESCE($4, stripe_payment_intent_id),
         stripe_charge_id = COALESCE($5, stripe_charge_id),
         updated_at=now()
     WHERE id=$6`,
    [newStatus, periodEnd, stripeInvoiceId, paymentIntentId, chargeId, localSub.id]
  );

  return res.json({
    message: "Subscription synced",
    stripeStatus: (stripeSub as any).status,
    localStatus: newStatus,
    periodEnd,
    stripeInvoiceId,
    paymentIntentId,
    chargeId,
  });
});

export default router;
