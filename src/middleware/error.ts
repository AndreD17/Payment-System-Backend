import { Request, Response, NextFunction } from "express";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = Number(err?.status ?? 500);
  res.status(status).json({ message: err?.message ?? "Server error", details: err?.details });
}
