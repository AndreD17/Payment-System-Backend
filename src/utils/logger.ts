import pino from 'pino';

// Simple request ID generator
function generateRequestId(): string {
  return Math.random().toString(36).substring(2, 10) + 
         Date.now().toString(36);
}

// Create a logger with custom configuration
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      'req.body.password',
      'req.body.token',
      'req.body.refreshToken',
      'res.headers["set-cookie"]',
      '*.accessToken',
      '*.refreshToken',
      '*.token',
      '*.password',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: process.env.NODE_ENV === 'production' 
    ? undefined // In production, don't use pretty print
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          singleLine: true,
          // Hide the pino-pretty timestamp since we already have one
          hideObject: true,
        },
      },
});

// Create a child logger for requests (only used for debugging)
export function createRequestLogger(req: any) {
  const requestId = generateRequestId();
  const log = logger.child({
    requestId,
    method: req.method,
    url: req.url,
    ip: req.ip || req.connection?.remoteAddress,
  });

  return log;
}

// Sanitize sensitive data from request (only used in debug mode)
export function sanitizeRequest(req: any) {
  const { body, headers, query, params } = req;
  
  const sanitized = {
    method: req.method,
    url: req.url,
    query: query,
    params: params,
    headers: {
      'user-agent': headers?.['user-agent'],
      'content-type': headers?.['content-type'],
      'origin': headers?.origin,
      'referer': headers?.referer,
    },
    body: body ? { ...body } : undefined,
  };

  // Remove sensitive fields from body
  if (sanitized.body) {
    delete sanitized.body.password;
    delete sanitized.body.token;
    delete sanitized.body.refreshToken;
    delete sanitized.body.accessToken;
    delete sanitized.body.confirmPassword;
  }

  return sanitized;
}

export default logger;