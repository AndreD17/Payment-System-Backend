import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { stripe } from "../stripe/client.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { requireSubscriptionOwnerOrAdmin } from "../middleware/ownership.js";
const router = Router();

const createSchema = z.object({
  body: z.object({
    userEmail: z.string().email(),
    planId: z.coerce.number().int(),
  }),
});

router.post("/checkout", async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse({ body: req.body });
    if (!parsed.success) {
      return next({
        status: 400,
        message: "Validation error",
        details: parsed.error.flatten(),
      });
    }

    const { userEmail, planId } = parsed.data.body;

    // find/create user
    const uRes = await pool.query(
      `INSERT INTO users(email) VALUES($1)
       ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email
       RETURNING id,email,stripe_customer_id`,
      [userEmail]
    );
    const user = uRes.rows[0];

    const pRes = await pool.query("SELECT * FROM plans WHERE id=$1 AND active=true", [planId]);
    const plan = pRes.rows[0];
    if (!plan) return next({ status: 404, message: "Plan not found" });

    let customerId = user.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await pool.query("UPDATE users SET stripe_customer_id=$1 WHERE id=$2", [customerId, user.id]);
    }

    const sRes = await pool.query(
      `INSERT INTO subscriptions(user_id, plan_id, status)
       VALUES($1,$2,'INCOMPLETE')
       RETURNING id`,
      [user.id, plan.id]
    );
    const subId = sRes.rows[0].id as number;
    
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],

      success_url: `${env.appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}&sub_id=${subId}`,
      cancel_url: `${env.appUrl}/billing/cancel?sub_id=${subId}`,

      client_reference_id: String(subId),

      metadata: {
        userId: String(user.id),
        subscriptionId: String(subId),
      },

      subscription_data: {
        metadata: {
          localSubscriptionId: String(subId),
          localUserId: String(user.id),
          localPlanId: String(plan.id),
        },
      },
    });


    await pool.query(
      "UPDATE subscriptions SET stripe_checkout_session_id=$1 WHERE id=$2",
      [session.id, subId]
    );

    res.status(201).json({ subscriptionId: subId, checkoutUrl: session.url });
  } catch (e) {
    next(e);
  }
});

router.get("/receipt/:sessionId", requireAuth, async (req, res, next) => {
  try {
    const sessionId = req.params.sessionId;
    if (!sessionId) return next({ status: 400, message: "Missing session id" });

    const r = await pool.query(
      `SELECT * FROM subscriptions WHERE stripe_checkout_session_id = $1`,
      [sessionId]
    );

    const sub = r.rows[0];
    if (!sub) return next({ status: 404, message: "Subscription not found yet" });

    if (req.auth?.role !== "admin" && Number(sub.user_id) !== req.auth?.userId) {
      return next({ status: 403, message: "Forbidden" });
    }

    return res.json({
      subscriptionId: sub.id,
      stripeSubscriptionId: sub.stripe_subscription_id,
      stripeInvoiceId: sub.stripe_invoice_id,
      paymentIntentId: sub.stripe_payment_intent_id,
      chargeId: sub.stripe_charge_id,
      currentPeriodEnd: sub.current_period_end,
      status: sub.status,
    });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireAuth, requireSubscriptionOwnerOrAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query("SELECT * FROM subscriptions WHERE id=$1", [id]);
    if (!r.rows[0]) return next({ status: 404, message: "Not found" });
    res.json({ subscription: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query("SELECT * FROM subscriptions WHERE id=$1", [id]);
    if (!r.rows[0]) return next({ status: 404, message: "Not found" });
    res.json({ subscription: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

export default router;
