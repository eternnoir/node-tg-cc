import { Telegraf, Context, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { getLogger } from '../logger';
import { SessionManager } from '../claude/session';
import { MessageStream } from '../claude/message-stream';
import { ProgressDescriber } from '../claude/progress';
import { SQLiteStorage } from '../storage/sqlite';
import { BotConfig } from '../config';

// Telegram message character limit
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Active stream info per chat
 */
interface ActiveStreamInfo {
  stream: MessageStream;
  processingPromise: Promise<void>;
}

/**
 * Format tool input for display
 */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  const lines: string[] = [];

  switch (toolName) {
    case 'Bash':
      if (input.command) {
        lines.push(`Command: \`${String(input.command).slice(0, 200)}\``);
        if (String(input.command).length > 200) lines.push('...(truncated)');
      }
      if (input.description) {
        lines.push(`Description: ${input.description}`);
      }
      break;

    case 'Read':
    case 'FileRead':
      if (input.file_path) {
        lines.push(`File: \`${input.file_path}\``);
      }
      break;

    case 'Write':
    case 'FileWrite':
      if (input.file_path) {
        lines.push(`File: \`${input.file_path}\``);
      }
      if (input.content) {
        const content = String(input.content);
        lines.push(`Content: ${content.length} characters`);
      }
      break;

    case 'Edit':
    case 'FileEdit':
      if (input.file_path) {
        lines.push(`File: \`${input.file_path}\``);
      }
      if (input.old_string) {
        const old = String(input.old_string).slice(0, 100);
        lines.push(`Replace: \`${old}\`${String(input.old_string).length > 100 ? '...' : ''}`);
      }
      break;

    case 'Glob':
      if (input.pattern) {
        lines.push(`Pattern: \`${input.pattern}\``);
      }
      break;

    case 'Grep':
      if (input.pattern) {
        lines.push(`Pattern: \`${input.pattern}\``);
      }
      if (input.path) {
        lines.push(`Path: \`${input.path}\``);
      }
      break;

    case 'WebFetch':
      if (input.url) {
        lines.push(`URL: ${input.url}`);
      }
      break;

    case 'WebSearch':
      if (input.query) {
        lines.push(`Query: ${input.query}`);
      }
      break;

    default:
      // Generic display for unknown tools
      const keys = Object.keys(input).slice(0, 3);
      for (const key of keys) {
        const value = String(input[key]).slice(0, 100);
        lines.push(`${key}: ${value}${String(input[key]).length > 100 ? '...' : ''}`);
      }
      if (Object.keys(input).length > 3) {
        lines.push(`...and ${Object.keys(input).length - 3} more fields`);
      }
  }

  return lines.join('\n');
}

/**
 * Split a message into chunks that fit Telegram's limit
 */
function splitMessage(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good break point
    let breakPoint = maxLength;

    // Look for newline
    const newlinePos = remaining.lastIndexOf('\n', maxLength);
    if (newlinePos > maxLength * 0.5) {
      breakPoint = newlinePos + 1;
    } else {
      // Look for space
      const spacePos = remaining.lastIndexOf(' ', maxLength);
      if (spacePos > maxLength * 0.5) {
        breakPoint = spacePos + 1;
      }
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint);
  }

  return chunks;
}

/**
 * Telegram bot that integrates with Claude
 */
export class TelegramBot {
  private bot: Telegraf;
  private sessionManager: SessionManager;
  private progressDescriber: ProgressDescriber;
  private config: BotConfig;
  private logger = getLogger();
  private isRunning = false;

  // Active message streams per chat for real-time message injection
  private activeStreams: Map<number, ActiveStreamInfo> = new Map();

  // Minimum interval between progress message edits (ms)
  private readonly PROGRESS_UPDATE_INTERVAL = 1500;

  constructor(config: BotConfig, storage: SQLiteStorage) {
    this.config = config;
    // Force IPv4 to avoid connectivity issues with IPv6
    this.bot = new Telegraf(config.token, {
      telegram: {
        agent: new https.Agent({ keepAlive: true, family: 4 }),
      },
    });

    // Initialize progress describer (uses Agent SDK with Haiku model)
    this.progressDescriber = new ProgressDescriber(
      config.progressEnabled !== false, // Enable by default
      config.progressSystemPrompt
    );

    this.sessionManager = new SessionManager({
      storage,
      botName: config.name,
      workingDir: config.workingDir,
      model: config.model,
      maxTurns: config.maxTurns,
      claudeArgs: config.claudeArgs,
      permissionMode: config.permissionMode,
      permissionTimeout: config.permissionTimeout,
      systemPromptFile: config.systemPromptFile,
      mcpConfigFile: config.mcpConfigFile,
      thinkingBudget: config.thinkingBudget,
    });

    // Set up permission request callback
    this.sessionManager.setPermissionRequestCallback(
      this.sendPermissionRequest.bind(this)
    );

    // Debug: Log all callback queries (must be before setupCallbackHandler)
    this.bot.on('callback_query', (ctx, next) => {
      this.logger.info('Callback query received (raw)', {
        data: ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined,
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
      });
      return next();
    });

    this.setupCommands();
    this.setupMessageHandler();
    this.setupCallbackHandler();
    this.setupErrorHandler();

    this.logger.info('TelegramBot initialized', {
      botName: config.name,
      permissionMode: config.permissionMode,
    });
  }

  /**
   * Send a permission request to the user
   */
  private async sendPermissionRequest(
    chatId: number,
    permissionId: string,
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<void> {
    const formattedInput = formatToolInput(toolName, toolInput);

    const message = `🔧 **Permission Request**

Claude wants to execute:

**Tool:** \`${toolName}\`
${formattedInput}

Do you want to allow this action?`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Allow', `perm:allow:${permissionId}`),
        Markup.button.callback('❌ Deny', `perm:deny:${permissionId}`),
      ],
      [
        Markup.button.callback('✅ Always Allow This Tool', `perm:always:${permissionId}`),
      ],
    ]);

    try {
      await this.bot.telegram.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        ...keyboard,
      });
    } catch (error) {
      // Try without markdown if it fails
      const plainMessage = `🔧 Permission Request

Claude wants to execute:

Tool: ${toolName}
${formattedInput.replace(/`/g, '')}

Do you want to allow this action?`;

      await this.bot.telegram.sendMessage(chatId, plainMessage, keyboard);
    }
  }

  /**
   * Setup callback query handler for permission responses
   */
  private setupCallbackHandler(): void {
    this.bot.action(/^perm:(allow|deny|always):(.+)$/, async (ctx) => {
      const match = ctx.match;
      if (!match) return;

      const action = match[1];
      const permissionId = match[2];

      this.logger.info('Permission callback received', {
        action,
        permissionId,
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
      });

      const permissionManager = this.sessionManager.getPermissionManager();
      const pending = permissionManager.getPendingPermission(permissionId);

      if (!pending) {
        await ctx.answerCbQuery('This permission request has expired.');
        try {
          await ctx.editMessageText('⏰ Permission request expired or already handled.');
        } catch {
          // Ignore edit errors for expired messages
        }
        return;
      }

      // Immediately update message to processing state to prevent duplicate clicks
      try {
        await ctx.editMessageText(
          `⏳ Processing...\n\nTool: \`${pending.toolName}\``,
          { parse_mode: 'Markdown' }
        );
      } catch {
        // Ignore edit errors, continue processing
      }

      let response: { allowed: boolean; alwaysAllow?: boolean; message?: string };
      let statusMessage: string;

      switch (action) {
        case 'allow':
          response = { allowed: true };
          statusMessage = '✅ Permission granted';
          break;
        case 'always':
          response = { allowed: true, alwaysAllow: true };
          statusMessage = `✅ Permission granted (${pending.toolName} will be auto-allowed)`;
          break;
        case 'deny':
        default:
          response = { allowed: false, message: 'User denied permission' };
          statusMessage = '❌ Permission denied';
          break;
      }

      // Resolve the permission - this must always execute
      const resolved = permissionManager.resolvePermission(permissionId, response);

      this.logger.info('Permission resolved', {
        permissionId,
        action,
        resolved,
        toolName: pending.toolName,
      });

      try {
        if (resolved) {
          await ctx.answerCbQuery(statusMessage);
          await ctx.editMessageText(
            `${statusMessage}\n\nTool: \`${pending.toolName}\``,
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.answerCbQuery('Failed to process permission.');
        }
      } catch {
        // Ignore UI update errors, permission was already resolved
      }
    });
  }

  /**
   * Setup global error handler for Telegraf
   */
  private setupErrorHandler(): void {
    this.bot.catch((err, ctx) => {
      this.logger.error('Telegraf error', {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
        updateType: ctx.updateType,
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
      });
    });
  }

  /**
   * Check if a user is allowed to use the bot
   */
  private isUserAllowed(userId: number): boolean {
    // If whitelist is empty, allow all users
    if (this.config.whitelist.length === 0) {
      return true;
    }
    return this.config.whitelist.includes(userId);
  }

  /**
   * Get unauthorized message
   */
  private getUnauthorizedMessage(): string {
    return '⛔ You are not authorized to use this bot.';
  }

  /**
   * Setup bot commands
   */
  private setupCommands(): void {
    // /start command
    this.bot.command('start', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || !this.isUserAllowed(userId)) {
        await ctx.reply(this.getUnauthorizedMessage());
        return;
      }

      const permissionInfo = this.config.permissionMode === 'bypassPermissions'
        ? ''
        : `\n**Permission Mode:** ${this.config.permissionMode}`;

      const welcomeMessage = `👋 Welcome to ${this.config.name}!

This bot allows you to interact with Claude Code.

**Commands:**
/start - Show this welcome message
/new - Start a new conversation
/clear - Clear the current session
/status - Show session status
/help - Show help message${permissionInfo}

Just send me a message and I'll process it with Claude Code!`;

      await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
    });

    // /help command
    this.bot.command('help', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || !this.isUserAllowed(userId)) {
        await ctx.reply(this.getUnauthorizedMessage());
        return;
      }

      const permissionInfo = this.config.permissionMode === 'bypassPermissions'
        ? ''
        : `\n**Permission Mode:** ${this.config.permissionMode}\nWhen Claude needs to execute tools, you will be asked to approve each action.`;

      const helpMessage = `📚 **Help**

**Available Commands:**
• /start - Start the bot and show welcome message
• /new - Start a new conversation (clears context)
• /clear - Clear the current session
• /status - Show current session status
• /help - Show this help message

**Usage:**
Simply send any text message to interact with Claude Code. You can also send:
• 📷 Photos
• 📄 Documents
• 🎵 Audio files
• 🎥 Video files
• 🎤 Voice messages

The bot will process your message and return Claude's response.

**Working Directory:** \`${this.config.workingDir}\`${permissionInfo}`;

      await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
    });

    // /new command
    this.bot.command('new', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;

      if (!userId || !this.isUserAllowed(userId)) {
        await ctx.reply(this.getUnauthorizedMessage());
        return;
      }

      if (chatId) {
        this.sessionManager.clearSession(chatId);
        await ctx.reply('🔄 New conversation started. Your previous context has been cleared.');
        this.logger.info('New conversation started', { chatId, userId });
      }
    });

    // /clear command
    this.bot.command('clear', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;

      if (!userId || !this.isUserAllowed(userId)) {
        await ctx.reply(this.getUnauthorizedMessage());
        return;
      }

      if (chatId) {
        this.sessionManager.deleteSession(chatId);
        await ctx.reply('🗑️ Session cleared completely.');
        this.logger.info('Session cleared', { chatId, userId });
      }
    });

    // /status command
    this.bot.command('status', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;

      if (!userId || !this.isUserAllowed(userId)) {
        await ctx.reply(this.getUnauthorizedMessage());
        return;
      }

      if (chatId) {
        const status = this.sessionManager.getSessionStatus(chatId);

        const statusMessage = `📊 **Session Status**

• **Bot Name:** ${this.config.name}
• **Working Directory:** \`${status.workingDir}\`
• **Model:** ${this.config.model}
• **Permission Mode:** ${this.config.permissionMode}
• **Has Active Session:** ${status.hasSession ? 'Yes ✅' : 'No ❌'}
${status.sessionId ? `• **Session ID:** \`${status.sessionId.slice(0, 8)}...\`` : ''}`;

        await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
      }
    });

    // /cancel command - cancel active processing
    this.bot.command('cancel', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;

      if (!userId || !this.isUserAllowed(userId)) {
        await ctx.reply(this.getUnauthorizedMessage());
        return;
      }

      if (chatId) {
        const cancelled = this.cancelProcessing(chatId);
        if (cancelled) {
          await ctx.reply('🛑 Processing cancelled.');
        } else {
          await ctx.reply('ℹ️ No active processing to cancel.');
        }
      }
    });
  }

  /**
   * Setup message handler for text and files
   * NOTE: Handlers use message stream to enable real-time message injection,
   * while not blocking Telegraf polling (allowing callback_query to be received).
   */
  private setupMessageHandler(): void {
    // Handle text messages (inject or start new processing)
    this.bot.on(message('text'), (ctx) => {
      this.injectOrStartMessage(ctx, ctx.message.text);
    });

    // Handle photos (download first, then inject)
    this.bot.on(message('photo'), (ctx) => {
      (async () => {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const filePath = await this.downloadFile(ctx, photo.file_id, 'photo.jpg');
        const caption = ctx.message.caption || 'Please analyze this image.';
        this.injectOrStartMessage(ctx, `${caption}\n\nImage file: ${filePath}`);
      })().catch((error) => {
        this.logger.error('Error downloading photo', { error, chatId: ctx.chat?.id });
      });
    });

    // Handle documents (download first, then inject)
    this.bot.on(message('document'), (ctx) => {
      (async () => {
        const doc = ctx.message.document;
        const fileName = doc.file_name || 'document';
        const filePath = await this.downloadFile(ctx, doc.file_id, fileName);
        const caption = ctx.message.caption || `Please analyze this file: ${fileName}`;
        this.injectOrStartMessage(ctx, `${caption}\n\nFile: ${filePath}`);
      })().catch((error) => {
        this.logger.error('Error downloading document', { error, chatId: ctx.chat?.id });
      });
    });

    // Handle audio (download first, then inject)
    this.bot.on(message('audio'), (ctx) => {
      (async () => {
        const audio = ctx.message.audio;
        const fileName = audio.file_name || 'audio.mp3';
        const filePath = await this.downloadFile(ctx, audio.file_id, fileName);
        const caption = ctx.message.caption || 'Please analyze this audio file.';
        this.injectOrStartMessage(ctx, `${caption}\n\nAudio file: ${filePath}`);
      })().catch((error) => {
        this.logger.error('Error downloading audio', { error, chatId: ctx.chat?.id });
      });
    });

    // Handle video (download first, then inject)
    this.bot.on(message('video'), (ctx) => {
      (async () => {
        const video = ctx.message.video;
        const fileName = video.file_name || 'video.mp4';
        const filePath = await this.downloadFile(ctx, video.file_id, fileName);
        const caption = ctx.message.caption || 'Please analyze this video file.';
        this.injectOrStartMessage(ctx, `${caption}\n\nVideo file: ${filePath}`);
      })().catch((error) => {
        this.logger.error('Error downloading video', { error, chatId: ctx.chat?.id });
      });
    });

    // Handle voice messages (download first, then inject)
    this.bot.on(message('voice'), (ctx) => {
      (async () => {
        const voice = ctx.message.voice;
        const filePath = await this.downloadFile(ctx, voice.file_id, 'voice.ogg');
        this.injectOrStartMessage(ctx, `Please analyze this voice message.\n\nVoice file: ${filePath}`);
      })().catch((error) => {
        this.logger.error('Error downloading voice', { error, chatId: ctx.chat?.id });
      });
    });

    // Handle stickers (download first, then inject)
    this.bot.on(message('sticker'), (ctx) => {
      (async () => {
        const sticker = ctx.message.sticker;
        if (sticker.is_animated || sticker.is_video) {
          await ctx.reply('⚠️ Animated and video stickers are not supported.');
          return;
        }
        const filePath = await this.downloadFile(ctx, sticker.file_id, 'sticker.webp');
        this.injectOrStartMessage(ctx, `Please analyze this sticker.\n\nSticker file: ${filePath}`);
      })().catch((error) => {
        this.logger.error('Error downloading sticker', { error, chatId: ctx.chat?.id });
      });
    });
  }

  /**
   * Handle incoming message - inject into active stream or start new processing
   */
  private injectOrStartMessage(ctx: Context, text: string): void {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;

    if (!chatId) return;

    // Check authorization first
    if (!userId || !this.isUserAllowed(userId)) {
      ctx.reply(this.getUnauthorizedMessage()).catch(() => {});
      return;
    }

    // Check if there's an active stream for this chat
    const activeInfo = this.activeStreams.get(chatId);

    if (activeInfo && !activeInfo.stream.isClosed()) {
      // Inject into existing stream
      this.logger.info('Injecting message into active stream', {
        chatId,
        userId,
        textLength: text.length,
      });

      try {
        activeInfo.stream.pushText(text);
        // Send reaction to acknowledge receipt
        ctx.react('👍').catch(() => {
          // Fallback: some Telegram clients don't support reactions
          this.logger.debug('Reaction not supported, skipping', { chatId });
        });
      } catch (error) {
        this.logger.error('Failed to inject message', { chatId, error });
        ctx.reply('❌ Failed to add message. Please wait for processing to complete.').catch(() => {});
      }
    } else {
      // Start new processing
      this.startNewProcessing(ctx, text);
    }
  }

  /**
   * Start new message processing with a fresh stream
   */
  private startNewProcessing(ctx: Context, text: string): void {
    const chatId = ctx.chat?.id!;

    // Create new message stream
    const stream = new MessageStream();

    // Push the initial message
    stream.pushText(text);

    // Start processing in background
    const processingPromise = this.processStream(ctx, stream);

    // Store active stream info
    this.activeStreams.set(chatId, { stream, processingPromise });

    // Clean up when done
    processingPromise.finally(() => {
      stream.close();
      this.activeStreams.delete(chatId);
      this.logger.debug('Stream processing complete', { chatId });
    });
  }

  /**
   * Process a message stream using Claude
   */
  private async processStream(ctx: Context, stream: MessageStream): Promise<void> {
    const chatId = ctx.chat?.id!;
    const userId = ctx.from?.id!;

    // Truncate user input for logging (first 500 chars)
    // Note: We don't have the initial text here, logging happens in handleMessage equivalent

    this.logger.info('Starting stream processing', {
      chatId,
      userId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });

    // Send typing indicator
    await ctx.sendChatAction('typing');

    // Set up typing indicator interval
    const typingInterval = setInterval(async () => {
      try {
        await ctx.sendChatAction('typing');
      } catch {
        // Ignore errors
      }
    }, 4000);

    // Progress message tracking
    let progressMessageId: number | undefined;
    let lastProgressUpdate = 0;
    let toolCount = 0;

    // Send initial progress message
    try {
      const initialMessage = await this.progressDescriber.getInitialMessage('...');
      const progressMsg = await ctx.reply(`🔄 ${initialMessage}`);
      progressMessageId = progressMsg.message_id;
    } catch {
      // Ignore if we can't send progress message
    }

    // Helper to update progress message with debounce
    const updateProgress = async (description: string) => {
      if (!progressMessageId) return;

      const now = Date.now();
      if (now - lastProgressUpdate < this.PROGRESS_UPDATE_INTERVAL) {
        return; // Debounce
      }
      lastProgressUpdate = now;

      try {
        await this.bot.telegram.editMessageText(
          chatId,
          progressMessageId,
          undefined,
          `🔧 ${description}`
        );
      } catch {
        // Ignore edit errors
      }
    };

    try {
      // Query Claude with the message stream
      const result = await this.sessionManager.queryWithStream(chatId, stream, {
        onToolUse: async (toolName, toolInput) => {
          toolCount++;
          const inputSummary = this.summarizeToolInput(toolName, toolInput);
          this.logger.info('Tool use detected', {
            chatId,
            userId,
            toolName,
            toolCount,
            inputSummary,
          });

          const description = await this.progressDescriber.describe(toolName, toolInput);
          await updateProgress(description);
        },
        onThinking: async (thinking) => {
          const thinkingPreview = thinking.length > 200
            ? thinking.slice(0, 200) + '...[truncated]'
            : thinking;
          this.logger.info('Thinking detected', {
            chatId,
            userId,
            thinkingLength: thinking.length,
            thinkingPreview,
          });

          const description = await this.progressDescriber.describeThinking(thinking);
          await updateProgress(description);
        },
      });

      // Clear typing indicator
      clearInterval(typingInterval);

      // Delete progress message before sending response
      if (progressMessageId) {
        try {
          await this.bot.telegram.deleteMessage(chatId, progressMessageId);
        } catch {
          // Ignore delete errors
        }
      }

      // Send the response
      if (result.text) {
        await this.sendResponse(ctx, result.text);
      } else {
        await ctx.reply('⚠️ No response received from Claude.');
      }

      // Log statistics
      const truncatedResponse = result.text.length > 500
        ? result.text.slice(0, 500) + '...[truncated]'
        : result.text;

      this.logger.info('Response sent', {
        chatId,
        userId,
        responseLength: result.text.length,
        responsePreview: truncatedResponse,
        toolsUsed: result.toolsUsed,
        toolCount,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        sessionId: result.sessionId,
      });
    } catch (error) {
      clearInterval(typingInterval);

      // Delete progress message on error
      if (progressMessageId) {
        try {
          await this.bot.telegram.deleteMessage(chatId, progressMessageId);
        } catch {
          // Ignore delete errors
        }
      }

      this.logger.error('Error processing stream', { chatId, error });

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`❌ Error: ${errorMessage}`);
    }
  }

  /**
   * Cancel active processing for a chat
   */
  cancelProcessing(chatId: number): boolean {
    const activeInfo = this.activeStreams.get(chatId);
    if (activeInfo && !activeInfo.stream.isClosed()) {
      activeInfo.stream.close();
      this.logger.info('Processing cancelled', { chatId });
      return true;
    }
    return false;
  }

  /**
   * Download a file from Telegram
   */
  private async downloadFile(ctx: Context, fileId: string, fileName: string): Promise<string> {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Create unique filename
    const uniqueName = `${Date.now()}_${fileName}`;
    const filePath = path.join(this.config.tempDir, uniqueName);

    fs.writeFileSync(filePath, buffer);
    this.logger.debug('File downloaded', { filePath, fileId });

    return filePath;
  }

  /**
   * Summarize tool input for logging (truncate large values)
   */
  private summarizeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    const maxValueLength = 200;

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string') {
        summary[key] = value.length > maxValueLength
          ? value.slice(0, maxValueLength) + `...[${value.length} chars total]`
          : value;
      } else if (typeof value === 'object' && value !== null) {
        const str = JSON.stringify(value);
        summary[key] = str.length > maxValueLength
          ? str.slice(0, maxValueLength) + `...[${str.length} chars total]`
          : value;
      } else {
        summary[key] = value;
      }
    }

    return summary;
  }

  /**
   * Send a response, splitting if necessary
   */
  private async sendResponse(ctx: Context, text: string): Promise<void> {
    const chunks = splitMessage(text);

    for (const chunk of chunks) {
      try {
        // Try to send as Markdown first
        await ctx.reply(chunk, { parse_mode: 'Markdown' });
      } catch {
        try {
          // If Markdown fails, try without parsing
          await ctx.reply(chunk);
        } catch (error) {
          this.logger.error('Failed to send message', { error });
          throw error;
        }
      }
    }
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.logger.info('Starting bot', { botName: this.config.name });

    // Set bot commands
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'new', description: 'Start a new conversation' },
      { command: 'clear', description: 'Clear the current session' },
      { command: 'cancel', description: 'Cancel active processing' },
      { command: 'status', description: 'Show session status' },
      { command: 'help', description: 'Show help message' },
    ]);

    // Start polling (drop pending updates and delete webhook if any)
    await this.bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'callback_query'],
    });
    this.isRunning = true;

    this.logger.info('Bot started', { botName: this.config.name });
  }

  /**
   * Stop the bot
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping bot', { botName: this.config.name });
    this.bot.stop();
    this.isRunning = false;
  }

  /**
   * Get bot name
   */
  getName(): string {
    return this.config.name;
  }
}
