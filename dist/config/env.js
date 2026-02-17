import dotenv from "dotenv";
dotenv.config();
const must = (k) => {
    const v = process.env[k];
    if (!v)
        throw new Error(`Missing env: ${k}`);
    return v;
};
export const env = {
    port: Number(process.env.PORT ?? 5000),
    dbUrl: must("DATABASE_URL"),
    stripeSecretKey: must("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: must("STRIPE_WEBHOOK_SECRET"),
    appUrl: process.env.APP_URL ?? "http://localhost:3000",
    adminApiKey: must("ADMIN_API_KEY"),
    smtpHost: must("SMTP_HOST"),
    smtpPort: Number(must("SMTP_PORT")),
    smtpUser: process.env.SMTP_USER ?? "",
    smtpPass: process.env.SMTP_PASS ?? "",
    emailFrom: must("EMAIL_FROM")
};
