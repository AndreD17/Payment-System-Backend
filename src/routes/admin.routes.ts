import { Router } from "express";
import { z } from "zod";
import { RefundService } from "../services/refund.service.js";

const router = Router();

const refundSchema = z.object({
  body: z
    .object({
      paymentIntentId: z.string().min(5).optional(),
      chargeId: z.string().min(5).optional(),
      amount: z.number().int().positive().optional(),
    })
    .refine((v) => v.paymentIntentId || v.chargeId, { message: "Provide paymentIntentId or chargeId" }),
});

router.post("/refund", async (req, res, next) => {
  try {
    const parsed = refundSchema.safeParse({ body: req.body });
    if (!parsed.success) {
      return next({ status: 400, message: "Validation error", details: parsed.error.flatten() });
    }

    const adminUserId = req.auth?.userId;
    if (!adminUserId) return next({ status: 401, message: "Not authenticated" });

    const { paymentIntentId, chargeId, amount } = parsed.data.body;

    const refund = await RefundService.createRefund({
      adminUserId,
      paymentIntentId,
      chargeId,
      amount,
      ip: req.ip,
      userAgent: req.get("user-agent") || undefined,
    });

    res.json({ refund });
  } catch (e) {
    next(e);
  }
});

export default router;