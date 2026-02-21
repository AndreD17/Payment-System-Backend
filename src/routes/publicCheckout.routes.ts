import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { stripe } from "../stripe/client.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/checkout", requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      planId: z.coerce.number().int(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Validation error", details: parsed.error.flatten() });
    }

    const { planId } = parsed.data;

    const email = req.auth!.email;

    const p = await pool.query(
      `SELECT id, stripe_price_id, currency, amount_cents
       FROM plans
       WHERE id=$1 AND active=true
       LIMIT 1`,
      [planId]
    );

    const plan = p.rows[0];
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    // find user by id from token
    const u = await pool.query(`SELECT id, email, stripe_customer_id FROM users WHERE id=$1 LIMIT 1`, [req.auth!.userId]);
    let user = u.rows[0];

    // If user exists in token but not in DB (rare), fallback create:
    if (!user) {
      const created = await pool.query(
        `INSERT INTO users (id, email, role)
         VALUES ($1, $2, 'user')
         ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email
         RETURNING id, email, stripe_customer_id`,
        [req.auth!.userId, email]
      );
      user = created.rows[0];
    }

    let customerId = user.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
      await pool.query(`UPDATE users SET stripe_customer_id=$1 WHERE id=$2`, [customerId, user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: `${env.appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.appUrl}/cancel`,
      allow_promotion_codes: true,
    });

  
    await pool.query(
      `INSERT INTO subscriptions (user_id, stripe_checkout_session_id, status, created_at, updated_at)
       VALUES ($1, $2, 'PENDING', now(), now())`,
      [user.id, session.id]
    );

    return res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (e) {
    next(e);
  }
});

export default router;