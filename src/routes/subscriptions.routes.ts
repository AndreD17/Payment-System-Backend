import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { stripe } from "../stripe/client.js";
import { env } from "../config/env.js";

const router = Router();

const createSchema = z.object({
  body: z.object({
    userEmail: z.string().email(),
    planId: z.number().int()
  })
});

router.post("/checkout", async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse({ body: req.body });
    if (!parsed.success) return next({ status: 400, message: "Validation error", details: parsed.error.flatten() });

    const { userEmail, planId } = req.body;

    // find/create user
    const uRes = await pool.query(
      `INSERT INTO users(email) VALUES($1)
       ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email
       RETURNING id,email,stripe_customer_id`,
      [userEmail]
    );
    const user = uRes.rows[0];

    // plan -> Stripe price id
    const pRes = await pool.query("SELECT * FROM plans WHERE id=$1 AND active=true", [planId]);
    const plan = pRes.rows[0];
    if (!plan) return next({ status: 404, message: "Plan not found" });

    // ensure Stripe customer
    let customerId = user.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await pool.query("UPDATE users SET stripe_customer_id=$1 WHERE id=$2", [customerId, user.id]);
    }

    // create a local subscription record (incomplete until webhook confirms)
    const sRes = await pool.query(
      `INSERT INTO subscriptions(user_id, plan_id, status)
       VALUES($1,$2,'INCOMPLETE')
       RETURNING id`,
      [user.id, plan.id]
    );
    const subId = sRes.rows[0].id as number;

    // Stripe Checkout Session in subscription mode
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: `${env.appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.appUrl}/billing/cancel?sub_id=${subId}`,
      metadata: {
        userId: String(user.id),
        subscriptionId: String(subId)
      }
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
