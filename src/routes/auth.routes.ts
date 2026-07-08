import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";

import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import { LogHelper } from "../utils/log-helper.js";
import { sendEmail } from "../utils/mailer.js";
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  refreshCookieOptions,
} from "../auth/tokens.js";

const router = Router();
const REFRESH_COOKIE = "refresh_token";

// ==================== HELPERS ====================

function refreshExpiryDate() {
  return new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
}

async function createRefreshSession(params: { 
  userId: number; 
  refreshRaw: string; 
  req: any 
}) {
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

function createAlert(
  type: "error" | "info" | "success",
  title: string,
  message: string,
  field?: string
) {
  return { type, title, message, field };
}

// ==================== VALIDATION SCHEMAS ====================

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

const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

const forgotSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
});

const resetSchema = z.object({
  token: z.string().min(10, "Invalid reset token."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

// ==================== ROUTES ====================

// ---------- SIGNUP ----------
router.post("/signup", async (req, res, next) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Validation error",
        details: parsed.error.flatten(),
        alert: createAlert(
          "error",
          "Fix the form",
          "Please correct the highlighted fields and try again."
        ),
      });
    }

    const { email, password, username } = parsed.data;

    // Check if email exists
    const emailExists = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );

    if (emailExists.rows[0]) {
      LogHelper.auth(email, "signup", false);
      return res.status(409).json({
        message: "User already exists",
        alert: createAlert(
          "error",
          "Email already registered",
          "This email is already registered. Please login instead.",
          "email"
        ),
      });
    }

    // Check if username exists
    const usernameExists = await pool.query(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
      [username]
    );

    if (usernameExists.rows[0]) {
      LogHelper.auth(username, "signup", false);
      return res.status(409).json({
        message: "Username already taken",
        alert: createAlert(
          "error",
          "Username unavailable",
          "That username is taken. Try another one.",
          "username"
        ),
      });
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (email, username, role, password_hash)
       VALUES ($1, $2, 'user', $3)
       RETURNING id, email, username, role`,
      [email, username, passwordHash]
    );

    const user = result.rows[0];

    // Generate tokens
    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshRaw = generateRefreshToken();
    await createRefreshSession({ userId: user.id, refreshRaw, req });
    res.cookie(REFRESH_COOKIE, refreshRaw, refreshCookieOptions());

    LogHelper.auth(user.id.toString(), "signup", true);

    return res.status(201).json({
      user,
      accessToken,
      alert: createAlert(
        "success",
        "Account created",
        "Welcome! Your account has been created successfully."
      ),
    });
  } catch (error: any) {
    // Handle database unique constraint violations
    if (error?.code === "23505") {
      const detail = String(error?.detail || "");
      if (detail.toLowerCase().includes("users_email_lower_unique")) {
        return res.status(409).json({
          message: "User already exists",
          alert: createAlert(
            "error",
            "Email already registered",
            "This email is already registered. Please login instead.",
            "email"
          ),
        });
      }
      if (detail.toLowerCase().includes("users_username_lower_unique")) {
        return res.status(409).json({
          message: "Username already taken",
          alert: createAlert(
            "error",
            "Username unavailable",
            "That username is taken. Try another one.",
            "username"
          ),
        });
      }
    }
    next(error);
  }
});

// ---------- LOGIN ----------
router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Validation error",
        details: parsed.error.flatten(),
        alert: createAlert("error", "Fix the form", "Enter email and password."),
      });
    }

    const { email, password } = parsed.data;

    // Find user
    const result = await pool.query(
      `SELECT id, email, username, role, password_hash
       FROM users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email]
    );

    const user = result.rows[0];

    // Validate password
    const isValidPassword = user?.password_hash 
      ? await bcrypt.compare(password, user.password_hash) 
      : false;

    if (!user || !isValidPassword) {
      LogHelper.auth(email, "login", false);
      return res.status(401).json({
        message: "Invalid credentials",
        alert: createAlert(
          "error",
          "Login failed",
          "The email or password you entered is incorrect."
        ),
      });
    }

    // Generate tokens
    const accessToken = signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshRaw = generateRefreshToken();
    await createRefreshSession({ userId: user.id, refreshRaw, req });
    res.cookie(REFRESH_COOKIE, refreshRaw, refreshCookieOptions());

    LogHelper.auth(user.id.toString(), "login", true);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
      accessToken,
      alert: createAlert("success", "Welcome back", "Logged in successfully."),
    });
  } catch (error) {
    next(error);
  }
});

// ---------- LOGOUT ----------
router.post("/logout", async (req, res, next) => {
  try {
    const refreshRaw = req.cookies?.[REFRESH_COOKIE];
    if (refreshRaw) {
      const refreshHash = hashToken(String(refreshRaw));
      await pool.query(
        `UPDATE refresh_sessions SET revoked_at = NOW() WHERE token_hash = $1`,
        [refreshHash]
      );
    }
    
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    
    // Get userId from auth if available
    const userId = (req as any).auth?.userId?.toString() || "unknown";
    LogHelper.auth(userId, "logout", true);
    
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ---------- GET CURRENT USER ----------
router.get("/me", requireAuth, async (req, res) => {
  return res.json({ user: req.auth });
});

// ---------- FORGOT PASSWORD ----------
router.post("/forgot-password", async (req, res, next) => {
  try {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid email",
        alert: createAlert("error", "Invalid input", "Please provide a valid email address."),
      });
    }

    const { email } = parsed.data;

    // Find user
    const result = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );

    if (!result.rows[0]) {
      // Don't reveal if email exists or not (security)
      return res.json({
        message: "If an account exists, a reset link will be sent.",
        alert: createAlert(
          "info",
          "Check your email",
          "If an account exists, you'll receive a password reset link."
        ),
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour

    // Save token to database
    await pool.query(
      `UPDATE users
       SET reset_password_token = $1, reset_password_expires = $2
       WHERE id = $3`,
      [hashedToken, expiresAt, result.rows[0].id]
    );

    // Send email with reset link
    const resetLink = `${env.appUrl}/reset-password?token=${resetToken}`;
    await sendEmail({
      to: email,
      subject: "Password Reset",
      html: `
        <p>You requested a password reset.</p>
        <p>Click <a href="${resetLink}">here</a> to reset your password.</p>
        <p>This link expires in 1 hour.</p>
        <p>If you didn't request this, ignore this email.</p>
      `,
    });

    LogHelper.auth(email, "forgot-password", true);

    return res.json({
      message: "If an account exists, a reset link will be sent.",
      alert: createAlert(
        "info",
        "Check your email",
        "If an account exists, you'll receive a password reset link."
      ),
    });
  } catch (error) {
    next(error);
  }
});

// ---------- RESET PASSWORD ----------
router.post("/reset-password", async (req, res, next) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid input",
        alert: createAlert(
          "error",
          "Invalid input",
          "Please provide a valid token and password."
        ),
      });
    }

    const { token, password } = parsed.data;

    const hashedToken = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    // Find user with valid token
    const result = await pool.query(
      `SELECT id
       FROM users
       WHERE reset_password_token = $1
       AND reset_password_expires > NOW()
       LIMIT 1`,
      [hashedToken]
    );

    const user = result.rows[0];

    if (!user) {
      LogHelper.auth("unknown", "reset-password", false);
      return res.status(400).json({
        message: "Invalid or expired token",
        alert: createAlert(
          "error",
          "Invalid token",
          "This password reset link is invalid or has expired."
        ),
      });
    }

    // Update password
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           reset_password_token = NULL,
           reset_password_expires = NULL
       WHERE id = $2`,
      [passwordHash, user.id]
    );

    // Revoke all refresh tokens for security
    await pool.query(
      `UPDATE refresh_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id]
    );

    LogHelper.auth(user.id.toString(), "reset-password", true);

    return res.json({
      message: "Password reset successful",
      alert: createAlert(
        "success",
        "Password reset",
        "Your password has been reset successfully. Please login with your new password."
      ),
    });
  } catch (error) {
    next(error);
  }
});

export default router;