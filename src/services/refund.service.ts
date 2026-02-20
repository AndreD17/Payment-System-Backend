import { stripe } from "../stripe/client.js";
import { pool } from "../db/pool.js";

export class RefundService {
  static async createRefund(params: {
    adminUserId: number;
    paymentIntentId?: string;
    chargeId?: string;
    amount?: number;
    ip?: string;
    userAgent?: string;
  }) {
    const { adminUserId, paymentIntentId, chargeId, amount, ip, userAgent } = params;

    const refund = await stripe.refunds.create({
      ...(paymentIntentId ? { payment_intent: paymentIntentId } : {}),
      ...(chargeId ? { charge: chargeId } : {}),
      ...(amount ? { amount } : {}),
    });

    await pool.query(
      `INSERT INTO admin_audit_logs
       (admin_user_id, action, target_type, target_id, metadata, ip, user_agent)
       VALUES ($1, 'REFUND_CREATED', $2, $3, $4, $5, $6)`,
      [
        adminUserId,
        paymentIntentId ? "payment_intent" : "charge",
        paymentIntentId || chargeId || null,
        JSON.stringify({ amount: amount ?? null, refundId: refund.id }),
        ip || null,
        userAgent || null,
      ]
    );

    return refund;
  }
}