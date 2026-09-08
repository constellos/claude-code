/**
 * PostToolUse[Task] hook - Log task completion
 *
 * This hook runs when the Task tool completes (after the subagent finishes).
 * It logs the task completion for debugging and audit purposes.
 *
 * Note: For detailed file operations analysis, see the SubagentStop hooks
 * which have access to the full agent transcript.
 */

import type { PostToolUseInput, PostToolUseHookOutput } from '../types/types.js';
import { loadTaskCallContext } from './utils/task-state.js';
import { createDebugLogger } from './utils/debug.js';
import { runHook } from './utils/io.js';

async function handler(input: PostToolUseInput): Promise<PostToolUseHookOutput> {
  const DEBUG = process.env.DEBUG === '*' || process.env.DEBUG?.includes('task');

  // Only process Task tool calls
  if (input.tool_name !== 'Task') {
    return {};
  }

  if (DEBUG) {
    console.log('[PostToolUse:Task] Hook triggered');
    console.log('[PostToolUse:Task] Tool Use ID:', input.tool_use_id);
    console.log('[PostToolUse:Task] Session ID:', input.session_id);
  }

  const logger = createDebugLogger(input.cwd, 'log-task-result', true);

  try {
    // Load the saved context from PreToolUse
    const context = await loadTaskCallContext(input.tool_use_id, input.cwd);

    if (!context) {
      if (DEBUG) {
        console.log('[PostToolUse:Task] No saved context found for tool_use_id:', input.tool_use_id);
      }
      return {};
    }

    const toolResponse = input.tool_response;
    const responseText = typeof toolResponse === 'string'
      ? toolResponse
      : JSON.stringify(toolResponse).slice(0, 500);

    await logger.logOutput({
      tool_use_id: input.tool_use_id,
      agent_type: context.agentType,
      prompt: context.prompt.slice(0, 200),
      response: responseText.slice(0, 200),
      success: true,
    });

    if (DEBUG) {
      console.log('[PostToolUse:Task] Task completed');
      console.log('[PostToolUse:Task] Agent Type:', context.agentType);
      console.log('[PostToolUse:Task] Response:', responseText.slice(0, 100));
    }

    return {};
  } catch (error) {
    if (DEBUG) {
      console.error('[PostToolUse:Task] Error logging task result:', error);
    }
    await logger.logError(error as Error);
    return {};
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
