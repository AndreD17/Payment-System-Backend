import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendEmail } from "../utils/mailer.js";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  refreshCookieOptions,
} from "../auth/tokens.js";

const router = Router();
const REFRESH_COOKIE = "refresh_token";

function refreshExpiryDate() {
  return new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
}

async function createRefreshSession(params: { userId: number; refreshRaw: string; req: any }) {
  const refreshHash = hashToken(params.refreshRaw);
  await pool.query(
    `INSERT INTO refresh_sessions (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.userId,
      refreshHash,
      refreshExpiryDate(),
      params.req.get("user-agent") || null,
      params.req.ip,
    ]
  );
}

function apiError(
  status: number,
  message: string,
  alert?: { type: "error" | "info" | "success"; title: string; message: string; field?: string }
) {
  return { status, message, alert };
}

// -------------------- SIGNUP --------------------
const signupSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters.")
    .max(20, "Username must be at most 20 characters.")
    .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscore.")
    .refine((v) => !/^\d+$/.test(v), "Username cannot be only numbers.")
    .transform((v) => v.toLowerCase()),
});

router.post("/signup", async (req, res, next) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Validation error",
        details: parsed.error.flatten(),
        alert: {
          type: "error",
          title: "Fix the form",
          message: "Please correct the highlighted fields and try again.",
        },
      });
    }

    const { email, password, username } = parsed.data;

    // Check email exists
    const emailExists = await pool.query(
      `SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [email]
    );

    if (emailExists.rows[0]) {
      return res.status(409).json({
        message: "User already exists",
        alert: {
          type: "error",
          title: "Email already registered",
          message: "This email is already registered. Please login instead.",
          field: "email",
        },
      });
    }

    // Check username exists (case-insensitive by storing lowercase + lower(username))
    const usernameExists = await pool.query(
      `SELECT id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`,
      [username]
    );

    if (usernameExists.rows[0]) {
      return res.status(409).json({
        message: "Username already taken",
        alert: {
          type: "error",
          title: "Username unavailable",
          message: "That username is taken. Try another one.",
          field: "username",
        },
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const r = await pool.query(
      `INSERT INTO users (email, username, role, password_hash)
       VALUES ($1, $2, 'user', $3)
       RETURNING id, email, username, role`,
      [email, username, passwordHash]
    );

    const user = r.rows[0] as { id: number; email: string; username: string; role: string };

    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshRaw = generateRefreshToken();
    await createRefreshSession({ userId: user.id, refreshRaw, req });
    res.cookie(REFRESH_COOKIE, refreshRaw, refreshCookieOptions());

    return res.status(201).json({
      user,
      accessToken,
      alert: {
        type: "success",
        title: "Account created",
        message: "Welcome! Your account has been created successfully.",
      },
    });
  } catch (e: any) {
    // If DB unique index triggers (race condition), catch and return friendly errors
    if (e?.code === "23505") {
      const detail = String(e?.detail || "");
      if (detail.toLowerCase().includes("users_email_lower_unique")) {
        return res.status(409).json({
          message: "User already exists",
          alert: {
            type: "error",
            title: "Email already registered",
            message: "This email is already registered. Please login instead.",
            field: "email",
          },
        });
      }
      if (detail.toLowerCase().includes("users_username_lower_unique")) {
        return res.status(409).json({
          message: "Username already taken",
          alert: {
            type: "error",
            title: "Username unavailable",
            message: "That username is taken. Try another one.",
            field: "username",
          },
        });
      }
    }

    next(e);
  }
});

// -------------------- LOGIN --------------------
const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Validation error",
        details: parsed.error.flatten(),
        alert: { type: "error", title: "Fix the form", message: "Enter email and password." },
      });
    }

    const { email, password } = parsed.data;

    const r = await pool.query(
      `SELECT id, email, username, role, password_hash
       FROM users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email]
    );

    const user = r.rows[0];

    const ok =
      user?.password_hash ? await bcrypt.compare(password, user.password_hash) : false;

    if (!ok) {
      return res.status(401).json({
        message: "Invalid credentials",
        alert: {
          type: "error",
          title: "Login failed",
          message: "The email or password you entered is incorrect.",
        },
      });
    }

    const accessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });

    const refreshRaw = generateRefreshToken();
    await createRefreshSession({ userId: user.id, refreshRaw, req });
    res.cookie(REFRESH_COOKIE, refreshRaw, refreshCookieOptions());

    return res.json({
      user: { id: user.id, email: user.email, username: user.username, role: user.role },
      accessToken,
      alert: { type: "success", title: "Welcome back", message: "Logged in successfully." },
    });
  } catch (e) {
    next(e);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const refreshRaw = req.cookies?.[REFRESH_COOKIE];
    if (refreshRaw) {
      const h = hashToken(String(refreshRaw));
      await pool.query(`UPDATE refresh_sessions SET revoked_at=now() WHERE token_hash=$1`, [h]);
    }
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    return res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.get("/me", requireAuth, async (req, res) => {
  return res.json({ user: req.auth });
});

const forgotSchema = z.object({
  email: z.string().trim().email(),
});



const resetSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8),
});

router.post("/reset-password", async (req, res, next) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input" });
    }

    const { token, password } = parsed.data;

    const hashedToken = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const userRes = await pool.query(
      `SELECT id
       FROM users
       WHERE reset_password_token=$1
       AND reset_password_expires > NOW()
       LIMIT 1`,
      [hashedToken]
    );

    const user = userRes.rows[0];

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await pool.query(
      `UPDATE users
       SET password_hash=$1,
           reset_password_token=NULL,
           reset_password_expires=NULL
       WHERE id=$2`,
      [passwordHash, user.id]
    );

    return res.json({ message: "Password reset successful" });
  } catch (err) {
    next(err);
  }
});

export default router;