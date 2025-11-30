import { getLogger } from '../logger';

/**
 * Permission request pending resolution
 */
export interface PendingPermission {
  id: string;
  chatId: number;
  toolName: string;
  toolInput: Record<string, unknown>;
  resolve: (result: PermissionResponse) => void;
  createdAt: Date;
  timeoutId: NodeJS.Timeout;
}

/**
 * Permission response from user
 */
export interface PermissionResponse {
  allowed: boolean;
  alwaysAllow?: boolean;
  message?: string;
}

/**
 * Callback type for sending permission request to user
 */
export type PermissionRequestCallback = (
  chatId: number,
  permissionId: string,
  toolName: string,
  toolInput: Record<string, unknown>
) => Promise<void>;

/**
 * Permission manager for handling tool execution permissions
 */
export class PermissionManager {
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private alwaysAllowedTools: Map<number, Set<string>> = new Map();
  private logger = getLogger();
  private timeoutSeconds: number;
  private onPermissionRequest: PermissionRequestCallback | null = null;

  constructor(timeoutSeconds: number = 60) {
    this.timeoutSeconds = timeoutSeconds;
  }

  /**
   * Set the callback for sending permission requests
   */
  setPermissionRequestCallback(callback: PermissionRequestCallback): void {
    this.onPermissionRequest = callback;
  }

  /**
   * Generate a unique permission ID
   */
  private generatePermissionId(): string {
    return `perm_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Check if a tool is always allowed for a chat
   */
  isToolAlwaysAllowed(chatId: number, toolName: string): boolean {
    const allowedTools = this.alwaysAllowedTools.get(chatId);
    return allowedTools?.has(toolName) ?? false;
  }

  /**
   * Mark a tool as always allowed for a chat
   */
  setToolAlwaysAllowed(chatId: number, toolName: string): void {
    let allowedTools = this.alwaysAllowedTools.get(chatId);
    if (!allowedTools) {
      allowedTools = new Set();
      this.alwaysAllowedTools.set(chatId, allowedTools);
    }
    allowedTools.add(toolName);
    this.logger.info('Tool marked as always allowed', { chatId, toolName });
  }

  /**
   * Clear always allowed tools for a chat
   */
  clearAlwaysAllowed(chatId: number): void {
    this.alwaysAllowedTools.delete(chatId);
    this.logger.debug('Always allowed tools cleared', { chatId });
  }

  /**
   * Request permission for a tool execution
   */
  async requestPermission(
    chatId: number,
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<PermissionResponse> {
    // Check if tool is always allowed
    if (this.isToolAlwaysAllowed(chatId, toolName)) {
      this.logger.debug('Tool auto-allowed', { chatId, toolName });
      return { allowed: true };
    }

    // Check if we have a callback
    if (!this.onPermissionRequest) {
      this.logger.warn('No permission request callback set, auto-denying');
      return { allowed: false, message: 'Permission system not configured' };
    }

    const permissionId = this.generatePermissionId();

    return new Promise<PermissionResponse>((resolve) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.handleTimeout(permissionId);
      }, this.timeoutSeconds * 1000);

      // Store pending permission
      const pending: PendingPermission = {
        id: permissionId,
        chatId,
        toolName,
        toolInput,
        resolve,
        createdAt: new Date(),
        timeoutId,
      };

      this.pendingPermissions.set(permissionId, pending);

      this.logger.info('Permission requested', {
        permissionId,
        chatId,
        toolName,
      });

      // Send request to user
      this.onPermissionRequest!(chatId, permissionId, toolName, toolInput).catch(
        (error) => {
          this.logger.error('Failed to send permission request', { error });
          this.resolvePermission(permissionId, {
            allowed: false,
            message: 'Failed to send permission request',
          });
        }
      );
    });
  }

  /**
   * Handle permission response from user
   */
  resolvePermission(permissionId: string, response: PermissionResponse): boolean {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      this.logger.warn('Permission not found or already resolved', { permissionId });
      return false;
    }

    // Clear timeout
    clearTimeout(pending.timeoutId);

    // Remove from pending
    this.pendingPermissions.delete(permissionId);

    // If always allow, remember it
    if (response.allowed && response.alwaysAllow) {
      this.setToolAlwaysAllowed(pending.chatId, pending.toolName);
    }

    this.logger.info('Permission resolved', {
      permissionId,
      chatId: pending.chatId,
      toolName: pending.toolName,
      allowed: response.allowed,
      alwaysAllow: response.alwaysAllow,
    });

    // Resolve the promise
    pending.resolve(response);
    return true;
  }

  /**
   * Handle timeout
   */
  private handleTimeout(permissionId: string): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      return;
    }

    this.logger.info('Permission request timed out', {
      permissionId,
      chatId: pending.chatId,
      toolName: pending.toolName,
    });

    this.pendingPermissions.delete(permissionId);
    pending.resolve({
      allowed: false,
      message: `Permission request timed out after ${this.timeoutSeconds} seconds`,
    });
  }

  /**
   * Get pending permission by ID
   */
  getPendingPermission(permissionId: string): PendingPermission | undefined {
    return this.pendingPermissions.get(permissionId);
  }

  /**
   * Cancel all pending permissions for a chat
   */
  cancelPendingForChat(chatId: number): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.chatId === chatId) {
        clearTimeout(pending.timeoutId);
        this.pendingPermissions.delete(id);
        pending.resolve({
          allowed: false,
          message: 'Permission request cancelled',
        });
      }
    }
  }

  /**
   * Get all pending permissions count
   */
  getPendingCount(): number {
    return this.pendingPermissions.size;
  }
}
