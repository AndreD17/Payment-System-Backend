import jwt from "jsonwebtoken";
import crypto from "crypto";
import { env } from "../config/env.js";

export function signAccessToken(payload: { userId: number; email: string; role: string }) {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: `${env.accessTokenTtlMin}m`,
    issuer: env.jwtIssuer,
    audience: env.jwtAudience,
  });
}

export function generateRefreshToken() {
  return crypto.randomBytes(48).toString("base64url");
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function refreshCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: env.cookieSecure || isProd,
    sameSite: "lax" as const,
    path: "/api/auth",
    ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
  };
}