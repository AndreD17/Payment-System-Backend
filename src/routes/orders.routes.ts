import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { pool } from "../db/pool.js";
import { stripe } from "../stripe/client.js";
import { env } from "../config/env.js";

const router = Router();

/**
 * In a real app you would use authentication.
 * For portfolio simplicity, we accept userEmail and create/find user.
 */
const createOrderSchema = z.object({
  body: z.object({
    userEmail: z.string().email(),
    items: z.array(
      z.object({
        name: z.string().min(2),
        unitAmount: z.number().int().min(50), // cents, min 0.50 for demo
        quantity: z.number().int().min(1).max(99),
      })
    ).min(1),
    currency: z.string().default("usd"),
  }),
});

router.post("/", validate(createOrderSchema), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { userEmail, items, currency } = req.body;

    // 1) Upsert user
    const userRes = await client.query(
      `INSERT INTO users(email) VALUES($1)
       ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email
       RETURNING id,email`,
      [userEmail]
    );
    const user = userRes.rows[0];

    // 2) Create order + items in a transaction
    await client.query("BEGIN");

    const amountTotal = items.reduce((sum: number, it: any) => sum + it.unitAmount * it.quantity, 0);

    const orderRes = await client.query(
      `INSERT INTO orders(user_id,status,currency,amount_total)
       VALUES($1,'REQUIRES_PAYMENT',$2,$3)
       RETURNING id,status,currency,amount_total`,
      [user.id, currency, amountTotal]
    );
    const order = orderRes.rows[0];

    for (const it of items) {
      await client.query(
        `INSERT INTO order_items(order_id,name,unit_amount,quantity)
         VALUES($1,$2,$3,$4)`,
        [order.id, it.name, it.unitAmount, it.quantity]
      );
    }

    await client.query("COMMIT");

    // 3) Create Stripe Checkout Session (server-side)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: items.map((it: any) => ({
        quantity: it.quantity,
        price_data: {
          currency,
          unit_amount: it.unitAmount,
          product_data: { name: it.name },
        },
      })),
      success_url: `${env.appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.appUrl}/cancel?order_id=${order.id}`,
      metadata: {
        orderId: String(order.id),
        userId: String(user.id),
      },
    });

    // 4) Save session id to order for reconciliation
    await pool.query(
      "UPDATE orders SET stripe_checkout_session_id=$1 WHERE id=$2",
      [session.id, order.id]
    );

    res.status(201).json({
      orderId: order.id,
      checkoutSessionId: session.id,
      checkoutUrl: session.url, // redirect user to Stripe-hosted checkout
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    next(e);
  } finally {
    client.release();
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const orderRes = await pool.query("SELECT * FROM orders WHERE id=$1", [id]);
    const order = orderRes.rows[0];
    if (!order) return next({ status: 404, message: "Order not found" });

    const itemsRes = await pool.query("SELECT * FROM order_items WHERE order_id=$1", [id]);
    res.json({ order, items: itemsRes.rows });
  } catch (e) {
    next(e);
  }
});

export default router;
