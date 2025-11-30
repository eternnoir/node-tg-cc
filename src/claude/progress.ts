import { query } from '@anthropic-ai/claude-agent-sdk';
import { getLogger } from '../logger';

const DEFAULT_SYSTEM_PROMPT = `You are a progress description generator. Generate a brief one-line description based on the context.

Rules:
- Maximum 30 characters
- No punctuation at the end
- Only output the description text, nothing else
- Use present continuous tense (e.g., "Reading file...", "Searching code...")
- Respond in the same language as the user's input`;

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
   * Generate initial processing message based on user's language
   */
  async getInitialMessage(userMessage: string): Promise<string> {
    if (!this.enabled) {
      return 'Processing...';
    }

    try {
      const prompt = `User message: "${userMessage.slice(0, 100)}"\n\nGenerate a "processing" status message.`;

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

      return resultText.trim() || 'Processing...';
    } catch (error) {
      this.logger.warn('Failed to generate initial message', { error });
      return 'Processing...';
    }
  }

  /**
   * Generate a human-friendly description of what the tool is doing
   */
  async describe(toolName: string, toolInput: Record<string, unknown>): Promise<string> {
    if (!this.enabled) {
      return `Running ${toolName}...`;
    }

    try {
      // Build a simple JSON representation of the tool call
      const inputStr = JSON.stringify(toolInput, null, 0).slice(0, 300);
      const prompt = `Tool: ${toolName}\nInput: ${inputStr}`;

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

      return resultText.trim() || `Running ${toolName}...`;
    } catch (error) {
      this.logger.warn('Failed to generate progress description', { error, toolName });
      return `Running ${toolName}...`;
    }
  }
}
