import logger from './logger';

export class LogHelper {
  static auth(userId: string, action: string, success: boolean) {
    logger.info({
      userId,
      action,
      success,
      type: 'auth',
    }, `${action} - ${success ? 'Success' : 'Failed'}`);
  }

  static payment(userId: string, amount: number, currency: string, status: string) {
    logger.info({
      userId,
      amount,
      currency,
      status,
      type: 'payment',
    }, `Payment ${status}`);
  }

  static db(query: string, duration: number, success: boolean) {
    if (duration > 1000) {
      logger.warn({
        query: query.substring(0, 100),
        duration: `${duration}ms`,
        success,
        type: 'database',
      }, 'Slow query detected');
    }
  }

  static apiCall(endpoint: string, method: string, statusCode: number, duration: number) {
    const level = statusCode >= 400 ? 'warn' : 'info';
    logger[level]({
      endpoint,
      method,
      statusCode,
      duration: `${duration}ms`,
      type: 'api',
    }, `API call ${endpoint}`);
  }
}