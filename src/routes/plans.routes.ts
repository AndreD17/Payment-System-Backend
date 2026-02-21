import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { z } from "zod";

const router = Router();

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(2),
      stripePriceId: z.string().min(5),
      interval: z.enum(["month", "year"]),
      amountCents: z.coerce.number().int().positive(),
      currency: z.string().min(3).max(3),
      active: z.boolean().optional().default(true),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return next({ status: 400, message: "Validation error", details: parsed.error.flatten() });

    const b = parsed.data;

    const r = await pool.query(
      `INSERT INTO plans (name, stripe_price_id, interval, amount_cents, currency, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, stripe_price_id, interval, amount_cents, currency, active`,
      [b.name, b.stripePriceId, b.interval, b.amountCents, b.currency.toLowerCase(), b.active]
    );

    res.status(201).json({ plan: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

export default router;
