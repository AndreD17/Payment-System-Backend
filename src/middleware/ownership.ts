import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool.js";

export async function requireSubscriptionOwnerOrAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const auth = req.auth;
    if (!auth) return next({ status: 401, message: "Not authenticated" });

    if (auth.role === "admin") return next();

    const subId = Number(req.params.id);
    if (!Number.isFinite(subId)) return next({ status: 400, message: "Invalid subscription id" });

    const r = await pool.query(`SELECT user_id FROM subscriptions WHERE id = $1`, [subId]);
    const row = r.rows[0];
    if (!row) return next({ status: 404, message: "Subscription not found" });

    if (Number(row.user_id) !== auth.userId) return next({ status: 403, message: "Forbidden" });

    next();
  } catch (e) {
    next(e);
  }
}