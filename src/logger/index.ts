import winston from 'winston';

let logger: winston.Logger | null = null;

/**
 * Initialize the logger with the specified configuration
 */
export function initLogger(level: string = 'info', format: 'console' | 'json' = 'console'): winston.Logger {
  const formats: winston.Logform.Format[] = [
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
  ];

  if (format === 'json') {
    formats.push(winston.format.json());
  } else {
    formats.push(
      winston.format.colorize(),
      winston.format.printf(({ level, message, timestamp, ...meta }) => {
        let metaStr = '';
        if (Object.keys(meta).length > 0) {
          metaStr = ' ' + JSON.stringify(meta);
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
