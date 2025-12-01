import winston from 'winston';

let logger: winston.Logger | null = null;

/**
 * Serialize an Error object to a plain object for logging
 * Error objects don't serialize properly with JSON.stringify because
 * their properties (message, stack, name) are non-enumerable.
 */
function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    // Include any custom properties from the error
    for (const key of Object.keys(error)) {
      serialized[key] = (error as unknown as Record<string, unknown>)[key];
    }
    return serialized;
  }
  return error;
}

/**
 * Recursively serialize errors in an object
 */
function serializeErrorsInObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'error' || value instanceof Error) {
      result[key] = serializeError(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = serializeErrorsInObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Initialize the logger with the specified configuration
 */
export function initLogger(level: string = 'info', format: 'console' | 'json' = 'console'): winston.Logger {
  const formats: winston.Logform.Format[] = [
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
  ];

  if (format === 'json') {
    // Add a custom format to serialize errors before JSON format
    formats.push(
      winston.format((info) => {
        return serializeErrorsInObject(info) as winston.Logform.TransformableInfo;
      })()
    );
    formats.push(winston.format.json());
  } else {
    formats.push(
      winston.format.colorize(),
      winston.format.printf(({ level, message, timestamp, ...meta }) => {
        let metaStr = '';
        if (Object.keys(meta).length > 0) {
          // Serialize errors in metadata before JSON.stringify
          const serializedMeta = serializeErrorsInObject(meta);
          metaStr = ' ' + JSON.stringify(serializedMeta);
        }
        return `${timestamp} [${level}]: ${message}${metaStr}`;
      })
    );
  }

  logger = winston.createLogger({
    level,
    format: winston.format.combine(...formats),
    transports: [new winston.transports.Console()],
  });

  return logger;
}

/**
 * Get the logger instance
 */
export function getLogger(): winston.Logger {
  if (!logger) {
    logger = initLogger();
  }
  return logger;
}

/**
 * Create a child logger with additional context
 */
export function createChildLogger(meta: Record<string, unknown>): winston.Logger {
  return getLogger().child(meta);
}
