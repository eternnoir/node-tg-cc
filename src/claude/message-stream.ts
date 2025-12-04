import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * A controllable AsyncIterable that allows pushing messages dynamically.
 * Used to enable real-time message injection during Claude processing.
 *
 * This implements a "push-to-pull" adapter pattern:
 * - External code pushes messages via push()/pushText()
 * - The SDK pulls messages via AsyncIterator
 * - When no messages are available, the iterator waits via Promise
 */
export class MessageStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private pendingResolve: ((message: SDKUserMessage | null) => void) | null = null;
  private closed = false;
  private sessionId: string = '';

  /**
   * Set the session ID for subsequent messages.
   * Called after receiving the init message from Claude SDK.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Create an SDKUserMessage from a text prompt
   */
  createMessage(text: string): SDKUserMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: text,
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    };
  }

  /**
   * Push a new message into the stream.
   * If the iterator is waiting, it will immediately receive this message.
   * Otherwise, the message is queued.
   */
  push(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error('Cannot push to closed stream');
    }

    if (this.pendingResolve) {
      // Iterator is waiting, resolve immediately
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(message);
    } else {
      // Queue for later consumption
      this.queue.push(message);
    }
  }

  /**
   * Push a text message into the stream.
   * Convenience method that creates an SDKUserMessage from text.
   */
  pushText(text: string): void {
    this.push(this.createMessage(text));
  }

  /**
   * Close the stream, signaling no more messages will be sent.
   * The iterator will complete after all queued messages are consumed.
   */
  close(): void {
    this.closed = true;
    if (this.pendingResolve) {
      // Wake up waiting iterator with null to signal completion
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(null);
    }
  }

  /**
   * Check if the stream is closed
   */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Check if there are pending messages in the queue
   */
  hasPendingMessages(): boolean {
    return this.queue.length > 0;
  }

  /**
   * AsyncIterator implementation.
   * Yields messages from the queue, waiting when empty.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        // Have queued messages, yield immediately
        yield this.queue.shift()!;
      } else if (this.closed) {
        // No more messages and closed, complete iteration
        return;
      } else {
        // Wait for next message or close signal
        const message = await new Promise<SDKUserMessage | null>((resolve) => {
          this.pendingResolve = resolve;
        });

        if (message === null) {
          // Closed while waiting
          return;
        }

        yield message;
      }
    }
  }
}
