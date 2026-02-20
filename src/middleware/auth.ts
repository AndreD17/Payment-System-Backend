import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export type Role = "user" | "admin";

export type AuthUser = {
  userId: number;
  email: string;
  role: Role;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}

function getBearerToken(req: Request): string | null {
  const h = req.header("authorization");
  if (!h) return null;
  const [type, token] = h.split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = getBearerToken(req);
    if (!token) return next({ status: 401, message: "Missing Authorization: Bearer <token>" });

    const payload = jwt.verify(token, env.jwtSecret, {
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
    }) as any;

    req.auth = {
      userId: Number(payload.userId),
      email: String(payload.email),
      role: payload.role === "admin" ? "admin" : "user",
    };

    return next();
  } catch {
    return next({ status: 401, message: "Invalid or expired token" });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next({ status: 401, message: "Not authenticated" });
    if (!roles.includes(req.auth.role)) return next({ status: 403, message: "Forbidden" });
    next();
  };
}