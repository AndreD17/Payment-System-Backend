import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middleware/admin.js";
import { stripe } from "../stripe/client.js";
const router = Router();
const refundSchema = z.object({
    body: z.object({
        paymentIntentId: z.string().min(5),
        amount: z.number().int().positive().optional() // cents; omit for full refund
    })
});
router.post("/refund", requireAdmin, async (req, res, next) => {
    try {
        const parsed = refundSchema.safeParse({ body: req.body });
        if (!parsed.success)
            return next({ status: 400, message: "Validation error", details: parsed.error.flatten() });
        const { paymentIntentId, amount } = req.body;
        const refund = await stripe.refunds.create({
            payment_intent: paymentIntentId,
            ...(amount ? { amount } : {})
        });
        res.json({ refund });
    }
    catch (e) {
        next(e);
    }
});
export default router;
