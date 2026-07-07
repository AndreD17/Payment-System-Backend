import express, { Express, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";

import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error.js";

import webhooks from "./routes/webhooks.routes.js";
import subs from "./routes/subscriptions.routes.js";
import subscriptionSync from "./routes/subscriptionSync.routes.js";
import subPI from "./routes/subscriptionPaymentIntent.routes.js";
import Refund from "./routes/subscriptionRefundHandle.routes.js";
import checkoutReceipt from "./routes/checkoutReceipt.routes.js";
import auth from "./routes/auth.routes.js";
import { requireAuth, requireRole } from "./middleware/auth.js";
import publicCheckout from "./routes/publicCheckout.routes.js";
import admin from "./routes/admin.routes.js";
import plans from "./routes/plans.routes.js";

export function createApp(): Express {
  const app = express();

  // ✅ Stripe webhooks (must come BEFORE express.json)
  app.use(
    "/api/webhooks",
    express.raw({ type: "application/json" }),
    webhooks
  );

  app.use(pinoHttp());
  app.use(helmet());

  const allowedOrigins = [env.appUrl, "http://localhost:5173"].filter(Boolean);

  const corsOptions = {
    origin: (origin: string | undefined, cb: any) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  };

  app.use(cors(corsOptions));

  // ✅ REMOVE THIS LINE - it's causing the error
  // app.options("*", cors(corsOptions));  // DELETE THIS

  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  // ✅ health routes
  app.get("/health", (_req: Request, res: Response) =>
    res.json({ ok: true, message: "Server is healthy up and running.." })
  );

  app.get("/", (_req: Request, res: Response) =>
    res.json({ ok: true, message: "Backend Server is Running..." })
  );

  // =========================
  // ✅ PUBLIC ROUTES (NO AUTH)
  // =========================
  app.use("/api/public", publicCheckout);
  app.use("/api/public", checkoutReceipt);

  // =========================
  // AUTH & PLANS
  // =========================
  app.use("/api/plans", plans);
  app.use("/api/auth", auth);

  // =========================
  // PROTECTED ROUTES
  // =========================
  app.use("/api/subscriptions", requireAuth, subs);
  app.use("/api/subscriptions", requireAuth, subscriptionSync);
  app.use("/api/subscriptions", requireAuth, subPI);
  app.use("/api/subscriptions", requireAuth, Refund);

  // =========================
  // ADMIN ROUTES
  // =========================
  app.use("/api/admin", requireAuth, requireRole("admin"), admin);

  // error handler
  app.use(errorHandler);

  return app;
}