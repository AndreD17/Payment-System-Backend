// src/routes/admin.routes.ts
import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middleware/admin.js";
import { stripe } from "../stripe/client.js";

const router = Router();

const refundSchema = z.object({
  body: z
    .object({
      paymentIntentId: z.string().min(5).optional(),
      chargeId: z.string().min(5).optional(),
      amount: z.number().int().positive().optional(),
    })
    .refine((v) => v.paymentIntentId || v.chargeId, {
      message: "Provide paymentIntentId or chargeId",
    }),
});

router.post("/refund", requireAdmin, async (req, res, next) => {
  try {
    const parsed = refundSchema.safeParse({ body: req.body });
    if (!parsed.success) {
      return next({ status: 400, message: "Validation error", details: parsed.error.flatten() });
    }

    const { paymentIntentId, chargeId, amount } = parsed.data.body;

    const refund = await stripe.refunds.create({
      ...(paymentIntentId ? { payment_intent: paymentIntentId } : {}),
      ...(chargeId ? { charge: chargeId } : {}),
      ...(amount ? { amount } : {}),
    });

    res.json({ refund });
  } catch (e) {
    next(e);
  }
});

export default router;
