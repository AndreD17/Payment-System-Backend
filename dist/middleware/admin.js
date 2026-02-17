import { env } from "../config/env.js";
export function requireAdmin(req, _res, next) {
    const key = req.header("x-admin-key");
    if (!key || key !== env.adminApiKey)
        return next({ status: 403, message: "Admin only" });
    next();
}
