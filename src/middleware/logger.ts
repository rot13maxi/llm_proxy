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
  err: Error & { status?: number; statusCode?: number; type?: string },
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error(`Error: ${err.message}`);
  console.error(err.stack);

  // Body-parser surfaces malformed JSON as a SyntaxError with status 400
  // and `type: 'entity.parse.failed'`. Respect those signals so clients
  // see a 400 instead of an opaque 500.
  if (err instanceof SyntaxError && (err.status === 400 || err.type === 'entity.parse.failed')) {
    return res.status(400).json({
      error: {
        message: 'Invalid JSON in request body',
        code: 'invalid_json'
      }
    });
  }

  // Payload too large from express.json limit
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({
      error: {
        message: 'Request body too large',
        code: 'payload_too_large'
      }
    });
  }

  // Don't leak internal errors
  res.status(500).json({
    error: {
      message: 'Internal server error',
      code: 'internal_error'
    }
  });
}
