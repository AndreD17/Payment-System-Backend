// src/routes/webhooks.routes.ts
import express, { Router, Request, Response } from "express";
import Stripe from "stripe";

import { stripe } from "../stripe/client.js";
import { env } from "../config/env.js";
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

function getStripeSubIdFromInvoice(inv: any): string | null {
  const parent = inv?.parent;

  const modern =
    parent?.type === "subscription"
      ? getId(parent)
      : getId(parent?.subscription_details?.subscription);

  return modern || getId(inv?.subscription) || null;
}


async function findLocalSubByCustomerId(customerId: string) {

  const r = await pool.query(
    `
    SELECT s.*
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
    WHERE u.stripe_customer_id = $1
    ORDER BY s.created_at DESC
    LIMIT 1
    `,
    [customerId]
  );

  return r.rows?.[0] ?? null;
}

async function upsertWebhookEventStart(eventId: string) {
  const r = await pool.query(
    `INSERT INTO webhook_events(stripe_event_id, processed_at, last_error)
     VALUES ($1, NULL, NULL)
     ON CONFLICT (stripe_event_id)
     DO UPDATE SET stripe_event_id = EXCLUDED.stripe_event_id
     RETURNING processed_at`,
    [eventId]
  );
  return r.rows?.[0]?.processed_at as string | null | undefined;
}

async function markWebhookProcessed(eventId: string) {
  await pool.query(
    `UPDATE webhook_events
     SET processed_at = now(), last_error = NULL
     WHERE stripe_event_id = $1`,
    [eventId]
  );
}

async function markWebhookFailed(eventId: string, msg: string) {
  await pool.query(
    `UPDATE webhook_events
     SET last_error = $1
     WHERE stripe_event_id = $2`,
    [msg, eventId]
  );
}


async function syncLocalSubByStripeSubId(
  stripeSubId: string,
  reason: string,
  eventId: string
) {
  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: [
      "latest_invoice",
      "latest_invoice.payment_intent",
      "latest_invoice.payment_intent.latest_charge",
      "latest_invoice.charge",
    ],
  });

  const status = mapStripeSubStatus((stripeSub as any).status);

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

  const up = await pool.query(
    `UPDATE subscriptions
     SET status = $1,
         current_period_end = to_timestamp($2),
         stripe_invoice_id = COALESCE($3, stripe_invoice_id),
         stripe_payment_intent_id = COALESCE($4, stripe_payment_intent_id),
         stripe_charge_id = COALESCE($5, stripe_charge_id),
         updated_at = now()
     WHERE stripe_subscription_id = $6`,
    [status, periodEnd, stripeInvoiceId, paymentIntentId, chargeId, stripeSubId]
  );

  console.log("✅ syncLocalSubByStripeSubId", {
    reason,
    eventId,
    stripeSubId,
    status,
    periodEnd,
    stripeInvoiceId,
    paymentIntentId,
    chargeId,
    rowCount: up.rowCount,
  });
}

async function syncFromInvoice(
  invoiceId: string,
  reason: string,
  eventId: string
) {
  const inv = await stripe.invoices.retrieve(invoiceId, {
    expand: [
      "subscription", // legacy
      "parent",
      "parent.subscription_details",
      "payment_intent",
      "payment_intent.latest_charge",
      "charge",
      "customer",
    ],
  });

  const stripeSubId = getStripeSubIdFromInvoice(inv as any);

  if (!stripeSubId) {
    console.log("ℹ️ invoice has no subscription (parent/subscription missing)", {
      eventId,
      reason,
      invoiceId,
      object: (inv as any).object,
      billing_reason: (inv as any).billing_reason,
      status: (inv as any).status,
      paid: (inv as any).paid,
      amount_paid: (inv as any).amount_paid,
      parentType: (inv as any)?.parent?.type,
    });
    return;
  }

  const stripeInvoiceId = inv.id;
  const paymentIntentId = getId((inv as any).payment_intent);

  let chargeId = getId((inv as any).charge);
  if (!chargeId && (inv as any).payment_intent) {
    chargeId = getId((inv as any).payment_intent?.latest_charge);
  }

  if (paymentIntentId && !chargeId) {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge"],
    });
    chargeId = getId((pi as any).latest_charge);
  }

  console.log("✅ syncFromInvoice handles", {
    reason,
    eventId,
    stripeSubId,
    stripeInvoiceId,
    paymentIntentId,
    chargeId,
    invoiceStatus: (inv as any).status ?? null,
    amountPaid: (inv as any).amount_paid ?? null,
  });

  await pool.query(
    `UPDATE subscriptions
     SET stripe_invoice_id = COALESCE($1, stripe_invoice_id),
         stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
         stripe_charge_id = COALESCE($3, stripe_charge_id),
         updated_at = now()
     WHERE stripe_subscription_id = $4`,
    [stripeInvoiceId, paymentIntentId, chargeId, stripeSubId]
  );

  await syncLocalSubByStripeSubId(stripeSubId, reason, eventId);
}

async function syncFromPaymentIntent(
  paymentIntentId: string,
  reason: string,
  eventId: string
) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: [
      "invoice",
      "invoice.subscription",
      "invoice.parent",
      "invoice.parent.subscription_details",
      "latest_charge",
      "customer",
    ],
  });

  const invoice: any = (pi as any).invoice;
  const invoiceId = getId(invoice);
  const chargeId = getId((pi as any).latest_charge);
  const customerId = getId((pi as any).customer);

  const stripeSubId = invoice ? getStripeSubIdFromInvoice(invoice) : null;

  console.log("✅ syncFromPaymentIntent bridge", {
    reason,
    eventId,
    paymentIntentId,
    invoiceId,
    stripeSubId,
    chargeId,
    customerId,
  });

  if (invoiceId && stripeSubId) {
    await pool.query(
      `UPDATE subscriptions
       SET stripe_invoice_id = COALESCE($1, stripe_invoice_id),
           stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
           stripe_charge_id = COALESCE($3, stripe_charge_id),
           updated_at = now()
       WHERE stripe_subscription_id = $4`,
      [invoiceId, paymentIntentId, chargeId, stripeSubId]
    );

    await syncFromInvoice(invoiceId, `${reason}(pi->invoice)`, eventId);
    return;
  }

  if (!stripeSubId && customerId) {
    const localSub = await findLocalSubByCustomerId(customerId);
    if (localSub?.stripe_subscription_id) {
      await pool.query(
        `UPDATE subscriptions
         SET stripe_payment_intent_id = COALESCE($1, stripe_payment_intent_id),
             stripe_charge_id = COALESCE($2, stripe_charge_id),
             updated_at = now()
         WHERE id = $3`,
        [paymentIntentId, chargeId, localSub.id]
      );

      await syncLocalSubByStripeSubId(
        localSub.stripe_subscription_id,
        `${reason}(pi->customer->localSub)`,
        eventId
      );
    }
  }
}

router.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string") {
      return res.status(400).json({ error: "Missing Stripe-Signature" });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        sig,
        env.stripeWebhookSecret
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return res.status(400).send(`Bad signature: ${msg}`);
    }

    console.log("✅ Webhook received:", event.type, event.id);

    try {
      const processedAt = await upsertWebhookEventStart(event.id);
      if (processedAt) return res.json({ received: true, deduped: true });

      const eventType = event.type as string;

      switch (eventType) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;

          const stripeSubId = getId((session as any).subscription);
          const localSubId = Number((session as any).metadata?.subscriptionId || 0);

          if (!stripeSubId || !localSubId) break;

          await pool.query(
            `UPDATE subscriptions
             SET stripe_subscription_id=$1,
                 stripe_checkout_session_id=$2,
                 updated_at=now()
             WHERE id=$3`,
            [stripeSubId, session.id, localSubId]
          );

          await syncLocalSubByStripeSubId(
            stripeSubId,
            "checkout.session.completed",
            event.id
          );
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const stripeSub = event.data.object as Stripe.Subscription;
          await syncLocalSubByStripeSubId(stripeSub.id, eventType, event.id);
          break;
        }

        case "invoice.paid":
        case "invoice.payment_succeeded": {
          const inv = event.data.object as Stripe.Invoice;
          await syncFromInvoice(inv.id, eventType, event.id);
          break;
        }

        case "charge.succeeded": {
          const ch = event.data.object as Stripe.Charge;
          const invoiceId = getId((ch as any).invoice);
          const paymentIntentId = getId((ch as any).payment_intent);
          const customerId = getId((ch as any).customer);

          if (invoiceId) {
            await syncFromInvoice(invoiceId, "charge.succeeded(invoice->sub)", event.id);
            break;
          }

          if (paymentIntentId) {
            console.log("ℹ️ charge.succeeded has no invoice id — bridging via PI", {
              eventId: event.id,
              paymentIntentId,
              chargeId: ch.id,
            });
            await syncFromPaymentIntent(paymentIntentId, "charge.succeeded(pi-bridge)", event.id);
            break;
          }

          if (customerId) {
            console.log("ℹ️ charge.succeeded has no invoice+PI — falling back to customer", {
              eventId: event.id,
              customerId,
              chargeId: ch.id,
            });

            const localSub = await findLocalSubByCustomerId(customerId);
            if (localSub?.id) {
              await pool.query(
                `UPDATE subscriptions
                 SET stripe_charge_id = COALESCE($1, stripe_charge_id),
                     updated_at = now()
                 WHERE id = $2`,
                [ch.id, localSub.id]
              );
            }
          }

          break;
        }
        
        case "payment_intent.succeeded": {
          const pi = event.data.object as Stripe.PaymentIntent;
          await syncFromPaymentIntent(pi.id, "payment_intent.succeeded", event.id);
          break;
        }

        case "invoice_payment.paid":
        case "invoice_payment.succeeded": {
          const obj: any = event.data.object;
          const invId = getId(obj?.invoice) || getId(obj?.id); 
          if (invId) {
            await syncFromInvoice(invId, eventType, event.id);
          }
          break;
        }

        default:
          break;
      }
      

      await markWebhookProcessed(event.id);
      return res.json({ received: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("❌ Webhook handler failed:", msg);
      try {
        await markWebhookFailed(event.id, msg);
      } catch {}
      return res.status(500).send(`Webhook handler failed: ${msg}`);
    }
  }
);

export default router;
