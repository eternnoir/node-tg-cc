import Database from 'better-sqlite3';
import { getLogger } from '../logger';

/**
 * Session data stored in the database
 */
export interface SessionData {
  chatId: number;
  botName: string;
  sessionId: string;
  updatedAt: Date;
}

/**
 * SQLite storage for session persistence
 */
export class SQLiteStorage {
  private db: Database.Database;
  private logger = getLogger();

  constructor(dbPath: string) {
    this.logger.info('Initializing SQLite storage', { dbPath });

    this.db = new Database(dbPath);

    // SQLite has a single-writer limitation
    this.db.pragma('journal_mode = WAL');

    this.initSchema();
  }

  /**
   * Initialize the database schema
   */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        chat_id INTEGER NOT NULL,
        bot_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, bot_name)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_bot_name ON sessions(bot_name);
    `);

    this.logger.debug('Database schema initialized');
  }

  /**
   * Save or update a session
   */
  saveSession(chatId: number, botName: string, sessionId: string): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO sessions (chat_id, bot_name, session_id, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(chat_id, bot_name) DO UPDATE SET
          session_id = excluded.session_id,
          updated_at = CURRENT_TIMESTAMP
      `);

      stmt.run(chatId, botName, sessionId);
      this.logger.debug('Session saved', { chatId, botName, sessionId });
    } catch (error) {
      this.logger.error('Failed to save session', { chatId, botName, error });
      throw error;
    }
  }

  /**
   * Load a session by chat ID and bot name
   */
  loadSession(chatId: number, botName: string): string | null {
    try {
      const stmt = this.db.prepare(`
        SELECT session_id FROM sessions
        WHERE chat_id = ? AND bot_name = ?
      `);

      const row = stmt.get(chatId, botName) as { session_id: string } | undefined;

      if (row && row.session_id) {
        this.logger.debug('Session loaded', { chatId, botName, sessionId: row.session_id });
        return row.session_id;
      }

      this.logger.debug('No session found', { chatId, botName });
      return null;
    } catch (error) {
      this.logger.error('Failed to load session', { chatId, botName, error });
      throw error;
    }
  }

  /**
   * Load all sessions for a specific bot
   */
  loadAllSessions(botName: string): SessionData[] {
    try {
      const stmt = this.db.prepare(`
        SELECT chat_id, bot_name, session_id, updated_at
        FROM sessions
        WHERE bot_name = ? AND session_id != ''
      `);

      const rows = stmt.all(botName) as Array<{
        chat_id: number;
        bot_name: string;
        session_id: string;
        updated_at: string;
      }>;

      return rows.map((row) => ({
        chatId: row.chat_id,
        botName: row.bot_name,
        sessionId: row.session_id,
        updatedAt: new Date(row.updated_at),
      }));
    } catch (error) {
      this.logger.error('Failed to load all sessions', { botName, error });
      throw error;
    }
  }

  /**
   * Clear session ID (soft reset - keeps the record)
   */
  clearSessionId(chatId: number, botName: string): void {
    try {
      const stmt = this.db.prepare(`
        UPDATE sessions
        SET session_id = '', updated_at = CURRENT_TIMESTAMP
        WHERE chat_id = ? AND bot_name = ?
      `);

      stmt.run(chatId, botName);
      this.logger.debug('Session ID cleared', { chatId, botName });
    } catch (error) {
      this.logger.error('Failed to clear session ID', { chatId, botName, error });
      throw error;
    }
  }

  /**
   * Delete a session completely
   */
  deleteSession(chatId: number, botName: string): void {
    try {
      const stmt = this.db.prepare(`
        DELETE FROM sessions WHERE chat_id = ? AND bot_name = ?
      `);

      stmt.run(chatId, botName);
      this.logger.debug('Session deleted', { chatId, botName });
    } catch (error) {
      this.logger.error('Failed to delete session', { chatId, botName, error });
      throw error;
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
    this.logger.info('Database connection closed');
  }
}
