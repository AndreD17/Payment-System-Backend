import nodemailer from "nodemailer";
import { env } from "../config/env.js";

export const mailer = nodemailer.createTransport({
  host: env.smtpHost,
  port: env.smtpPort,
  secure: env.smtpSecure, 
  auth: {
    user: env.smtpUser,
    pass: env.smtpPass,
  },
});
