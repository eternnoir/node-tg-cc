#!/usr/bin/env node

import * as path from 'path';
import { loadFromEnv, loadFromEnvFile, Config } from './config';
import { initLogger, getLogger } from './logger';
import { SQLiteStorage } from './storage/sqlite';
import { BotManager } from './bot/manager';

// Version
const VERSION = '1.0.0';

/**
 * Parse command line arguments
 */
function parseArgs(): { envPath?: string; showVersion: boolean; showHelp: boolean } {
  const args = process.argv.slice(2);
  let envPath: string | undefined;
  let showVersion = false;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-v' || arg === '--version') {
      showVersion = true;
    } else if (arg === '-h' || arg === '--help') {
      showHelp = true;
    } else if (arg === '-e' || arg === '--env') {
      envPath = args[++i];
    } else if (arg.startsWith('--env=')) {
      envPath = arg.split('=')[1];
    }
  }

  return { envPath, showVersion, showHelp };
}

/**
 * Show help message
 */
function showHelp(): void {
  console.log(`
node-tg-cc - Telegram bot integration with Claude Code

USAGE:
  npx node-tg-cc [OPTIONS]
  tg-cc [OPTIONS]

OPTIONS:
  -e, --env <path>    Path to .env file (default: .env in current directory)
  -v, --version       Show version
  -h, --help          Show this help message

ENVIRONMENT VARIABLES:

  Common:
    LOG_LEVEL         Log level (debug, info, warn, error). Default: info
    LOG_FORMAT        Log format (console, json). Default: console
    DB_PATH           Path to SQLite database. Default: sessions.db

  Single Bot Configuration:
    BOT_TOKEN         Telegram bot token (required)
    BOT_WORKING_DIR   Working directory for Claude Code (required)
    BOT_NAME          Bot name (optional)
    BOT_WHITELIST     Comma-separated user IDs (optional)
    BOT_CLAUDE_ARGS   Additional Claude CLI arguments (optional)
    BOT_TEMP_DIR      Temporary directory for uploads (optional)

  Multiple Bots Configuration:
    BOT_COUNT         Number of bots (optional, auto-detected)
    BOT_N_TOKEN       Token for bot N (N = 1, 2, 3, ...)
    BOT_N_WORKING_DIR Working directory for bot N
    BOT_N_NAME        Name for bot N
    BOT_N_WHITELIST   Whitelist for bot N
    BOT_N_CLAUDE_ARGS Claude args for bot N
    BOT_N_TEMP_DIR    Temp directory for bot N

EXAMPLES:
  # Using .env file in current directory
  npx node-tg-cc

  # Using custom .env file
  npx node-tg-cc --env /path/to/.env

  # Using environment variables directly
  BOT_TOKEN=xxx BOT_WORKING_DIR=/project npx node-tg-cc

For more information, visit: https://github.com/eternnoir/node-tg-cc
`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const { envPath, showVersion, showHelp: showHelpFlag } = parseArgs();

  if (showVersion) {
    console.log(`node-tg-cc v${VERSION}`);
    process.exit(0);
  }

  if (showHelpFlag) {
    showHelp();
    process.exit(0);
  }

  // Load configuration
  let config: Config;

  try {
    if (envPath) {
      // Load from specified .env file
      config = loadFromEnvFile(envPath);
    } else {
      // Try to load .env from current directory first
      const defaultEnvPath = path.join(process.cwd(), '.env');
      try {
        require('dotenv').config({ path: defaultEnvPath });
      } catch {
        // Ignore if .env doesn't exist
      }
      config = loadFromEnv();
    }
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Initialize logger
  const logger = initLogger(config.logLevel, config.logFormat);
  logger.info('Starting node-tg-cc', { version: VERSION });

  // Initialize storage
  const storage = new SQLiteStorage(config.dbPath);

  // Initialize bot manager
  const manager = new BotManager(storage);

  // Add bots
  for (const botConfig of config.bots) {
    manager.addBot(botConfig);
    logger.info('Bot configured', {
      name: botConfig.name,
      workingDir: botConfig.workingDir,
      whitelistCount: botConfig.whitelist.length,
    });
  }

  // Setup graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    manager.stopAll();
    storage.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start all bots
  try {
    await manager.startAll();
    logger.info('All bots are running', {
      count: manager.getBotCount(),
      bots: manager.getBotNames(),
    });
  } catch (error) {
    logger.error('Failed to start bots', { error });
    storage.close();
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
