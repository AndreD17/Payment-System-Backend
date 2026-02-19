// src/app.ts
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
import Refund from "./routes/subscriptionRefundHandle.routes.js"
import checkoutReceipt from "./routes/checkoutReceipt.routes.js";
import admin from "./routes/admin.routes.js";
import plans from "./routes/plans.routes.js";

export function createApp(): Express {
  const app = express();

  // ✅ Webhooks FIRST (raw body)
  app.use("/api/webhooks", webhooks);

  app.use(pinoHttp());
  app.use(helmet());

  const allowedOrigins = [env.appUrl, "http://localhost:5173"].filter(Boolean);

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked origin: ${origin}`));
      },
      credentials: true,
    })
  );

  app.use(cookieParser());

  // ✅ JSON parser AFTER webhooks
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req: Request, res: Response) =>
    res.json({ ok: true, message: "Server is healthy up and running.." })
  );
  app.get("/", (_req: Request, res: Response) =>
    res.json({ ok: true, message: "Backend Server is Running..." })
  );

  app.use("/api/subscriptions", subs);
  app.use("/api/subscriptions", subscriptionSync);
  app.use("/api/subscriptions", subPI);
  app.use("/api/subscriptions", checkoutReceipt);
  app.use("/api/subscriptions", Refund);
  app.use("/api/plans", plans);
  app.use("/api/admin", admin);

  app.use(errorHandler);
  return app;
}
