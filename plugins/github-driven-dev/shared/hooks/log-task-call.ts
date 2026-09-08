/**
 * PreToolUse[Task] hook - Save task call context for later retrieval
 *
 * This hook runs when the Task tool is ABOUT to be called (before the subagent starts).
 * It saves the task's context (type, prompt, toolUseId) to .claude/logs/task-calls.json
 * so it can be retrieved later in PostToolUse[Task] or SubagentStop.
 *
 * Import this hook in any plugin that needs to track task execution.
 */

import type { PreToolUseInput, PreToolUseHookOutput } from '../types/types.js';
import { saveTaskCallContext } from './utils/task-state.js';
import { runHook } from './utils/io.js';

async function handler(input: PreToolUseInput): Promise<PreToolUseHookOutput> {
  const DEBUG = process.env.DEBUG === '*' || process.env.DEBUG?.includes('task');

  // Only process Task tool calls
  if (input.tool_name !== 'Task') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }

  if (DEBUG) {
    console.log('[PreToolUse:Task] Hook triggered');
    console.log('[PreToolUse:Task] Tool Use ID:', input.tool_use_id);
    console.log('[PreToolUse:Task] Session ID:', input.session_id);
  }

  try {
    const toolInput = input.tool_input as {
      subagent_type?: string;
      prompt?: string;
    };

    const agentType = toolInput?.subagent_type || 'unknown';
    const prompt = toolInput?.prompt || '';

    if (DEBUG) {
      console.log('[PreToolUse:Task] Agent Type:', agentType);
      console.log('[PreToolUse:Task] Prompt:', prompt.slice(0, 100) + (prompt.length > 100 ? '...' : ''));
    }

    const context = await saveTaskCallContext({
      tool_use_id: input.tool_use_id,
      agent_type: agentType,
      session_id: input.session_id,
      prompt,
      cwd: input.cwd,
    });

    if (DEBUG) {
      console.log('[PreToolUse:Task] Saved task call context');
      console.log('[PreToolUse:Task] Tool Use ID:', context.toolUseId);
      console.log('[PreToolUse:Task] Timestamp:', context.timestamp);
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  } catch (error) {
    if (DEBUG) {
      console.error('[PreToolUse:Task] Error saving task call context:', error);
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }
}

// Export handler for testing
export { handler };

// Make this file self-executable with tsx
runHook(handler);
