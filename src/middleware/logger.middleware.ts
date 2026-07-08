import { Request, Response, NextFunction } from 'express';
import { createRequestLogger, sanitizeRequest } from '../utils/logger.js';
import logger from '../utils/logger.js';

export function loggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  // Don't log OPTIONS requests at all (they're just noise)
  if (req.method === 'OPTIONS') {
    return next();
  }

  // Store the original send
  const originalSend = res.send;
  res.send = function (body: any) {
    res.locals.body = body;
    return originalSend.call(this, body);
  };

  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;

    // Only log if:
    // 1. It's an error (4xx or 5xx)
    // 2. It's a non-GET request (POST, PUT, DELETE)
    // 3. It's a slow request (> 1000ms)
    const isError = statusCode >= 400;
    const isMutation = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    const isSlow = duration > 1000;

    if (!isError && !isMutation && !isSlow) {
      return; // Skip logging for successful GET requests
    }

    const logData: any = {
      method: req.method,
      url: req.url,
      statusCode,
      duration: `${duration}ms`,
      ip: req.ip || req.connection?.remoteAddress,
    };

    // Add user ID if available
    if ((req as any).auth?.userId) {
      logData.userId = (req as any).auth.userId;
    }

    // Add error details for error responses
    if (isError && res.locals.body) {
      try {
        const body = JSON.parse(res.locals.body);
        if (body.message) logData.error = body.message;
        if (body.alert) logData.alert = body.alert;
      } catch {
        // Not JSON
      }
    }

    // Log at appropriate level
    if (statusCode >= 500) {
      logger.error(logData, `${req.method} ${req.url} - ${statusCode}`);
    } else if (statusCode >= 400) {
      logger.warn(logData, `${req.method} ${req.url} - ${statusCode}`);
    } else if (isSlow) {
      logger.warn(logData, `Slow request: ${req.method} ${req.url} - ${duration}ms`);
    } else {
      logger.info(logData, `${req.method} ${req.url} - ${statusCode} (${duration}ms)`);
    }
  });

  next();
}