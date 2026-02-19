import { Router } from "express";
import { pool } from "../db/pool.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, name, stripe_price_id, interval, amount_cents, currency
       FROM plans
       WHERE active = true
       ORDER BY amount_cents ASC`
    );

    res.json({ plans: r.rows });
  } catch (e) {
    next(e);
  }
});

export default router;
