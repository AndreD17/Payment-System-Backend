import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/error.js";
import webhooks from "./routes/webhooks.routes.js";
import subs from "./routes/subscriptions.routes.js";
import admin from "./routes/admin.routes.js";
export function createApp() {
    const app = express();
    // Webhooks MUST be raw before json parsing
    app.use("/api/webhooks", webhooks);
    app.use(pinoHttp());
    app.use(helmet());
    app.use(cors({ origin: env.appUrl, credentials: true }));
    app.use(cookieParser());
    app.use(express.json({ limit: "1mb" }));
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.use("/api/subscriptions", subs);
    app.use("/api/admin", admin);
    app.use(errorHandler);
    return app;
}
