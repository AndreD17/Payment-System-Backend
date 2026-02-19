import dotenv from "dotenv";

dotenv.config();

const must = (key: string): string => {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(`Missing env: ${key}`);
  }
  return value;
};


const num = (key: string, fallback?: number): number => {
  const raw = process.env[key];
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing numeric env: ${key}`);
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for env: ${key}`);
  }

  return parsed;
};

export const env = {
  port: num("PORT", 5000),

  dbUrl: must("DATABASE_URL"),

  /** Stripe */
  stripeSecretKey: must("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: must("STRIPE_WEBHOOK_SECRET"),

  /** Frontend URL */
  appUrl: process.env.APP_URL || "http://localhost:5173",

  /** Admin */
  adminApiKey: must("ADMIN_API_KEY"),

  /** Email */
  smtpHost: must("SMTP_HOST"),
  smtpPort: num("SMTP_PORT"),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  emailFrom: must("EMAIL_FROM"),
};
