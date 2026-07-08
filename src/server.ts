import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { startOutboxWorker } from "./worker/outboxWorker.js";
import logger from "./utils/logger.js";

// Create the app
const app = createApp();

// Start the server
const server = app.listen(env.port, () => {
  logger.info(`🚀 API on http://localhost:${env.port}`);
  logger.info(`📡 Auth routes: http://localhost:${env.port}/api/auth`);
  logger.info(`📡 Health check: http://localhost:${env.port}/health`);
});

// Start the outbox worker (if you need it)
startOutboxWorker();

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
  });
});