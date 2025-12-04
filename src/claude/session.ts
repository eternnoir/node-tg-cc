import * as fs from 'fs';
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
  type SDKSystemMessage,
  type SDKResultMessage,
  type Options,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { MessageStream } from './message-stream';
import { getLogger } from '../logger';
import { SQLiteStorage } from '../storage/sqlite';
import { PermissionManager, type PermissionRequestCallback } from './permission';
import { type PermissionMode } from '../config';

/**
 * MCP configuration file structure
 */
interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Load MCP configuration from a JSON file
 */
function loadMcpConfig(
  filePath: string,
  logger: ReturnType<typeof getLogger>
): Record<string, McpServerConfig> | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const config: McpConfigFile = JSON.parse(content);
    return config.mcpServers;
  } catch (error) {
    logger.warn('Failed to load MCP config', { filePath, error });
    return undefined;
  }
}

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
 * Callback for tool execution progress
 */
export type OnToolUseCallback = (
  toolName: string,
  toolInput: Record<string, unknown>
) => void | Promise<void>;

/**
 * Callback for thinking progress
 */
export type OnThinkingCallback = (thinking: string) => void | Promise<void>;

/**
 * Session manager options
 */
export interface SessionManagerOptions {
  storage: SQLiteStorage;
  botName: string;
  workingDir: string;
  model?: string;
  maxTurns?: number;
  claudeArgs?: string[];
  permissionMode?: PermissionMode;
  permissionTimeout?: number;
  systemPromptFile?: string;
  mcpConfigFile?: string;
  thinkingBudget?: number;
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
  private model: string;
  private maxTurns: number;
  private claudeArgs: string[];
  private permissionMode: PermissionMode;
  private permissionManager: PermissionManager;
  private systemPrompt?: string;
  private mcpServers?: Record<string, McpServerConfig>;
  private thinkingBudget: number;

  constructor(options: SessionManagerOptions) {
    this.storage = options.storage;
    this.botName = options.botName;
    this.workingDir = options.workingDir;
    this.model = options.model || 'sonnet';
    this.maxTurns = options.maxTurns || 50;
    this.claudeArgs = options.claudeArgs || [];
    this.permissionMode = options.permissionMode || 'default';
    this.permissionManager = new PermissionManager(options.permissionTimeout || 60);
    this.thinkingBudget = options.thinkingBudget || 0;

    // Load system prompt from file if specified
    if (options.systemPromptFile) {
      this.systemPrompt = fs.readFileSync(options.systemPromptFile, 'utf-8');
      this.logger.info('Loaded custom system prompt', {
        botName: this.botName,
        file: options.systemPromptFile,
        length: this.systemPrompt.length,
      });
    }

    // Load MCP configuration if specified
    if (options.mcpConfigFile) {
      this.mcpServers = loadMcpConfig(options.mcpConfigFile, this.logger);
      if (this.mcpServers) {
        this.logger.info('Loaded MCP config', {
          botName: this.botName,
          file: options.mcpConfigFile,
          servers: Object.keys(this.mcpServers),
        });
      }
    }

    this.logger.info('SessionManager initialized', {
      botName: this.botName,
      workingDir: this.workingDir,
      model: this.model,
      maxTurns: this.maxTurns,
      permissionMode: this.permissionMode,
      claudeArgs: this.claudeArgs,
      hasSystemPrompt: !!this.systemPrompt,
      hasMcpServers: !!this.mcpServers,
      thinkingBudget: this.thinkingBudget,
    });
  }

  /**
   * Set the permission request callback
   */
  setPermissionRequestCallback(callback: PermissionRequestCallback): void {
    this.permissionManager.setPermissionRequestCallback(callback);
  }

  /**
   * Get the permission manager
   */
  getPermissionManager(): PermissionManager {
    return this.permissionManager;
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
    this.permissionManager.clearAlwaysAllowed(chatId);
    this.permissionManager.cancelPendingForChat(chatId);
    this.logger.info('Session cleared', { chatId, botName: this.botName });
  }

  /**
   * Delete a session completely
   */
  deleteSession(chatId: number): void {
    this.sessions.delete(chatId);
    this.storage.deleteSession(chatId, this.botName);
    this.permissionManager.clearAlwaysAllowed(chatId);
    this.permissionManager.cancelPendingForChat(chatId);
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
   * Create canUseTool callback for permission handling
   */
  private createCanUseTool(chatId: number): Options['canUseTool'] {
    return async (toolName, toolInput) => {
      this.logger.debug('Permission requested for tool', { chatId, toolName });

      const response = await this.permissionManager.requestPermission(
        chatId,
        toolName,
        toolInput
      );

      if (response.allowed) {
        return {
          behavior: 'allow' as const,
          updatedInput: toolInput,
        };
      } else {
        return {
          behavior: 'deny' as const,
          message: response.message || 'User denied permission',
        };
      }
    };
  }

  /**
   * Send a query to Claude
   */
  async query(
    chatId: number,
    prompt: string,
    callbacks?: {
      onProgress?: (text: string) => void;
      onToolUse?: OnToolUseCallback;
      onThinking?: OnThinkingCallback;
    }
  ): Promise<ClaudeResult> {
    const session = this.getSession(chatId);
    const startTime = Date.now();

    // Truncate prompt for logging (first 300 chars)
    const truncatedPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...[truncated]' : prompt;

    this.logger.info('Sending query to Claude', {
      chatId,
      sessionId: session.sessionId,
      promptLength: prompt.length,
      promptPreview: truncatedPrompt,
      model: this.model,
      workingDir: this.workingDir,
      permissionMode: this.permissionMode,
      isResuming: !!session.sessionId,
    });

    try {
      let resultText = '';
      let newSessionId: string | null = null;
      const toolsUsed: string[] = [];
      let costUsd: number | undefined;

      // Build options for Claude query
      const options: Options = {
        cwd: this.workingDir,
        settingSources: ['project'], // Load hooks from workingDir/.claude/settings.json
        model: this.model,
        maxTurns: this.maxTurns,
        permissionMode: this.permissionMode,
        ...this.parseClaudeOptions(),
        ...(this.systemPrompt && { systemPrompt: this.systemPrompt }),
        ...(this.mcpServers && { mcpServers: this.mcpServers }),
        ...(this.thinkingBudget > 0 && { maxThinkingTokens: this.thinkingBudget }),
      };

      // Add canUseTool callback if permission mode requires it
      if (this.permissionMode === 'default' || this.permissionMode === 'acceptEdits') {
        options.canUseTool = this.createCanUseTool(chatId);
      }

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
            if (callbacks?.onProgress) {
              callbacks.onProgress(text);
            }
          },
          onSessionId: (id) => {
            newSessionId = id;
          },
          onToolUse: (tool, input) => {
            if (!toolsUsed.includes(tool)) {
              toolsUsed.push(tool);
            }
            // Trigger the onToolUse callback if provided
            if (callbacks?.onToolUse) {
              callbacks.onToolUse(tool, input);
            }
          },
          onThinking: (thinking) => {
            // Trigger the onThinking callback if provided
            if (callbacks?.onThinking) {
              callbacks.onThinking(thinking);
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

      // Truncate result for logging (first 300 chars)
      const truncatedResult = resultText.length > 300
        ? resultText.slice(0, 300) + '...[truncated]'
        : resultText;

      this.logger.info('Query completed', {
        chatId,
        sessionId: newSessionId || session.sessionId,
        resultLength: resultText.length,
        resultPreview: truncatedResult,
        toolsUsed,
        toolCount: toolsUsed.length,
        durationMs,
        costUsd,
        model: this.model,
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
   * Query Claude using a message stream for real-time message injection.
   * This allows pushing additional messages while Claude is processing.
   */
  async queryWithStream(
    chatId: number,
    stream: MessageStream,
    callbacks?: {
      onProgress?: (text: string) => void;
      onToolUse?: OnToolUseCallback;
      onThinking?: OnThinkingCallback;
    }
  ): Promise<ClaudeResult> {
    const session = this.getSession(chatId);
    const startTime = Date.now();

    // Set initial session ID if resuming an existing session
    if (session.sessionId) {
      stream.setSessionId(session.sessionId);
    }

    this.logger.info('Starting stream query to Claude', {
      chatId,
      sessionId: session.sessionId,
      model: this.model,
      workingDir: this.workingDir,
      permissionMode: this.permissionMode,
      isResuming: !!session.sessionId,
    });

    try {
      let resultText = '';
      let newSessionId: string | null = null;
      const toolsUsed: string[] = [];
      let costUsd: number | undefined;

      // Build options for Claude query
      const options: Options = {
        cwd: this.workingDir,
        settingSources: ['project'],
        model: this.model,
        maxTurns: this.maxTurns,
        permissionMode: this.permissionMode,
        ...this.parseClaudeOptions(),
        ...(this.systemPrompt && { systemPrompt: this.systemPrompt }),
        ...(this.mcpServers && { mcpServers: this.mcpServers }),
        ...(this.thinkingBudget > 0 && { maxThinkingTokens: this.thinkingBudget }),
      };

      // Add canUseTool callback if permission mode requires it
      if (this.permissionMode === 'default' || this.permissionMode === 'acceptEdits') {
        options.canUseTool = this.createCanUseTool(chatId);
      }

      // Add resume option if we have a session
      if (session.sessionId) {
        options.resume = session.sessionId;
      }

      // Execute the query with the message stream as prompt
      const response = query({ prompt: stream, options });

      // Process the stream
      for await (const message of response) {
        // Capture session ID from init message and update stream
        if (message.type === 'system') {
          const sysMsg = message as SDKSystemMessage;
          if (sysMsg.subtype === 'init' && sysMsg.session_id) {
            newSessionId = sysMsg.session_id;
            stream.setSessionId(sysMsg.session_id);
            this.logger.debug('Session ID captured from init', {
              chatId,
              sessionId: sysMsg.session_id,
            });
          }
        }

        this.processMessage(message, {
          onText: (text) => {
            resultText += text;
            if (callbacks?.onProgress) {
              callbacks.onProgress(text);
            }
          },
          onSessionId: (id) => {
            if (!newSessionId) {
              newSessionId = id;
              stream.setSessionId(id);
            }
          },
          onToolUse: (tool, input) => {
            if (!toolsUsed.includes(tool)) {
              toolsUsed.push(tool);
            }
            if (callbacks?.onToolUse) {
              callbacks.onToolUse(tool, input);
            }
          },
          onThinking: (thinking) => {
            if (callbacks?.onThinking) {
              callbacks.onThinking(thinking);
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

      // Truncate result for logging
      const truncatedResult = resultText.length > 300
        ? resultText.slice(0, 300) + '...[truncated]'
        : resultText;

      this.logger.info('Stream query completed', {
        chatId,
        sessionId: newSessionId || session.sessionId,
        resultLength: resultText.length,
        resultPreview: truncatedResult,
        toolsUsed,
        toolCount: toolsUsed.length,
        durationMs,
        costUsd,
        model: this.model,
      });

      return {
        text: resultText,
        sessionId: newSessionId || session.sessionId,
        toolsUsed,
        costUsd,
        durationMs,
      };
    } catch (error) {
      this.logger.error('Stream query failed', { chatId, error });
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
      onToolUse: (tool: string, input: Record<string, unknown>) => void;
      onThinking: (thinking: string) => void;
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
                // Pass tool name and input to the handler
                const toolInput = (block as { name: string; input: Record<string, unknown> }).input || {};
                handlers.onToolUse(block.name, toolInput);
              } else if (block.type === 'thinking') {
                // Pass thinking content to the handler
                const thinkingContent = (block as { thinking: string }).thinking || '';
                handlers.onThinking(thinkingContent);
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
