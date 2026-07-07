import nodemailer from "nodemailer";
import sgMail from "@sendgrid/mail";
import { env } from "../config/env.js";

// Initialize SendGrid only if API key is available
const sendgridApiKey = (env as any).sendgridApiKey;
if (sendgridApiKey) {
  sgMail.setApiKey(sendgridApiKey);
}

// fallback transporter (dev)
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  auth: {
    user: env.smtpUser,
    pass: env.smtpPass,
  },
});

type EmailPayload = {
  to: string;
  subject: string;
  html: string;
};

export async function sendEmail({ to, subject, html }: EmailPayload) {
  try {
    // PRIMARY: SendGrid (production)
    if (sendgridApiKey) {
      await sgMail.send({
        to,
        from: env.emailFrom,
        subject,
        html,
      });
      return;
    }

    // FALLBACK: Nodemailer
    await transporter.sendMail({
      from: env.emailFrom,
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error("Email error:", err);
    throw new Error("Email sending failed");
  }
}