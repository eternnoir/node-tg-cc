import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../logger';
import { SessionManager } from '../claude/session';
import { SQLiteStorage } from '../storage/sqlite';
import { BotConfig } from '../config';

// Telegram message character limit
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Escape special characters for Telegram MarkdownV2
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
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
  private config: BotConfig;
  private logger = getLogger();
  private isRunning = false;

  constructor(config: BotConfig, storage: SQLiteStorage) {
    this.config = config;
    this.bot = new Telegraf(config.token);

    this.sessionManager = new SessionManager(
      storage,
      config.name,
      config.workingDir,
      config.claudeArgs
    );

    this.setupCommands();
    this.setupMessageHandler();

    this.logger.info('TelegramBot initialized', { botName: config.name });
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

      const welcomeMessage = `👋 Welcome to ${this.config.name}!

This bot allows you to interact with Claude Code.

**Commands:**
/start - Show this welcome message
/new - Start a new conversation
/clear - Clear the current session
/status - Show session status
/help - Show help message

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

**Working Directory:** \`${this.config.workingDir}\``;

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
• **Has Active Session:** ${status.hasSession ? 'Yes ✅' : 'No ❌'}
${status.sessionId ? `• **Session ID:** \`${status.sessionId.slice(0, 8)}...\`` : ''}`;

        await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
      }
    });
  }

  /**
   * Setup message handler for text and files
   */
  private setupMessageHandler(): void {
    // Handle text messages
    this.bot.on(message('text'), async (ctx) => {
      await this.handleMessage(ctx, ctx.message.text);
    });

    // Handle photos
    this.bot.on(message('photo'), async (ctx) => {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const filePath = await this.downloadFile(ctx, photo.file_id, 'photo.jpg');
      const caption = ctx.message.caption || 'Please analyze this image.';
      await this.handleMessage(ctx, `${caption}\n\nImage file: ${filePath}`);
    });

    // Handle documents
    this.bot.on(message('document'), async (ctx) => {
      const doc = ctx.message.document;
      const fileName = doc.file_name || 'document';
      const filePath = await this.downloadFile(ctx, doc.file_id, fileName);
      const caption = ctx.message.caption || `Please analyze this file: ${fileName}`;
      await this.handleMessage(ctx, `${caption}\n\nFile: ${filePath}`);
    });

    // Handle audio
    this.bot.on(message('audio'), async (ctx) => {
      const audio = ctx.message.audio;
      const fileName = audio.file_name || 'audio.mp3';
      const filePath = await this.downloadFile(ctx, audio.file_id, fileName);
      const caption = ctx.message.caption || 'Please analyze this audio file.';
      await this.handleMessage(ctx, `${caption}\n\nAudio file: ${filePath}`);
    });

    // Handle video
    this.bot.on(message('video'), async (ctx) => {
      const video = ctx.message.video;
      const fileName = video.file_name || 'video.mp4';
      const filePath = await this.downloadFile(ctx, video.file_id, fileName);
      const caption = ctx.message.caption || 'Please analyze this video file.';
      await this.handleMessage(ctx, `${caption}\n\nVideo file: ${filePath}`);
    });

    // Handle voice messages
    this.bot.on(message('voice'), async (ctx) => {
      const voice = ctx.message.voice;
      const filePath = await this.downloadFile(ctx, voice.file_id, 'voice.ogg');
      await this.handleMessage(ctx, `Please analyze this voice message.\n\nVoice file: ${filePath}`);
    });

    // Handle stickers
    this.bot.on(message('sticker'), async (ctx) => {
      const sticker = ctx.message.sticker;
      if (sticker.is_animated || sticker.is_video) {
        await ctx.reply('⚠️ Animated and video stickers are not supported.');
        return;
      }
      const filePath = await this.downloadFile(ctx, sticker.file_id, 'sticker.webp');
      await this.handleMessage(ctx, `Please analyze this sticker.\n\nSticker file: ${filePath}`);
    });
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
   * Handle a message and send it to Claude
   */
  private async handleMessage(ctx: Context, text: string): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !this.isUserAllowed(userId)) {
      await ctx.reply(this.getUnauthorizedMessage());
      return;
    }

    if (!chatId) {
      return;
    }

    this.logger.info('Processing message', {
      chatId,
      userId,
      textLength: text.length,
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

    try {
      // Query Claude
      const result = await this.sessionManager.query(chatId, text);

      // Clear typing indicator
      clearInterval(typingInterval);

      // Send the response
      if (result.text) {
        await this.sendResponse(ctx, result.text);
      } else {
        await ctx.reply('⚠️ No response received from Claude.');
      }

      // Log statistics
      this.logger.info('Response sent', {
        chatId,
        responseLength: result.text.length,
        toolsUsed: result.toolsUsed,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
      });
    } catch (error) {
      clearInterval(typingInterval);
      this.logger.error('Error processing message', { chatId, error });

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`❌ Error: ${errorMessage}`);
    }
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
      { command: 'status', description: 'Show session status' },
      { command: 'help', description: 'Show help message' },
    ]);

    // Start polling
    await this.bot.launch();
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
