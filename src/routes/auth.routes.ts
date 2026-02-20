import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import { signAccessToken, generateRefreshToken, hashToken, refreshCookieOptions } from "../auth/tokens.js";

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
    [params.userId, refreshHash, refreshExpiryDate(), params.req.get("user-agent") || null, params.req.ip]
  );
}

router.post("/admin/setup", async (req, res, next) => {
  try {
    // Optional hardening: disable in production
    if (process.env.NODE_ENV === "production") return next({ status: 403, message: "Disabled in production" });

    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
      setupKey: z.string().min(6),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return next({ status: 400, message: "Validation error", details: parsed.error.flatten() });

    if (parsed.data.setupKey !== env.adminApiKey) return next({ status: 403, message: "Invalid setup key" });

    const existingAdmin = await pool.query(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
    if (existingAdmin.rows[0]) return next({ status: 409, message: "Admin already exists" });

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);

    const r = await pool.query(
      `INSERT INTO users (email, role, password_hash)
       VALUES ($1, 'admin', $2)
       RETURNING id, email, role`,
      [parsed.data.email, passwordHash]
    );

    const admin = r.rows[0] as { id: number; email: string; role: string };

    const accessToken = signAccessToken({ userId: admin.id, email: admin.email, role: admin.role });

    const refreshRaw = generateRefreshToken();
    await createRefreshSession({ userId: admin.id, refreshRaw, req });

    res.cookie(REFRESH_COOKIE, refreshRaw, refreshCookieOptions());
    return res.status(201).json({ user: admin, accessToken });
  } catch (e) {
    next(e);
  }
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return next({ status: 400, message: "Validation error", details: parsed.error.flatten() });

    const { email, password } = parsed.data;

        const r = await pool.query(
    `SELECT id, email, role, password_hash
    FROM users
    WHERE LOWER(email) = LOWER($1)
    LIMIT 1`,
    [email]
    );

    const user = r.rows[0] as any;
    if (!user || !user.password_hash) return next({ status: 401, message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return next({ status: 401, message: "Invalid credentials" });

    const accessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });

    const refreshRaw = generateRefreshToken();
    await createRefreshSession({ userId: user.id, refreshRaw, req });

    res.cookie(REFRESH_COOKIE, refreshRaw, refreshCookieOptions());
    return res.json({ user: { id: user.id, email: user.email, role: user.role }, accessToken });
  } catch (e) {
    next(e);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const refreshRaw = req.cookies?.[REFRESH_COOKIE];
    if (!refreshRaw) return next({ status: 401, message: "Missing refresh token" });

    const currentHash = hashToken(String(refreshRaw));

    const s = await pool.query(
      `SELECT id, user_id, revoked_at, expires_at
       FROM refresh_sessions
       WHERE token_hash=$1
       LIMIT 1`,
      [currentHash]
    );

    const session = s.rows[0];
    if (!session) return next({ status: 401, message: "Invalid refresh token" });

    if (session.revoked_at) {
      await pool.query(`UPDATE refresh_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [
        session.user_id,
      ]);
      return next({ status: 401, message: "Refresh token reuse detected" });
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      return next({ status: 401, message: "Refresh token expired" });
    }

    const u = await pool.query(`SELECT id, email, role FROM users WHERE id=$1 LIMIT 1`, [session.user_id]);
    const user = u.rows[0];
    if (!user) return next({ status: 401, message: "User not found" });

    // rotate refresh
    const newRefreshRaw = generateRefreshToken();
    const newHash = hashToken(newRefreshRaw);

    await pool.query(
      `UPDATE refresh_sessions
       SET revoked_at=now(), replaced_by_hash=$1
       WHERE id=$2`,
      [newHash, session.id]
    );

    await pool.query(
      `INSERT INTO refresh_sessions (user_id, token_hash, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, newHash, refreshExpiryDate(), req.get("user-agent") || null, req.ip]
    );

    res.cookie(REFRESH_COOKIE, newRefreshRaw, refreshCookieOptions());

    const accessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });
    return res.json({ accessToken });
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
  res.json({ user: req.auth });
});

export default router;