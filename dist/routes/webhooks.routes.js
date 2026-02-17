import { Router } from "express";
import express from "express";
import { stripe } from "../stripe/client.js";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { enqueueOutbox } from "../utils/outbox.js";
const router = Router();
router.post("/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!sig || typeof sig !== "string")
        return res.status(400).send("Missing Stripe-Signature");
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, env.stripeWebhookSecret);
    }
    catch (err) {
        return res.status(400).send(`Bad signature: ${err.message}`);
    }
    // dedupe
    const seen = await pool.query("SELECT 1 FROM webhook_events WHERE stripe_event_id=$1", [event.id]);
    if (seen.rowCount)
        return res.json({ received: true, deduped: true });
    await pool.query("INSERT INTO webhook_events(stripe_event_id) VALUES($1)", [event.id]);
    // handle
    switch (event.type) {
        case "checkout.session.completed": {
            const session = event.data.object;
            // For subscriptions, session.subscription exists
            const stripeSubId = session.subscription;
            const localSubId = Number(session.metadata?.subscriptionId);
            if (stripeSubId && localSubId) {
                await pool.query("UPDATE subscriptions SET stripe_subscription_id=$1 WHERE id=$2", [stripeSubId, localSubId]);
            }
            break;
        }
        // Recommended: invoice success events are the canonical “payment happened”
        // Stripe suggests handling subscription events with webhooks. :contentReference[oaicite:5]{index=5}
        case "invoice.paid": {
            const invoice = event.data.object;
            // invoice.subscription is the Stripe subscription id
            const stripeSubId = invoice.subscription;
            if (!stripeSubId)
                break;
            const sRes = await pool.query("SELECT * FROM subscriptions WHERE stripe_subscription_id=$1", [stripeSubId]);
            const sub = sRes.rows[0];
            if (!sub)
                break;
            await pool.query(`UPDATE subscriptions
           SET status='ACTIVE',
               current_period_end=to_timestamp($1),
               updated_at=now()
           WHERE id=$2`, [invoice.lines?.data?.[0]?.period?.end ?? Math.floor(Date.now() / 1000), sub.id]);
            // audit record
            await pool.query(`INSERT INTO billing_events(user_id, stripe_event_id, event_type, stripe_invoice_id, stripe_payment_intent_id, amount_paid, currency)
           VALUES($1,$2,$3,$4,$5,$6,$7)`, [sub.user_id, event.id, event.type, invoice.id, invoice.payment_intent ?? null, invoice.amount_paid ?? null, invoice.currency ?? null]);
            // enqueue email receipt + fulfillment
            await enqueueOutbox("EMAIL_RECEIPT", {
                userId: sub.user_id,
                emailType: "SUBSCRIPTION_RECEIPT",
                invoiceId: invoice.id,
                amountPaid: invoice.amount_paid,
                currency: invoice.currency
            });
            await enqueueOutbox("FULFILL_SUBSCRIPTION", {
                userId: sub.user_id,
                subscriptionId: sub.id,
                stripeSubscriptionId: stripeSubId,
                invoiceId: invoice.id
            });
            break;
        }
        case "customer.subscription.deleted": {
            const stripeSubId = event.data.object.id;
            await pool.query("UPDATE subscriptions SET status='CANCELED', updated_at=now() WHERE stripe_subscription_id=$1", [stripeSubId]);
            break;
        }
        default:
            break;
    }
    res.json({ received: true });
});
export default router;
