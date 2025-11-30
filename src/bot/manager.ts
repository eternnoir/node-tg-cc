import { getLogger } from '../logger';
import { TelegramBot } from './bot';
import { SQLiteStorage } from '../storage/sqlite';
import { BotConfig } from '../config';

/**
 * Manager for running multiple bot instances
 */
export class BotManager {
  private bots: TelegramBot[] = [];
  private storage: SQLiteStorage;
  private logger = getLogger();

  constructor(storage: SQLiteStorage) {
    this.storage = storage;
  }

  /**
   * Add a bot to the manager
   */
  addBot(config: BotConfig): TelegramBot {
    const bot = new TelegramBot(config, this.storage);
    this.bots.push(bot);
    this.logger.info('Bot added to manager', { botName: config.name });
    return bot;
  }

  /**
   * Start all bots
   */
  async startAll(): Promise<void> {
    this.logger.info('Starting all bots', { count: this.bots.length });

    const startPromises = this.bots.map(async (bot) => {
      try {
        await bot.start();
      } catch (error) {
        this.logger.error('Failed to start bot', {
          botName: bot.getName(),
          error,
        });
        throw error;
      }
    });

    await Promise.all(startPromises);
    this.logger.info('All bots started successfully');
  }

  /**
   * Stop all bots
   */
  stopAll(): void {
    this.logger.info('Stopping all bots');

    for (const bot of this.bots) {
      try {
        bot.stop();
      } catch (error) {
        this.logger.error('Error stopping bot', {
          botName: bot.getName(),
          error,
        });
      }
    }

    this.logger.info('All bots stopped');
  }

  /**
   * Get the number of bots
   */
  getBotCount(): number {
    return this.bots.length;
  }

  /**
   * Get all bot names
   */
  getBotNames(): string[] {
    return this.bots.map((bot) => bot.getName());
  }
}
