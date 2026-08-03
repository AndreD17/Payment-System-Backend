import nodemailer from "nodemailer";
import sgMail from "@sendgrid/mail";
import { env } from "../config/env.js";

const sendgridApiKey = env.sendgridApiKey;
const mailProvider = env.mailProvider;

if (sendgridApiKey) {
  sgMail.setApiKey(sendgridApiKey);
}

const smtpTransporter = nodemailer.createTransport({
  host: env.smtpHost || "smtp.gmail.com",
  port: env.smtpPort,
  secure: env.smtpSecure,
  auth: env.smtpUser && env.smtpPass ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
});

type EmailPayload = {
  to: string;
  subject: string;
  html: string;
};

function shouldUseSendGrid() {
  if (mailProvider === "sendgrid") return Boolean(sendgridApiKey);
  if (mailProvider === "smtp") return false;
  return Boolean(sendgridApiKey);
}

export async function sendEmail({ to, subject, html }: EmailPayload) {
  try {
    if (shouldUseSendGrid()) {
      if (!sendgridApiKey) {
        throw new Error("SendGrid API key is missing");
      }
      await sgMail.send({
        to,
        from: env.emailFrom,
        subject,
        html,
      });
      console.info("Email sent via SendGrid to", to);
      return;
    }

    if (!env.smtpHost || !env.smtpUser || !env.smtpPass) {
      throw new Error("SMTP provider is not configured");
    }

    await smtpTransporter.sendMail({
      from: env.emailFrom,
      to,
      subject,
      html,
    });
    console.info("Email sent via SMTP to", to);
  } catch (err) {
    console.error("Email error:", err);
    throw new Error("Email sending failed");
  }
}
