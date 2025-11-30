import {
  query,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKSystemMessage,
  type SDKResultMessage,
  type Options,
} from '@anthropic-ai/claude-code';
import { getLogger } from '../logger';
import { SQLiteStorage } from '../storage/sqlite';

/**
 * Claude session for a specific chat
 */
export interface Session {
  chatId: number;
  sessionId: string | null;
  workingDir: string;
}

/**
 * Result from Claude query
 */
export interface ClaudeResult {
  text: string;
  sessionId: string | null;
  toolsUsed: string[];
  costUsd?: number;
  durationMs?: number;
}

/**
 * Session manager for Claude interactions
 */
export class SessionManager {
  private sessions: Map<number, Session> = new Map();
  private logger = getLogger();
  private storage: SQLiteStorage;
  private botName: string;
  private workingDir: string;
  private claudeArgs: string[];

  constructor(
    storage: SQLiteStorage,
    botName: string,
    workingDir: string,
    claudeArgs: string[] = []
  ) {
    this.storage = storage;
    this.botName = botName;
    this.workingDir = workingDir;
    this.claudeArgs = claudeArgs;

    this.logger.info('SessionManager initialized', {
      botName,
      workingDir,
      claudeArgs,
    });
  }

  /**
   * Get or create a session for a chat
   */
  getSession(chatId: number): Session {
    let session = this.sessions.get(chatId);

    if (!session) {
      // Try to load from storage
      const sessionId = this.storage.loadSession(chatId, this.botName);

      session = {
        chatId,
        sessionId,
        workingDir: this.workingDir,
      };

      this.sessions.set(chatId, session);
      this.logger.debug('Session retrieved', { chatId, sessionId });
    }

    return session;
  }

  /**
   * Clear a session (start fresh conversation)
   */
  clearSession(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.sessionId = null;
    }
    this.storage.clearSessionId(chatId, this.botName);
    this.logger.info('Session cleared', { chatId, botName: this.botName });
  }

  /**
   * Delete a session completely
   */
  deleteSession(chatId: number): void {
    this.sessions.delete(chatId);
    this.storage.deleteSession(chatId, this.botName);
    this.logger.info('Session deleted', { chatId, botName: this.botName });
  }

  /**
   * Save session ID to storage
   */
  private saveSession(chatId: number, sessionId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.sessionId = sessionId;
    }
    this.storage.saveSession(chatId, this.botName, sessionId);
    this.logger.debug('Session saved', { chatId, sessionId });
  }

  /**
   * Get session status
   */
  getSessionStatus(chatId: number): {
    hasSession: boolean;
    sessionId: string | null;
    workingDir: string;
  } {
    const session = this.getSession(chatId);
    return {
      hasSession: !!session.sessionId,
      sessionId: session.sessionId,
      workingDir: this.workingDir,
    };
  }

  /**
   * Parse Claude arguments from the claudeArgs array
   */
  private parseClaudeOptions(): Partial<Options> {
    const options: Partial<Options> = {};

    for (let i = 0; i < this.claudeArgs.length; i++) {
      const arg = this.claudeArgs[i];

      if (arg === '--model' && this.claudeArgs[i + 1]) {
        options.model = this.claudeArgs[++i];
      } else if (arg === '--max-turns' && this.claudeArgs[i + 1]) {
        options.maxTurns = parseInt(this.claudeArgs[++i], 10);
      } else if (arg === '--permission-mode' && this.claudeArgs[i + 1]) {
        const mode = this.claudeArgs[++i];
        if (['default', 'acceptEdits', 'bypassPermissions', 'plan'].includes(mode)) {
          options.permissionMode = mode as Options['permissionMode'];
        }
      }
    }

    return options;
  }

  /**
   * Send a query to Claude
   */
  async query(
    chatId: number,
    prompt: string,
    onProgress?: (text: string) => void
  ): Promise<ClaudeResult> {
    const session = this.getSession(chatId);
    const startTime = Date.now();

    this.logger.info('Sending query to Claude', {
      chatId,
      sessionId: session.sessionId,
      promptLength: prompt.length,
    });

    try {
      let resultText = '';
      let newSessionId: string | null = null;
      const toolsUsed: string[] = [];
      let costUsd: number | undefined;

      // Build options for Claude query
      const options: Options = {
        cwd: this.workingDir,
        maxTurns: 50,
        permissionMode: 'bypassPermissions',
        ...this.parseClaudeOptions(),
      };

      // Add resume option if we have a session
      if (session.sessionId) {
        options.resume = session.sessionId;
      }

      // Execute the query
      const response = query({ prompt, options });

      // Process the stream
      for await (const message of response) {
        this.processMessage(message, {
          onText: (text) => {
            resultText += text;
            if (onProgress) {
              onProgress(text);
            }
          },
          onSessionId: (id) => {
            newSessionId = id;
          },
          onToolUse: (tool) => {
            if (!toolsUsed.includes(tool)) {
              toolsUsed.push(tool);
            }
          },
          onCost: (cost) => {
            costUsd = cost;
          },
        });
      }

      // Save the session ID if we got a new one
      if (newSessionId) {
        this.saveSession(chatId, newSessionId);
      }

      const durationMs = Date.now() - startTime;

      this.logger.info('Query completed', {
        chatId,
        sessionId: newSessionId || session.sessionId,
        resultLength: resultText.length,
        toolsUsed,
        durationMs,
        costUsd,
      });

      return {
        text: resultText,
        sessionId: newSessionId || session.sessionId,
        toolsUsed,
        costUsd,
        durationMs,
      };
    } catch (error) {
      this.logger.error('Query failed', { chatId, error });
      throw error;
    }
  }

  /**
   * Process a message from Claude
   */
  private processMessage(
    message: SDKMessage,
    handlers: {
      onText: (text: string) => void;
      onSessionId: (id: string) => void;
      onToolUse: (tool: string) => void;
      onCost: (cost: number) => void;
    }
  ): void {
    // Get session ID from any message
    if (message.session_id) {
      handlers.onSessionId(message.session_id);
    }

    switch (message.type) {
      case 'system': {
        const sysMsg = message as SDKSystemMessage;
        if (sysMsg.subtype === 'init' && sysMsg.session_id) {
          handlers.onSessionId(sysMsg.session_id);
        }
        break;
      }

      case 'assistant': {
        const assistantMsg = message as SDKAssistantMessage;
        if (assistantMsg.message && assistantMsg.message.content) {
          const content = assistantMsg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                handlers.onText(block.text);
              } else if (block.type === 'tool_use') {
                handlers.onToolUse(block.name);
              }
            }
          }
        }
        break;
      }

      case 'result': {
        const resultMsg = message as SDKResultMessage;
        if (resultMsg.total_cost_usd !== undefined) {
          handlers.onCost(resultMsg.total_cost_usd);
        }
        break;
      }
    }
  }
}
