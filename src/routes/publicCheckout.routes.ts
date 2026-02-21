import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { stripe } from "../stripe/client.js";
import { env } from "../config/env.js";

const router = Router();

router.post("/checkout", async (req, res, next) => {
  try {
    const schema = z.object({
      planId: z.coerce.number().int(),
      email: z.string().email(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Validation error", details: parsed.error.flatten() });
    }

    const { planId, email } = parsed.data;

    const p = await pool.query(
      `SELECT id, stripe_price_id, currency, amount_cents
       FROM plans
       WHERE id=$1 AND active=true
       LIMIT 1`,
      [planId]
    );
    const plan = p.rows[0];
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    // create/find user
    const u = await pool.query(`SELECT id, stripe_customer_id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`, [email]);
    let user = u.rows[0];

    if (!user) {
      const created = await pool.query(`INSERT INTO users (email, role) VALUES ($1, 'user') RETURNING id, stripe_customer_id`, [email]);
      user = created.rows[0];
    }

    // create/find stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
      await pool.query(`UPDATE users SET stripe_customer_id=$1 WHERE id=$2`, [customerId, user.id]);
    }

    // create checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: `${env.appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.appUrl}/cancel`,
      allow_promotion_codes: true,
    });

    // optional: persist a local subscription record linked to session.id (recommended)
    await pool.query(
      `INSERT INTO subscriptions (user_id, stripe_checkout_session_id, status, created_at, updated_at)
       VALUES ($1, $2, 'PENDING', now(), now())`,
      [user.id, session.id]
    );

    return res.json({ url: session.url, sessionId: session.id });
  } catch (e) {
    next(e);
  }
});

export default router;