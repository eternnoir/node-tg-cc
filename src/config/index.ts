import * as fs from 'fs';
import * as path from 'path';

/** Permission mode type */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/**
 * Configuration for a single bot instance
 */
export interface BotConfig {
  /** Bot token from BotFather */
  token: string;
  /** Working directory for Claude Code */
  workingDir: string;
  /** Bot name (optional, for identification) */
  name: string;
  /** Whitelist of allowed Telegram user IDs */
  whitelist: number[];
  /** Additional arguments to pass to Claude */
  claudeArgs: string[];
  /** Temporary directory for file uploads */
  tempDir: string;
  /** Claude model to use (default: sonnet) */
  model: string;
  /** Maximum turns for Claude conversation */
  maxTurns: number;
  /** Permission mode for tool execution */
  permissionMode: PermissionMode;
  /** Timeout for permission requests in seconds (default: 60) */
  permissionTimeout: number;
  /** Path to custom system prompt file (optional) */
  systemPromptFile?: string;
  /** Path to MCP configuration file (.mcp.json) */
  mcpConfigFile?: string;
  /** Enable progress updates using Claude Haiku (default: true) */
  progressEnabled?: boolean;
  /** Custom system prompt for progress description generation */
  progressSystemPrompt?: string;
  /** Extended thinking budget in tokens (0 = disabled, min: 1024 when enabled) */
  thinkingBudget?: number;
}

/**
 * Application configuration
 */
export interface Config {
  /** Array of bot configurations */
  bots: BotConfig[];
  /** Path to SQLite database file */
  dbPath: string;
  /** Log level */
  logLevel: string;
  /** Log format */
  logFormat: 'console' | 'json';
}

/**
 * Parse whitelist from comma-separated string
 */
function parseWhitelist(value: string | undefined): number[] {
  if (!value || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
    .map((id) => {
      const num = parseInt(id, 10);
      if (isNaN(num)) {
        throw new Error(`Invalid user ID in whitelist: ${id}`);
      }
      return num;
    });
}

/**
 * Parse Claude arguments from string
 * Supports both space-separated and comma-separated formats
 * Respects quoted strings
 */
function parseClaudeArgs(value: string | undefined): string[] {
  if (!value || value.trim() === '') {
    return [];
  }

  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
    } else if ((char === ' ' || char === ',') && !inQuote) {
      if (current.trim()) {
        args.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

/**
 * Validate that a directory exists
 */
function validateDirectory(dirPath: string, name: string): void {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`${name} does not exist: ${dirPath}`);
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`${name} is not a directory: ${dirPath}`);
  }
}

/**
 * Ensure a directory exists, create if it doesn't
 */
function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Load a single bot configuration from environment variables
 */
function loadSingleBotConfig(prefix: string = 'BOT'): BotConfig | null {
  const token = process.env[`${prefix}_TOKEN`];
  const workingDir = process.env[`${prefix}_WORKING_DIR`];

  if (!token || !workingDir) {
    return null;
  }

  // Validate working directory
  validateDirectory(workingDir, `${prefix}_WORKING_DIR`);

  const name = process.env[`${prefix}_NAME`] || prefix;
  const whitelist = parseWhitelist(process.env[`${prefix}_WHITELIST`]);
  const claudeArgs = parseClaudeArgs(process.env[`${prefix}_CLAUDE_ARGS`]);

  // Handle temp directory
  let tempDir = process.env[`${prefix}_TEMP_DIR`];
  if (!tempDir) {
    tempDir = path.join(workingDir, '.tg-cc-temp');
  }
  ensureDirectory(tempDir);

  // Claude model (default: sonnet)
  const model = process.env[`${prefix}_MODEL`] || 'sonnet';

  // Max turns (default: 50)
  const maxTurnsStr = process.env[`${prefix}_MAX_TURNS`];
  const maxTurns = maxTurnsStr ? parseInt(maxTurnsStr, 10) : 50;

  // Permission mode (default: default - requires user confirmation)
  const permissionModeEnv = process.env[`${prefix}_PERMISSION_MODE`] || 'default';
  const validModes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
  const permissionMode: PermissionMode = validModes.includes(permissionModeEnv as PermissionMode)
    ? (permissionModeEnv as PermissionMode)
    : 'default';

  // Permission timeout in seconds (default: 60)
  const permissionTimeoutStr = process.env[`${prefix}_PERMISSION_TIMEOUT`];
  const permissionTimeout = permissionTimeoutStr ? parseInt(permissionTimeoutStr, 10) : 60;

  // System prompt file (optional)
  const systemPromptFile = process.env[`${prefix}_SYSTEM_PROMPT_FILE`];
  if (systemPromptFile && !fs.existsSync(systemPromptFile)) {
    throw new Error(`System prompt file not found: ${systemPromptFile}`);
  }

  // MCP config file: explicit path or auto-detect in workingDir
  let mcpConfigFile = process.env[`${prefix}_MCP_CONFIG_FILE`];
  if (mcpConfigFile && !fs.existsSync(mcpConfigFile)) {
    throw new Error(`MCP config file not found: ${mcpConfigFile}`);
  }
  // Auto-detect .mcp.json in workingDir if not explicitly specified
  if (!mcpConfigFile) {
    const autoDetectPath = path.join(workingDir, '.mcp.json');
    if (fs.existsSync(autoDetectPath)) {
      mcpConfigFile = autoDetectPath;
    }
  }

  // Progress updates enabled (default: true)
  const progressEnabledEnv = process.env[`${prefix}_PROGRESS_ENABLED`];
  const progressEnabled = progressEnabledEnv !== 'false';

  // Custom system prompt for progress descriptions (optional)
  const progressSystemPrompt = process.env[`${prefix}_PROGRESS_SYSTEM_PROMPT`];

  // Extended thinking budget in tokens (0 = disabled, min: 1024 when enabled)
  const thinkingBudgetStr = process.env[`${prefix}_THINKING_BUDGET`];
  const thinkingBudgetRaw = thinkingBudgetStr ? parseInt(thinkingBudgetStr, 10) : 0;
  const thinkingBudget = thinkingBudgetRaw > 0 ? Math.max(1024, thinkingBudgetRaw) : 0;

  return {
    token,
    workingDir,
    name,
    whitelist,
    claudeArgs,
    tempDir,
    model,
    maxTurns,
    permissionMode,
    permissionTimeout,
    systemPromptFile,
    mcpConfigFile,
    progressEnabled,
    progressSystemPrompt,
    thinkingBudget,
  };
}

/**
 * Detect the number of bots configured via environment variables
 */
function detectBotCount(): number {
  // Check for explicit BOT_COUNT
  const explicitCount = process.env['BOT_COUNT'];
  if (explicitCount) {
    const count = parseInt(explicitCount, 10);
    if (!isNaN(count) && count > 0) {
      return count;
    }
  }

  // Auto-detect by looking for BOT_N_TOKEN patterns
  let count = 0;
  for (let i = 1; i <= 100; i++) {
    if (process.env[`BOT_${i}_TOKEN`]) {
      count = i;
    } else {
      break;
    }
  }

  return count;
}

/**
 * Load configuration from environment variables
 */
export function loadFromEnv(): Config {
  // Load common settings
  const dbPath = process.env['DB_PATH'] || 'sessions.db';
  const logLevel = process.env['LOG_LEVEL'] || 'info';
  const logFormat = (process.env['LOG_FORMAT'] || 'console') as 'console' | 'json';

  const bots: BotConfig[] = [];

  // First, try to load single bot configuration (without index)
  const singleBot = loadSingleBotConfig('BOT');
  if (singleBot) {
    bots.push(singleBot);
    return { bots, dbPath, logLevel, logFormat };
  }

  // If no single bot config, try multi-bot configuration
  const botCount = detectBotCount();
  if (botCount === 0) {
    throw new Error(
      'No bot configuration found. Please set BOT_TOKEN and BOT_WORKING_DIR, ' +
        'or BOT_1_TOKEN and BOT_1_WORKING_DIR for multiple bots.'
    );
  }

  for (let i = 1; i <= botCount; i++) {
    const botConfig = loadSingleBotConfig(`BOT_${i}`);
    if (botConfig) {
      bots.push(botConfig);
    } else {
      throw new Error(
        `Bot ${i} configuration incomplete. ` +
          `Please set BOT_${i}_TOKEN and BOT_${i}_WORKING_DIR.`
      );
    }
  }

  return { bots, dbPath, logLevel, logFormat };
}

/**
 * Load configuration from a .env file
 */
export function loadFromEnvFile(envPath: string): Config {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env file not found: ${envPath}`);
  }

  // Load the .env file
  require('dotenv').config({ path: envPath });

  return loadFromEnv();
}

/**
 * Create a default configuration for testing
 */
export function createDefaultConfig(): Config {
  return {
    bots: [],
    dbPath: 'sessions.db',
    logLevel: 'info',
    logFormat: 'console',
  };
}
