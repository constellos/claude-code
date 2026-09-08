/**
 * Debug utilities for Claude Code hooks
 *
 * Provides logging and error handling with debug mode support. Hook events
 * are logged in JSONL format to .claude/logs/hook-events.json for debugging
 * and troubleshooting hook execution.
 *
 * Each log entry is a single JSON object per line with timestamp, event name,
 * type (input/output/error), and the associated data.
 *
 * @module debug
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================================================
// Constants
// ============================================================================

const LOGS_DIR = '.claude/logs';
const HOOK_EVENTS_FILE = 'hook-events.json';

// ============================================================================
// Types
// ============================================================================

export interface DebugConfig {
  debug?: boolean;
}

export interface HookEventEntry {
  timestamp: string;
  event: string;
  type: 'input' | 'output' | 'error';
  data: unknown;
}

export interface DebugLogger {
  logInput: (input: unknown) => Promise<void>;
  logOutput: (output: unknown) => Promise<void>;
  logError: (error: Error) => Promise<void>;
}

// ============================================================================
// Debug Logging (JSONL append to hook-events.json)
// ============================================================================

/**
 * Append a hook event entry to hook-events.json (JSONL format)
 *
 * Writes a single-line JSON entry to the log file, creating the directory
 * structure if it doesn't exist. Failures are silently ignored to prevent
 * logging errors from breaking hook execution.
 *
 * @param cwd - The working directory where .claude/logs/ should be created
 * @param entry - The hook event entry to append to the log file
 * @returns Promise that resolves when the entry is written (or fails silently)
 *
 * @example
 * ```typescript
 * await appendHookEvent('/path/to/project', {
 *   timestamp: new Date().toISOString(),
 *   event: 'SessionStart',
 *   type: 'input',
 *   data: { cwd: '/path/to/project' }
 * });
 * ```
 */
async function appendHookEvent(cwd: string, entry: HookEventEntry): Promise<void> {
  const logDir = path.join(cwd, LOGS_DIR);
  const logFile = path.join(logDir, HOOK_EVENTS_FILE);

  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logFile, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Silently fail - don't break hook execution for logging
  }
}

/**
 * Create a debug logger for a hook execution
 *
 * Returns a logger object with methods for logging hook inputs, outputs, and errors
 * to .claude/logs/hook-events.json in JSONL format. Logging only occurs when debug
 * mode is enabled.
 *
 * @param cwd - The working directory where logs should be written
 * @param hookEventName - The name of the hook event (e.g., 'SessionStart', 'PostToolUse')
 * @param debug - Whether debug logging is enabled
 * @returns A DebugLogger with logInput, logOutput, and logError methods
 *
 * @example
 * ```typescript
 * import { createDebugLogger } from './debug.js';
 *
 * const logger = createDebugLogger('/path/to/project', 'SessionStart', true);
 *
 * await logger.logInput({ cwd: '/path/to/project', source: 'startup' });
 * await logger.logOutput({ success: true, message: 'Hook completed' });
 * ```
 */
export function createDebugLogger(
  cwd: string,
  hookEventName: string,
  _debug: boolean
): DebugLogger {
  return {
    logInput: async (input: unknown) => {
      // Always log hook events regardless of debug flag
      await appendHookEvent(cwd, {
        timestamp: new Date().toISOString(),
        event: hookEventName,
        type: 'input',
        data: input,
      });
    },

    logOutput: async (output: unknown) => {
      // Always log hook events regardless of debug flag
      await appendHookEvent(cwd, {
        timestamp: new Date().toISOString(),
        event: hookEventName,
        type: 'output',
        data: output,
      });
    },

    logError: async (error: Error) => {
      // Always log hook events regardless of debug flag
      await appendHookEvent(cwd, {
        timestamp: new Date().toISOString(),
        event: hookEventName,
        type: 'error',
        data: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
    },
  };
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Create a blocking error response for hooks
 *
 * Generates an appropriate error response object that blocks execution when
 * a hook error occurs in debug mode. The response format varies by hook event
 * type to match the expected output schema.
 *
 * @param hookEventName - The name of the hook event that errored
 * @param error - The error that occurred during hook execution
 * @returns A hook output object configured to block/deny with error details
 *
 * @example
 * ```typescript
 * import { createBlockingErrorResponse } from './debug.js';
 *
 * try {
 *   // Hook logic that might throw
 * } catch (error) {
 *   return createBlockingErrorResponse('PreToolUse', error as Error);
 *   // Returns: { hookSpecificOutput: { permissionDecision: 'deny', ... } }
 * }
 * ```
 */
export function createBlockingErrorResponse(
  hookEventName: string,
  error: Error
): Record<string, unknown> {
  const baseResponse = {
    continue: false,
    stopReason: `Hook error: ${error.message}`,
    systemMessage: `Hook ${hookEventName} failed: ${error.message}`,
  };

  // Add hook-specific output based on event type
  switch (hookEventName) {
    case 'PreToolUse':
      return {
        ...baseResponse,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Hook error: ${error.message}`,
        },
      };

    case 'PostToolUse':
      return {
        ...baseResponse,
        decision: 'block',
        reason: `Hook error: ${error.message}`,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `Hook error: ${error.message}\n${error.stack || ''}`,
        },
      };

    case 'SubagentStop':
      return {
        ...baseResponse,
        decision: 'block',
        reason: `Hook error: ${error.message}`,
      };

    case 'UserPromptSubmit':
      return {
        ...baseResponse,
        decision: 'block',
        reason: `Hook error: ${error.message}`,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `Hook error: ${error.message}`,
        },
      };

    case 'Stop':
      return {
        ...baseResponse,
        decision: 'block',
        reason: `Hook error: ${error.message}`,
      };

    default:
      return baseResponse;
  }
}

/**
 * Create a pass-through response for hooks
 *
 * Generates an appropriate response object that allows execution to continue
 * when a hook error occurs and debug mode is disabled. The response format
 * varies by hook event type to match the expected output schema while permitting
 * normal Claude Code operation.
 *
 * @param hookEventName - The name of the hook event
 * @returns A hook output object configured to allow/pass-through
 *
 * @example
 * ```typescript
 * import { createPassthroughResponse } from './debug.js';
 *
 * try {
 *   // Hook logic that might throw
 * } catch (error) {
 *   if (!debugMode) {
 *     return createPassthroughResponse('PreToolUse');
 *     // Returns: { hookSpecificOutput: { permissionDecision: 'allow' } }
 *   }
 * }
 * ```
 */
export function createPassthroughResponse(hookEventName: string): Record<string, unknown> {
  switch (hookEventName) {
    case 'PreToolUse':
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };

    case 'PostToolUse':
      return {};

    case 'SessionStart':
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '',
        },
      };

    case 'SubagentStart':
      return {};

    case 'SubagentStop':
      return {};

    default:
      return {};
  }
}
