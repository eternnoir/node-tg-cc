import { query } from '@anthropic-ai/claude-agent-sdk';
import { getLogger } from '../logger';

const DEFAULT_SYSTEM_PROMPT = `You are a progress description generator. Based on tool execution information, generate a brief one-line description of what is being done.

Rules:
- Maximum 30 characters
- No punctuation at the end
- Only output the description text, nothing else
- Use present continuous tense (e.g., "Reading file...", "Searching code...")
- Respond in the same language as the user's input context`;

/**
 * Service for generating human-friendly progress descriptions using Claude Haiku
 */
export class ProgressDescriber {
  private logger = getLogger();
  private enabled: boolean;
  private systemPrompt: string;

  constructor(enabled: boolean = true, customSystemPrompt?: string) {
    this.enabled = enabled;
    this.systemPrompt = customSystemPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  /**
   * Generate a human-friendly description of what the tool is doing
   */
  async describe(toolName: string, toolInput: Record<string, unknown>): Promise<string> {
    if (!this.enabled) {
      return this.getFallbackDescription(toolName, toolInput);
    }

    try {
      const inputSummary = this.summarizeInput(toolName, toolInput);
      const prompt = `工具名稱：${toolName}\n${inputSummary}`;

      let resultText = '';

      const response = query({
        prompt,
        options: {
          model: 'haiku',
          maxTurns: 1,
          systemPrompt: this.systemPrompt,
          permissionMode: 'bypassPermissions',
        },
      });

      for await (const message of response) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              resultText += block.text;
            }
          }
        }
      }

      return resultText.trim() || this.getFallbackDescription(toolName, toolInput);
    } catch (error) {
      this.logger.warn('Failed to generate progress description', { error, toolName });
      return this.getFallbackDescription(toolName, toolInput);
    }
  }

  /**
   * Summarize tool input for the prompt
   */
  private summarizeInput(toolName: string, input: Record<string, unknown>): string {
    const lines: string[] = [];

    switch (toolName) {
      case 'Bash':
        if (input.command) {
          const cmd = String(input.command);
          lines.push(`指令：${cmd.slice(0, 150)}${cmd.length > 150 ? '...' : ''}`);
        }
        if (input.description) {
          lines.push(`說明：${input.description}`);
        }
        break;

      case 'Read':
      case 'FileRead':
        if (input.file_path) {
          lines.push(`檔案：${input.file_path}`);
        }
        break;

      case 'Write':
      case 'FileWrite':
        if (input.file_path) {
          lines.push(`檔案：${input.file_path}`);
        }
        break;

      case 'Edit':
      case 'FileEdit':
        if (input.file_path) {
          lines.push(`檔案：${input.file_path}`);
        }
        break;

      case 'Glob':
        if (input.pattern) {
          lines.push(`模式：${input.pattern}`);
        }
        break;

      case 'Grep':
        if (input.pattern) {
          lines.push(`搜尋：${input.pattern}`);
        }
        if (input.path) {
          lines.push(`路徑：${input.path}`);
        }
        break;

      case 'WebFetch':
        if (input.url) {
          lines.push(`網址：${input.url}`);
        }
        break;

      case 'WebSearch':
        if (input.query) {
          lines.push(`查詢：${input.query}`);
        }
        break;

      case 'Task':
        if (input.description) {
          lines.push(`任務：${input.description}`);
        }
        break;

      default:
        // Generic summary for unknown tools
        const keys = Object.keys(input).slice(0, 2);
        for (const key of keys) {
          const value = String(input[key]).slice(0, 100);
          lines.push(`${key}：${value}`);
        }
    }

    return lines.join('\n') || '（無參數）';
  }

  /**
   * Get a fallback description when Haiku call fails or is disabled
   */
  private getFallbackDescription(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash':
        return `正在執行指令`;
      case 'Read':
      case 'FileRead':
        return `正在讀取檔案`;
      case 'Write':
      case 'FileWrite':
        return `正在寫入檔案`;
      case 'Edit':
      case 'FileEdit':
        return `正在編輯檔案`;
      case 'Glob':
        return `正在搜尋檔案`;
      case 'Grep':
        return `正在搜尋內容`;
      case 'WebFetch':
        return `正在抓取網頁`;
      case 'WebSearch':
        return `正在搜尋網路`;
      case 'Task':
        return `正在執行子任務`;
      case 'TodoWrite':
        return `正在更新任務清單`;
      default:
        return `正在執行 ${toolName}`;
    }
  }
}
