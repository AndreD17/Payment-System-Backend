import { Request, Response, NextFunction } from "express";

type CacheEntry = {
  expiresAt: number;
  body: any;
  headers: Record<string, string>;
};

const cacheStore = new Map<string, CacheEntry>();

export function cacheMiddleware(ttlSeconds: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();

    const key = req.originalUrl;
    const entry = cacheStore.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      res.set({
        ...entry.headers,
        "X-Cache": "HIT",
      });
      return res.json(entry.body);
    }

    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      cacheStore.set(key, {
        expiresAt: Date.now() + ttlSeconds * 1000,
        body,
        headers: {
          "Cache-Control": `public, max-age=${ttlSeconds}, stale-while-revalidate=30`,
        },
      });
      res.set({
        "Cache-Control": `public, max-age=${ttlSeconds}, stale-while-revalidate=30`,
        "X-Cache": "MISS",
      });
      return originalJson(body);
    };

    next();
  };
}
