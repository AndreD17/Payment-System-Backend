import rateLimit from "express-rate-limit";

const createRateLimiter = (opts: {
  windowMs: number;
  max: number;
  message: string | object;
}) =>
  rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: opts.message,
  });

export const apiLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 250,
  message: { message: "Too many requests. Slow down and try again later." },
});

export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { message: "Too many authentication requests. Try again later." },
});

export const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many login attempts. Try again later." },
});

export const publicLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { message: "Too many public requests. Try again later." },
});

export const webhookLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { message: "Too many webhook requests received." },
});