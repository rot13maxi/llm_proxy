import { type Request, type Response, type NextFunction } from 'express';

/**
 * Request logging middleware
 * Logs all requests with timing and status
 */
export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const method = req.method;
    const path = req.path;
    const apiKeyName = (req as Request & { apiKey?: { name: string } }).apiKey?.name || 'anonymous';

    // Log on response finish
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const status = res.statusCode;
      
      const logEntry = {
        method,
        path,
        apiKey: apiKeyName,
        status,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString()
      };

      // Color code based on status
      const statusColor = status >= 500 ? '\x1b[31m' : // red
                         status >= 400 ? '\x1b[33m' : // yellow
                         status >= 300 ? '\x1b[34m' : // blue
                         '\x1b[32m'; // green
      const reset = '\x1b[0m';

      console.log(
        `[${logEntry.timestamp}] ${method} ${path} - ${statusColor}${status}${reset} ` +
        `(${logEntry.duration}) - ${apiKeyName}`
      );
    });

    next();
  };
}

/**
 * Error handling middleware
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error(`Error: ${err.message}`);
  console.error(err.stack);

  // Don't leak internal errors
  res.status(500).json({
    error: {
      message: 'Internal server error',
      code: 'internal_error'
    }
  });
}
